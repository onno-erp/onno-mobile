import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Appearance,
  AppState,
  BackHandler,
  Dimensions,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from 'react-native-svg';
import { OnnoAuthError, OnnoClient } from './src/api/onnoClient';
import { subscribeUiEvents, affectsSurface, publishUiEvent } from './src/api/events';
import { toast, Toaster } from './src/ui/toast';
import { confirm, ConfirmHost } from './src/ui/dialog';
import { ContextMenuHost } from './src/ui/contextMenu';
import {
  getLastServer,
  loadServers,
  rememberServer,
  removeServer,
  type ServerEntry,
} from './src/api/servers';
import { getLastRoute, getStoredThemePref, setLastRoute, setStoredThemePref, type ThemePref } from './src/api/prefs';
import { clearCredentials, getCredentials } from './src/api/credentials';
import { ConnectScreen } from './src/ConnectScreen';
import { LoginScreen } from './src/LoginScreen';
import { DivCard } from './src/divkit';
import type { DivCardEnvelope } from './src/divkit';
import { colors, setBrand } from './src/divkit/theme';
import { SwipeBackArea } from './src/nav/SwipeBackArea';

type Status = 'connecting' | 'ready' | 'error' | 'login';
type Shell = Awaited<ReturnType<OnnoClient['shell']>>;

// An iPad (or a large-screen Android tablet) reports the `tablet` viewport, so the
// server returns its tablet layout: 2-column dashboards/content, an extra nav
// section, and a *compact* nav pill the host hugs into the bottom-right corner
// (see IS_TABLET in the nav bar below). Phones get `mobile` — 1-column content and
// the full-width bottom bar. Decided once at launch off the device's shortest side
// so it doesn't flip between tablet/mobile when an iPad rotates.
const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
const IS_TABLET = (Platform.OS === 'ios' && Platform.isPad) || Math.min(SCREEN_W, SCREEN_H) >= 600;
const VIEWPORT = IS_TABLET ? 'tablet' : 'mobile';
const NAV_RESERVE = 88; // height the floating bottom bar occupies
const NAV_BOTTOM_CLEARANCE = 8; // small gap above the home indicator (the pill draws its own 12px margin on top)
const TOP_FADE = 28; // length of the dissolve tail just below the safe area

// Map a nav action url to the content path it loads, or null for side-effect
// actions (logout / theme / post / open / SSO …) that shouldn't be prefetched.
// Mirrors the routing in onAction — anything that isn't a plain navigation.
function navPathFor(url: string): string | null {
  if (!url.startsWith('onno://')) return null;
  const rest = url.slice('onno://'.length);
  if (
    rest === 'logout' ||
    rest === 'theme/toggle' ||
    rest.startsWith('auth/sso/') ||
    rest.startsWith('app') ||
    rest.startsWith('delete/') ||
    rest.startsWith('action/') ||
    rest.startsWith('post/') ||
    rest.startsWith('unpost/') ||
    rest.startsWith('open/') ||
    rest.startsWith('redirect/') ||
    rest.startsWith('download/')
  ) {
    return null;
  }
  return ('/' + rest).replace('//', '/');
}

export default function App() {
  const insets = useSafeAreaInsets();
  // One client per server; recreated on switch (the CSRF/session state it holds
  // is server-specific). `serverUrl === null` means "show the picker".
  const clientRef = useRef<OnnoClient | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [booting, setBooting] = useState(true);

  // Theme is a *preference* (system/light/dark); the effective light/dark value is
  // derived. `system` follows the OS via useColorScheme, so flipping the phone's
  // appearance flips the app live (the theme-change effect below re-fetches).
  const [themePref, setThemePref] = useState<ThemePref>('system');
  const systemScheme = useColorScheme();
  const theme: 'light' | 'dark' = themePref === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : themePref;
  const [profile, setProfile] = useState<string | undefined>(undefined);
  const [shell, setShell] = useState<Shell | null>(null);
  const [route, setRoute] = useState('/');
  const [content, setContent] = useState<DivCardEnvelope | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  // The server-driven login screen card (GET /api/divkit/login) — password form
  // and/or SSO buttons, whatever this server offers. Null → the server has no
  // such endpoint, so we fall back to the native password form.
  const [loginCard, setLoginCard] = useState<DivCardEnvelope | null>(null);
  // True once this server has an authenticated session — gates the live SSE stream
  // (only opened while signed in; torn down on logout / server switch).
  const [authed, setAuthed] = useState(false);
  // Measured height of the floating bottom nav, so toasts sit just above it. The
  // scroll reserve (NAV_RESERVE) is deliberately generous and double-counts the
  // safe-area inset, so it's the wrong number for positioning the toast stack.
  const [navHeight, setNavHeight] = useState(0);
  // Suspends content scrolling while a child owns a pan gesture (maps), since RN's
  // ScrollView won't otherwise yield to a JS PanResponder nested inside it.
  const [scrollLocked, setScrollLocked] = useState(false);
  // Linear back stack of routes we've navigated through (the route we *leave* is
  // pushed on each forward navigation). Drives the swipe-back gesture and the
  // Android hardware back button; reset on server switch / sign-out. The ref mirror
  // lets goBack/the BackHandler read the latest stack without re-binding.
  const [history, setHistory] = useState<string[]>([]);
  const historyRef = useRef(history);
  historyRef.current = history;

  // The SSE handler must reload the *current* surface with the *current* theme/profile
  // without re-subscribing on every navigation. These refs always hold the latest.
  const routeRef = useRef(route);
  routeRef.current = route;
  const reloadRef = useRef<() => void>(() => {});
  // Monotonic id so a slow background revalidation can't clobber a newer navigation.
  const reqSeq = useRef(0);

  // Drives the top fade: hidden at rest (offset 0), fading in once content starts
  // scrolling behind the safe area so it dissolves there rather than hard-clipping.
  const scrollY = useRef(new Animated.Value(0)).current;
  const topFadeOpacity = useMemo(
    () => scrollY.interpolate({ inputRange: [0, 12], outputRange: [0, 1], extrapolate: 'clamp' }),
    [scrollY],
  );

  async function loadShell(th: 'light' | 'dark' = theme) {
    const client = clientRef.current;
    if (!client) return null;
    try {
      const sh = await client.shell({ viewport: VIEWPORT, theme: th, profile });
      setShell(sh);
      return sh;
    } catch {
      return null; // nav is non-fatal; content still shows
    }
  }

  // Apply the server's brand palette (vetovet green, etc.) to the RN-drawn customs.
  // Awaited before the first content render so accents paint branded, with no blue→brand flash.
  async function loadBranding() {
    const client = clientRef.current;
    if (!client) return;
    try {
      const b = await client.branding();
      setBrand(b?.palette ?? null);
    } catch {
      setBrand(null); // fall back to the default palette
    }
  }

  // Enter the app after auth: apply branding, then open the route to land on. We restore the
  // last route saved for this server (so a relaunch after iOS killed the backgrounded app
  // returns you to where you were), falling back to the server's configured home, then '/'.
  // With a saved route, shell + content load together (fast); only a first-ever connect waits
  // on the shell to learn `home`.
  async function enterApp(th: 'light' | 'dark' = theme) {
    const client = clientRef.current;
    if (!client) return;
    await loadBranding();
    const saved = await getLastRoute(client.baseUrl);
    if (saved) {
      await Promise.all([loadShell(th), loadContent(saved, th)]);
    } else {
      const sh = await loadShell(th);
      await loadContent(sh?.home || '/', th);
    }
  }

  async function loadContent(
    path: string,
    th: 'light' | 'dark' = theme,
    opts: { force?: boolean; back?: boolean } = {},
  ) {
    const client = clientRef.current;
    if (!client) return;
    const myId = ++reqSeq.current;
    const o = { viewport: VIEWPORT, theme: th, profile };
    const navigating = path !== routeRef.current; // moving to a *different* screen
    // Record the route we're leaving on the back stack — but only for genuine
    // forward navigation: skip the initial load (nothing on screen yet), same-route
    // refreshes/theme changes, and the back-nav itself (it already popped). Navigating
    // straight to where "back" would land collapses the stack instead of growing it
    // (so tab ping-pong A→B→A doesn't pile up).
    if (navigating && !opts.back && content != null) {
      const from = routeRef.current;
      setHistory((h) =>
        h.length && h[h.length - 1] === path ? h.slice(0, -1) : [...h, from].slice(-50),
      );
    }
    setRoute(path);
    setError('');
    setLastRoute(client.baseUrl, path).catch(() => {}); // remember the page for cold-start restore

    // Native feel: if we've shown this screen before, paint the cached card
    // instantly and revalidate silently; otherwise show the connecting state.
    const cached = client.peekContent(path, o) as DivCardEnvelope | undefined;
    if (cached) {
      setContent(cached);
      setStatus('ready');
      // Recently fetched and not a forced refresh → trust the cache and skip the
      // revalidation. This is what stops a cached revisit from re-fetching and
      // re-rendering the whole tree (the "cached is slower than cold" problem).
      if (!opts.force && client.freshContent(path, o)) return;
    } else {
      // Cold screen: drop the previous screen so the new one shows its loading
      // state immediately. Otherwise the old screen stays on-screen until the
      // fetch lands — which reads as "the nav tap did nothing, then it jumps".
      // (A same-route refresh keeps its content; only navigation blanks.)
      if (navigating) setContent(null);
      setStatus('connecting');
    }
    try {
      const env = (await client.content(path, o)) as DivCardEnvelope;
      if (reqSeq.current === myId) {
        setContent(env);
        setStatus('ready');
      }
    } catch (e: any) {
      // Keep the cached screen on a background-refresh failure; only surface an
      // error on a cold miss (nothing to show).
      if (reqSeq.current === myId && !cached) {
        setError(String(e?.message ?? e));
        setStatus('error');
      }
    }
  }

  // Always reload the live surface with the latest theme/profile/route (read off refs),
  // so the SSE subscription can refresh without being re-created on each navigation.
  reloadRef.current = () => loadContent(routeRef.current, theme, { force: true });

  // Pop the back stack and load the previous route. Used by the swipe-back gesture
  // and the Android hardware back button. The previous route is cached (we just came
  // from it), so it paints instantly. Returns true when it handled a back — the
  // BackHandler uses that to decide whether to let the OS exit the app.
  function goBack(): boolean {
    const hist = historyRef.current;
    if (!hist.length) return false;
    const prev = hist[hist.length - 1];
    setHistory((h) => h.slice(0, -1));
    Haptics.selectionAsync().catch(() => {});
    loadContent(prev, theme, { back: true });
    return true;
  }
  const goBackRef = useRef(goBack);
  goBackRef.current = goBack;

  // The shareable web URL an `onno://…` navigation maps to, for the long-press
  // "Copy link / Open in browser" menu (the mobile stand-in for right-clicking a
  // link). Side-effect actions (logout/theme/post/delete/…) aren't links → null,
  // so they get no menu. Reuses navPathFor, the same map the prefetcher uses.
  function linkFor(url: string): string | null {
    const path = navPathFor(url);
    if (!path || !serverUrl) return null;
    return `${serverUrl.replace(/\/$/, '')}${path}`;
  }

  // Touch-down prefetch: warm a nav destination's card the instant a finger lands,
  // so it's usually cached by the time the tap completes. Best-effort and idempotent
  // (skips anything already fresh); a no-op for non-navigation action urls.
  function prefetchContent(url: string) {
    const client = clientRef.current;
    if (!client) return;
    const path = navPathFor(url);
    if (!path) return;
    const o = { viewport: VIEWPORT, theme, profile };
    if (client.freshContent(path, o)) return;
    client.content(path, o).catch(() => {});
  }

  // `th` is passed explicitly so the first fetch can use a just-restored theme
  // before the `theme` state update has applied (same reason theme/toggle does).
  async function connect(th: 'light' | 'dark' = theme) {
    const client = clientRef.current;
    if (!client) return;
    setStatus('connecting');
    try {
      let authedNow = (await client.me()).authenticated;
      // No live session (the JSESSIONID cookie doesn't survive a relaunch on iOS),
      // but we may have this server's credentials saved — replay them silently so
      // a returning user skips the login screen.
      if (!authedNow) {
        const creds = await getCredentials(client.baseUrl);
        if (creds) {
          try {
            await client.login(creds.username, creds.password);
            authedNow = true;
          } catch (e) {
            // Only forget the credentials when the server says they're WRONG (401).
            // A 403 (CSRF) or any other failure is usually transient — on localhost the
            // two servers share one cookie jar (cookies ignore the port), so switching
            // clobbers the other's session/CSRF cookie and the first replay can 403.
            // Wiping creds there would force a manual login on every switch; instead we
            // keep them and just show the login screen so the next attempt can succeed.
            const status = e instanceof OnnoAuthError ? e.status : undefined;
            if (status === 401) await clearCredentials(client.baseUrl);
          }
        }
      }
      if (!authedNow) {
        // Show the server-driven login screen — the password form and/or SSO
        // buttons this server offers, exactly like the web. Fall back to the
        // native password form only if the server has no /api/divkit/login.
        try {
          setLoginCard((await client.loginCard({ theme: th })) as DivCardEnvelope);
        } catch {
          setLoginCard(null);
        }
        setStatus('login');
        return;
      }
      setAuthed(true); // session live → open the SSE stream
      await enterApp(th);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStatus('error');
    }
  }

  // Submit credentials from the login screen. Throws on bad creds so the screen
  // can show the message inline; on success, loads the shell + dashboard.
  async function signIn(username: string, password: string) {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected to a server.');
    await client.login(username, password); // the client persists the credentials
    setAuthed(true); // session live → open the SSE stream
    await enterApp(theme);
  }

  // Re-check the session, used when the app returns to the foreground while the
  // login screen is up — a tapped SSO button sends the user to the IdP in the
  // system browser, and the round-trip authenticates us out of band. If we're now
  // signed in, drop into the app; otherwise stay put.
  async function recheckSession() {
    const client = clientRef.current;
    if (!client) return;
    try {
      if (!(await client.me()).authenticated) return;
      setAuthed(true);
      setStatus('connecting');
      await enterApp(theme);
    } catch {
      /* still signed out — stay on the login screen */
    }
  }

  // Point the app at a server: spin up a fresh client, reset per-server state,
  // leave the picker, persist it as last-used, then connect.
  function connectTo(url: string, th: 'light' | 'dark' = theme) {
    clientRef.current = new OnnoClient(url);
    setProfile(undefined);
    setShell(null);
    setContent(null);
    setRoute('/');
    setStatus('connecting');
    setError('');
    setAuthed(false);
    setLoginCard(null); // belongs to the previous server; connect() refetches it
    setHistory([]); // the back stack is per-server
    setServerUrl(url);
    setBooting(false);
    rememberServer(url).then(setServers).catch(() => {});
    connect(th);
  }

  // Drop back to the server picker (used by logout and "Change server").
  function showPicker() {
    clientRef.current = null;
    setServerUrl(null);
    setContent(null);
    setShell(null);
    setError('');
    setAuthed(false);
    setLoginCard(null);
    setHistory([]);
    loadServers().then(setServers).catch(() => {});
  }

  // Startup: restore the saved theme preference, then auto-connect to the last-used
  // server (or open the picker). The *resolved* light/dark value is threaded into
  // connect so the first shell/content fetch is already themed — no light→dark reflow.
  useEffect(() => {
    (async () => {
      const pref = (await getStoredThemePref()) ?? 'system';
      setThemePref(pref);
      const resolved: 'light' | 'dark' =
        pref === 'system' ? (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light') : pref;
      const list = await loadServers();
      setServers(list);
      const last = await getLastServer();
      if (last) connectTo(last, resolved);
      else setBooting(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch the themed surfaces whenever the *effective* theme changes — whether
  // from the in-app toggle, the appearance control on the picker, or (when the
  // preference is `system`) the OS flipping light/dark while the app is open. Guarded
  // so it never fires on the picker/login (no shell yet) or on the initial paint.
  const themeRef = useRef(theme);
  useEffect(() => {
    if (themeRef.current === theme) return;
    themeRef.current = theme;
    if (!serverUrl || !shell) return;
    loadShell(theme);
    loadContent(routeRef.current, theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Reset the tracked scroll offset on navigation so the fade returns to hidden
  // for the next page instead of staying stuck visible from the previous scroll.
  useEffect(() => {
    scrollY.setValue(0);
  }, [route, scrollY]);

  // Android hardware back button mirrors the swipe-back gesture: pop our stack if we
  // can, otherwise let the OS handle it (background the app). Reads the latest goBack
  // off a ref so it stays bound once. No-op on iOS (the event never fires there).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => goBackRef.current());
    return () => sub.remove();
  }, []);

  // While the login screen is up, re-check the session whenever the app comes back
  // to the foreground — that's how an SSO round-trip (the user taps a provider
  // button, authenticates in the system browser, returns) drops them into the app.
  useEffect(() => {
    if (status !== 'login') return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') recheckSession();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ----- live updates over SSE (mirrors the web's useUiEvents) -----
  // While signed in, hold one stream to `/api/events`. When an event touches the
  // surface we're showing, reload it (debounced — a post emits several events at
  // once). Re-subscribes only on server switch / sign-in, not on navigation.
  useEffect(() => {
    if (!serverUrl || !authed) return;
    // eslint-disable-next-line no-console
    console.log('[sse] subscribing (route', routeRef.current + ')');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeUiEvents(serverUrl, (event) => {
      // Fan out to data-driven customs (onno-list, onno-widget) so they refetch their
      // own rows — reloading the content card alone doesn't, since they load on mount.
      publishUiEvent(event);
      // Server-rendered surfaces (detail fields, register reports) live in the card, so
      // reload it when the event touches the route we're on.
      const matched = affectsSurface(event, routeRef.current);
      // eslint-disable-next-line no-console
      console.log('[sse] handler route=' + routeRef.current, 'matched=' + matched, event.type, event.entityType ?? '', event.entityName ?? '');
      if (!matched) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => reloadRef.current(), 150);
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [serverUrl, authed]);

  // ----- onno:// action routing (mirrors the Flutter HomeShell) -----
  function onAction(url: string) {
    if (!url.startsWith('onno://')) return;
    const rest = url.slice('onno://'.length);

    if (rest === 'logout') {
      // Log out, then drop back to the server picker so the user can choose
      // (or re-pick) a server rather than silently re-logging into this one. The
      // client also forgets the saved credentials, so the next connect lands on
      // the login screen instead of auto signing back in.
      Promise.resolve(clientRef.current?.logout()).finally(showPicker);
      return;
    }
    if (rest.startsWith('auth/sso/')) {
      // An SSO provider button on the server-driven login card. Mirror the web:
      // redirect to the `?to=` target when it's a same-origin path, else the OIDC
      // `/oauth2/authorization/{id}` convention. We open it in the system browser;
      // on return, the foreground re-check (see the AppState effect) signs us in.
      const tail = rest.slice('auth/sso/'.length);
      const q = tail.indexOf('?');
      const id = q >= 0 ? tail.slice(0, q) : tail;
      const to = q >= 0 ? new URLSearchParams(tail.slice(q + 1)).get('to') : null;
      const path = to && to.startsWith('/') ? to : id ? `/oauth2/authorization/${id}` : null;
      if (path) {
        const href = `${serverUrl?.replace(/\/$/, '')}${path}`;
        Linking.openURL(href).catch(() => toast.error("Couldn't open the sign-in page"));
      }
      return;
    }
    if (rest === 'theme/toggle') {
      const next = theme === 'light' ? 'dark' : 'light';
      setThemePref(next); // an explicit pick, so it stops following the system from here
      setStoredThemePref(next); // remember it across launches, like the web
      return; // the theme-change effect refetches the shell + content
    }
    if (rest.startsWith('app')) {
      const q = rest.indexOf('?');
      const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');
      setProfile(params.get('profile') ?? undefined);
      // The onno-login-form custom fires `onno://app` after a successful sign-in
      // on the server-driven card, so this is also the "login succeeded" path —
      // mark the session live (opens the SSE stream). A no-op when already authed
      // (a plain profile switch).
      setAuthed(true);
      setTimeout(() => {
        loadShell();
        loadContent('/');
      }, 0);
      return;
    }
    if (rest.startsWith('delete/')) {
      const p = rest.split('/'); // delete/{kind}/{name}/{id}
      if (p.length >= 4) confirmDelete(p[1], p[2], p[3]);
      return;
    }
    if (rest.startsWith('action/')) {
      // action/{kind}/{name}/{key}/{id} — a custom server action. POST it (errors
      // self-toast), surface the result message, then navigate or refresh in place.
      const [kind, name, key, id] = rest.slice('action/'.length).split('/');
      if (kind && name && key) runServerAction(kind, name, key, id);
      return;
    }
    if (rest.startsWith('post/') || rest.startsWith('unpost/')) {
      // post/{name}/{id} | unpost/{name}/{id} — drive the document's posting state.
      const unpost = rest.startsWith('unpost/');
      const [name, id] = rest.slice((unpost ? 'unpost/' : 'post/').length).split('/');
      if (name && id) togglePosting(unpost, name, id);
      return;
    }
    if (rest.startsWith('open/') || rest.startsWith('redirect/') || rest.startsWith('download/')) {
      // A stored file / external URL — hand off to the OS browser. Re-root an
      // app-relative path against the current server; pass an absolute URL verbatim.
      const prefix = rest.startsWith('open/') ? 'open/' : rest.startsWith('redirect/') ? 'redirect/' : 'download/';
      const target = rest.slice(prefix.length);
      const href = /^https?:\/\//i.test(target) ? target : `${serverUrl?.replace(/\/$/, '')}/${target.replace(/^\//, '')}`;
      Linking.openURL(href).catch(() => toast.error("Couldn't open the link"));
      return;
    }
    loadContent(('/' + rest).replace('//', '/'));
  }

  // Run a custom EntityView action and apply its ActionResult. A loading toast gives
  // feedback while a slow/async handler runs; on success show its message, then either
  // navigate (if it asked) or reload the current surface so the change shows immediately.
  async function runServerAction(kind: string, name: string, key: string, id?: string) {
    const loadingId = toast.loading('Working…');
    try {
      const result = await clientRef.current!.runAction(kind, name, key, { id });
      toast.dismiss(loadingId);
      if (result.message) toast.success(result.message);
      if (result.navigate) onAction(result.navigate);
      else loadContent(routeRef.current);
    } catch {
      toast.dismiss(loadingId); // the client already toasted the failure
    }
  }

  // Post / unpost a document, then refresh the detail surface (the SSE stream also
  // nudges it, but reloading here makes it instant and works even if SSE is down).
  async function togglePosting(unpost: boolean, name: string, id: string) {
    try {
      if (unpost) await clientRef.current!.unpostDocument(name, id);
      else await clientRef.current!.postDocument(name, id);
      toast.success(unpost ? 'Document unposted' : 'Document posted');
      loadContent(routeRef.current);
    } catch {
      /* the client already toasted the failure */
    }
  }

  // Bottom-bar taps route through here so switching tabs gives a selection
  // haptic. Only a real tab change buzzes — re-tapping the active tab, or the
  // non-navigation actions (theme/profile/logout/delete), stay silent. In-content
  // navigation uses onAction directly and never buzzes.
  function fireNav(url: string) {
    if (url.startsWith('onno://')) {
      const rest = url.slice('onno://'.length); // '' is the Home tab (route '/')
      const navigates = !/^(logout|theme\/|app|delete\/|action\/|post\/|unpost\/|open\/|redirect\/|download\/)/.test(rest);
      const target = ('/' + rest).replace('//', '/');
      if (navigates && target !== route) Haptics.selectionAsync().catch(() => {});
    }
    onAction(url);
  }

  async function confirmDelete(kind: string, name: string, id: string) {
    const ok = await confirm({
      title: 'Delete record?',
      message: 'This marks the record for deletion. This can’t be undone here.',
      confirmLabel: 'Delete',
      destructive: true,
      icon: 'trash-2',
    });
    if (!ok) return;
    try {
      await clientRef.current?.deleteEntity(kind, name, id);
      loadContent(`/${kind}/${name}`); // back to the list (the failure self-toasts)
    } catch {
      /* the client already toasted the failure */
    }
  }

  const navVars = { active_path: route };
  const hasBottomBar = shell?.navStyle === 'bottom_bar' && !!shell?.nav;
  const c = colors(theme);

  // The server spaces some content roots itself — via paddings (dashboard,
  // settings) or margins (menu). Only when the root has NEITHER does the host
  // supply the standard 16px (e.g. list surfaces). Otherwise it double-pads.
  const rootDiv = (content as any)?.card?.states?.[0]?.div;
  const selfSpaced = !!(rootDiv?.paddings || rootDiv?.margins);
  const pad = selfSpaced ? 0 : 16;

  // The screen the swipe-back gesture reveals: the top of the back stack, painted
  // statically from the client's content cache (we just came from it, so it's warm).
  // Mirrors the live surface's padding so the reveal looks identical, then sits under
  // it until a drag pulls it into view. Non-interactive — it becomes the live surface
  // the instant the gesture commits and the route swaps.
  const canGoBack = history.length > 0;
  const prevRoute = canGoBack ? history[history.length - 1] : null;
  const prevEnv = prevRoute
    ? (clientRef.current?.peekContent(prevRoute, { viewport: VIEWPORT, theme, profile }) as
        | DivCardEnvelope
        | undefined)
    : undefined;
  const prevRootDiv = (prevEnv as any)?.card?.states?.[0]?.div;
  const prevPad = prevRootDiv?.paddings || prevRootDiv?.margins ? 0 : 16;
  const backSurface = prevEnv ? (
    <View style={{ flex: 1, paddingHorizontal: prevPad, paddingTop: insets.top + prevPad }}>
      <DivCard
        key={prevRoute}
        envelope={prevEnv}
        theme={theme}
        client={clientRef.current!}
        baseUrl={serverUrl ?? undefined}
        fire={() => {}}
        vars={{ ...((prevEnv as any).vars ?? {}), active_path: prevRoute }}
      />
    </View>
  ) : null;

  if (booting) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg, paddingTop: insets.top }]}>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <View style={styles.center}>
          <ActivityIndicator color={c.text} />
        </View>
      </View>
    );
  }

  if (serverUrl === null) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg, paddingTop: insets.top }]}>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        <ConnectScreen
          theme={theme}
          themePref={themePref}
          onThemePref={(p) => {
            setThemePref(p);
            setStoredThemePref(p);
          }}
          servers={servers}
          bottomInset={insets.bottom}
          onConnect={connectTo}
          onRemove={(url) => {
            clearCredentials(url).catch(() => {}); // forget its saved creds too
            removeServer(url).then(setServers).catch(() => {});
          }}
        />
      </View>
    );
  }

  if (status === 'login') {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg, paddingTop: insets.top }]}>
        <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
        {loginCard ? (
          // The server-driven login card: password form (onno-login-form custom)
          // and/or SSO buttons, whatever this server offers. Centered + padded,
          // with a host-supplied "Change server" affordance the web doesn't need.
          // KeyboardAvoidingView (padding) lifts the centered card above the keyboard
          // — automaticallyAdjustKeyboardInsets doesn't reliably scroll a centered,
          // non-overflowing form into view, so we pad-and-recenter instead.
          <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView
              contentContainerStyle={{
                flexGrow: 1,
                justifyContent: 'center',
                paddingHorizontal: 24,
                paddingTop: 24,
                paddingBottom: 24 + insets.bottom,
              }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {/* Cap + centre the card so it doesn't stretch into a wide slab on an iPad.
                  The cap is wider than any phone, so phones render exactly as before. */}
              <View style={styles.authColumn}>
                <DivCard
                  envelope={loginCard}
                  theme={theme}
                  client={clientRef.current!}
                  baseUrl={serverUrl}
                  fire={onAction}
                />
                <Pressable onPress={showPicker} hitSlop={8} style={styles.changeServer}>
                  <Text style={[styles.changeServerText, { color: c.muted }]}>Change server</Text>
                </Pressable>
              </View>
            </ScrollView>
          </KeyboardAvoidingView>
        ) : (
          // Fallback for a server with no /api/divkit/login endpoint.
          <LoginScreen
            theme={theme}
            serverLabel={serverUrl.replace(/^https?:\/\//, '')}
            bottomInset={insets.bottom}
            onSubmit={signIn}
            onChangeServer={showPicker}
          />
        )}
      </View>
    );
  }

  return (
    // The scroll surface runs edge-to-edge (under the notch) so content can
    // dissolve *behind* the status bar via TopFade. The top inset therefore lives
    // on the scroll content padding, not here — at-rest content sits in the same
    // place, but scrolled content passes behind the safe area. The bottom inset is
    // handled per-child (scroll padding + nav bar).
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />

      <View style={{ flex: 1 }}>
        {status === 'connecting' && !content ? (
          <View style={[styles.center, { paddingTop: insets.top }]}>
            <ActivityIndicator color={c.text} />
            {/* Server text only on the cold connect; in-app navigation just spins. */}
            {!shell && <Text style={[styles.muted, { color: c.muted }]}>Connecting to {serverUrl}…</Text>}
          </View>
        ) : status === 'error' ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>Couldn’t reach the server</Text>
            <Text style={[styles.muted, { color: c.muted }]}>{error}</Text>
            <Text style={[styles.muted, { color: c.muted, fontSize: 11 }]} selectable>{serverUrl}/api/auth/me</Text>
            <View style={styles.errActions}>
              <Pressable style={[styles.btn, { backgroundColor: c.accentBg }]} onPress={() => loadContent(route)}>
                <Text style={[styles.btnText, { color: c.accentFg }]}>Retry</Text>
              </Pressable>
              <Pressable style={[styles.btnOutline, { borderColor: c.border }]} onPress={showPicker}>
                <Text style={[styles.btnText, { color: c.text }]}>Change server</Text>
              </Pressable>
            </View>
          </View>
        ) : content ? (
          // Wraps the live surface for iOS-style swipe-to-go-back: a left-edge drag
          // pulls this screen aside to reveal `backSurface` underneath. A no-op when
          // the back stack is empty (canGoBack=false). The bottom bar + top fade are
          // siblings below, so they stay put during the drag, like native chrome.
          <SwipeBackArea
            width={SCREEN_W}
            bg={c.bg}
            canGoBack={canGoBack}
            routeKey={route}
            onBack={goBack}
            back={backSurface}
          >
            <Animated.ScrollView
              contentContainerStyle={{ paddingHorizontal: pad, paddingTop: insets.top + pad, paddingBottom: pad + insets.bottom + (hasBottomBar ? NAV_RESERVE : 0) }}
              scrollIndicatorInsets={{ top: insets.top }}
              // Keep form fields above the keyboard: inset + scroll the focused input
              // into view (iOS). Without this, lower fields on entity forms hide behind it.
              automaticallyAdjustKeyboardInsets
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              scrollEnabled={!scrollLocked}
              onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
              scrollEventThrottle={16}
            >
              <DivCard
                key={route}
                envelope={content}
                theme={theme}
                client={clientRef.current!}
                baseUrl={serverUrl}
                fire={onAction}
                prefetch={prefetchContent}
                linkFor={linkFor}
                refresh={() => loadContent(route)}
                lockScroll={setScrollLocked}
                vars={{ ...((content as any).vars ?? {}), ...navVars }}
              />
              {status === 'connecting' && (
                <View style={{ paddingVertical: 16 }}><ActivityIndicator /></View>
              )}
            </Animated.ScrollView>
          </SwipeBackArea>
        ) : null}

        {/* Content scrolls behind the notch; this keeps the safe area opaque and
            dissolves the content into it just below, instead of a hard clip line. */}
        <TopFade color={c.bg} topInset={insets.top} opacity={topFadeOpacity} />

        {hasBottomBar && (
          // The server's nav card draws its own pill (white bg, rounded border,
          // 12px margins) — we just pin it to the bottom and let it render. It's
          // a *floating* bar, so it only needs a small clearance above the home
          // indicator, not a full safe-area inset (which left a large empty gap).
          <View
            style={[
              styles.navBar,
              // Tablet: the server builds a compact pill (sized to its tabs) meant to
              // hug a corner — align it to the right so it doesn't stretch full-width
              // like the phone bar (the host owns this placement; see the server's
              // ShellLayoutBuilder.bottomNav comment).
              IS_TABLET && styles.navBarTablet,
              { paddingBottom: insets.bottom > 0 ? NAV_BOTTOM_CLEARANCE : 0 },
            ]}
            pointerEvents="box-none"
            onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
          >
            <DivCard
              envelope={shell!.nav as DivCardEnvelope}
              theme={theme}
              client={clientRef.current!}
              baseUrl={serverUrl}
              fire={fireNav}
              prefetch={prefetchContent}
              linkFor={linkFor}
              vars={navVars}
            />
          </View>
        )}
      </View>

      {/* Toasts float just above the nav bar (measured), or above the home indicator
          when there's no nav. The Toaster adds its own 12px gap on top of this. */}
      <Toaster
        theme={theme}
        bottomOffset={hasBottomBar ? navHeight || insets.bottom + NAV_RESERVE : insets.bottom}
      />
      <ConfirmHost theme={theme} />
      <ContextMenuHost theme={theme} />
    </View>
  );
}

// Pinned to the very top of the screen (behind the notch). Stays fully opaque
// through the safe-area inset — so the status bar always has a clean backdrop and
// content passing behind it is hidden — then fades to transparent over TOP_FADE px
// just below, dissolving content rather than meeting a hard clip line. Measures its
// own width — RN SVG needs explicit sizes.
function TopFade({ color, topInset, opacity }: { color: string; topInset: number; opacity: Animated.AnimatedInterpolation<number> }) {
  const [w, setW] = useState(0);
  const h = topInset + TOP_FADE;
  const solid = h > 0 ? topInset / h : 0; // opaque from the top through the inset
  return (
    <Animated.View
      pointerEvents="none"
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={[styles.topFade, { height: h, opacity }]}
    >
      {w > 0 && (
        <Svg width={w} height={h}>
          <Defs>
            <SvgLinearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={1} />
              <Stop offset={solid} stopColor={color} stopOpacity={1} />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </SvgLinearGradient>
          </Defs>
          <Rect x="0" y="0" width={w} height={h} fill="url(#topFade)" />
        </Svg>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  topFade: { position: 'absolute', top: 0, left: 0, right: 0 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  muted: { color: '#6B7280', fontSize: 13, textAlign: 'center' },
  errTitle: { fontSize: 15, fontWeight: '700', color: '#B91C1C' },
  errActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn: { backgroundColor: '#111827', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnOutline: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  navBar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  navBarTablet: { alignItems: 'flex-end' },
  authColumn: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  changeServer: { alignItems: 'center', marginTop: 24, paddingVertical: 6 },
  changeServerText: { fontSize: 14, fontWeight: '500' },
});
