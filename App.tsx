import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { OnecClient } from './src/api/onecClient';
import {
  getLastServer,
  loadServers,
  rememberServer,
  removeServer,
  type ServerEntry,
} from './src/api/servers';
import { ConnectScreen } from './src/ConnectScreen';
import { DivCard } from './src/divkit';
import type { DivCardEnvelope } from './src/divkit';
import { colors } from './src/divkit/theme';

type Status = 'connecting' | 'ready' | 'error';
type Shell = Awaited<ReturnType<OnecClient['shell']>>;

const VIEWPORT = 'mobile';
const NAV_RESERVE = 88; // height the floating bottom bar occupies

export default function App() {
  const insets = useSafeAreaInsets();
  // One client per server; recreated on switch (the CSRF/session state it holds
  // is server-specific). `serverUrl === null` means "show the picker".
  const clientRef = useRef<OnecClient | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [booting, setBooting] = useState(true);

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [profile, setProfile] = useState<string | undefined>(undefined);
  const [shell, setShell] = useState<Shell | null>(null);
  const [route, setRoute] = useState('/');
  const [content, setContent] = useState<DivCardEnvelope | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');

  async function loadShell(th: 'light' | 'dark' = theme) {
    const client = clientRef.current;
    if (!client) return;
    try {
      setShell(await client.shell({ viewport: VIEWPORT, theme: th, profile }));
    } catch {
      /* nav is non-fatal; content still shows */
    }
  }

  async function loadContent(path: string, th: 'light' | 'dark' = theme) {
    const client = clientRef.current;
    if (!client) return;
    setStatus('connecting');
    setError('');
    setRoute(path);
    try {
      const env = (await client.content(path, { viewport: VIEWPORT, theme: th, profile })) as DivCardEnvelope;
      setContent(env);
      setStatus('ready');
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStatus('error');
    }
  }

  async function connect() {
    const client = clientRef.current;
    if (!client) return;
    setStatus('connecting');
    try {
      let me = await client.me();
      if (!me.authenticated) me = await client.login('admin', 'admin');
      await Promise.all([loadShell(), loadContent('/')]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setStatus('error');
    }
  }

  // Point the app at a server: spin up a fresh client, reset per-server state,
  // leave the picker, persist it as last-used, then connect.
  function connectTo(url: string) {
    clientRef.current = new OnecClient(url);
    setProfile(undefined);
    setShell(null);
    setContent(null);
    setRoute('/');
    setStatus('connecting');
    setError('');
    setServerUrl(url);
    setBooting(false);
    rememberServer(url).then(setServers).catch(() => {});
    connect();
  }

  // Drop back to the server picker (used by logout and "Change server").
  function showPicker() {
    clientRef.current = null;
    setServerUrl(null);
    setContent(null);
    setShell(null);
    setError('');
    loadServers().then(setServers).catch(() => {});
  }

  // Startup: auto-connect to the last-used server, or open the picker.
  useEffect(() => {
    (async () => {
      const list = await loadServers();
      setServers(list);
      const last = await getLastServer();
      if (last) connectTo(last);
      else setBooting(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- onec:// action routing (mirrors the Flutter HomeShell) -----
  function onAction(url: string) {
    if (!url.startsWith('onec://')) return;
    const rest = url.slice('onec://'.length);

    if (rest === 'logout') {
      // Log out, then drop back to the server picker so the user can choose
      // (or re-pick) a server rather than silently re-logging into this one.
      Promise.resolve(clientRef.current?.logout()).finally(showPicker);
      return;
    }
    if (rest === 'theme/toggle') {
      const next = theme === 'light' ? 'dark' : 'light';
      setTheme(next);
      // refetch with the new theme explicitly (state update hasn't applied yet)
      loadShell(next);
      loadContent(route, next);
      return;
    }
    if (rest.startsWith('app')) {
      const q = rest.indexOf('?');
      const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');
      setProfile(params.get('profile') ?? undefined);
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
    loadContent(('/' + rest).replace('//', '/'));
  }

  function confirmDelete(kind: string, name: string, id: string) {
    Alert.alert('Delete record?', 'This marks the record for deletion.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await clientRef.current?.deleteEntity(kind, name, id);
            loadContent(`/${kind}/${name}`);
          } catch (e: any) {
            Alert.alert('Delete failed', String(e?.message ?? e));
          }
        },
      },
    ]);
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
          servers={servers}
          bottomInset={insets.bottom}
          onConnect={connectTo}
          onRemove={(url) => removeServer(url).then(setServers).catch(() => {})}
        />
      </View>
    );
  }

  return (
    // Apply the top inset here (notch / status bar) so headers aren't clipped.
    // The bottom inset is handled per-child: on the scroll padding and the nav
    // bar, so the floating bar can sit flush against the home indicator.
    <View style={[styles.screen, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />

      <View style={{ flex: 1 }}>
        {status === 'connecting' && !content ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.text} />
            <Text style={[styles.muted, { color: c.muted }]}>Connecting to {serverUrl.replace(/^https?:\/\//, '')}…</Text>
          </View>
        ) : status === 'error' ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>Couldn’t reach the server</Text>
            <Text style={[styles.muted, { color: c.muted }]}>{error}</Text>
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
          <ScrollView contentContainerStyle={{ paddingHorizontal: pad, paddingTop: pad, paddingBottom: pad + insets.bottom + (hasBottomBar ? NAV_RESERVE : 0) }}>
            <DivCard
              key={route}
              envelope={content}
              theme={theme}
              client={clientRef.current!}
              baseUrl={serverUrl}
              fire={onAction}
              refresh={() => loadContent(route)}
              vars={{ ...((content as any).vars ?? {}), ...navVars }}
            />
            {status === 'connecting' && (
              <View style={{ paddingVertical: 16 }}><ActivityIndicator /></View>
            )}
          </ScrollView>
        ) : null}

        {hasBottomBar && (
          // The server's nav card draws its own pill (white bg, rounded border,
          // 12px margins) — we just pin it to the bottom and let it render.
          <View style={[styles.navBar, { paddingBottom: insets.bottom }]} pointerEvents="box-none">
            <DivCard
              envelope={shell!.nav as DivCardEnvelope}
              theme={theme}
              client={clientRef.current!}
              baseUrl={serverUrl}
              fire={onAction}
              vars={navVars}
            />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  muted: { color: '#6B7280', fontSize: 13, textAlign: 'center' },
  errTitle: { fontSize: 15, fontWeight: '700', color: '#B91C1C' },
  errActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  btn: { backgroundColor: '#111827', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnOutline: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  navBar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
