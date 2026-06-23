// The "choose a server" screen. Shown on startup when there's no last-used
// server, when the user logs out, and from the connection-error screen. Lets
// the user pick a previously-used Onno server or type a new one.
//
// Each saved server shows its favicon — read from the server's own <head> (its
// declared <link rel="icon">, which the Onno SPA ships as an SVG), with conventional
// path guesses as a fallback chain and a colored-monogram fallback so it always looks
// intentional — and the bottom carries an appearance control (System / Light / Dark)
// — `System` follows the OS, the phone-native default.

import { useEffect, useMemo, useState } from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SvgUri } from 'react-native-svg';
import { normalizeUrl, type ServerEntry } from './api/servers';
import type { ThemePref } from './api/prefs';
import { colors, type ThemeColors } from './divkit/theme';
import { LucideIcon } from './divkit/customs/lucide';
import { Touchable } from './ui/touchable';

interface Props {
  theme: 'light' | 'dark';
  /** The theme *preference* (system/light/dark) — drives the appearance control. */
  themePref: ThemePref;
  onThemePref: (pref: ThemePref) => void;
  servers: ServerEntry[];
  /** Bottom safe-area inset, so the scroll content clears the home indicator. */
  bottomInset?: number;
  onConnect: (url: string) => void;
  onRemove: (url: string) => void;
}

// scheme://host[:port] — where a favicon lives, regardless of any API path on the url.
function originOf(url: string): string | null {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? m[1] : null;
}

function schemeOf(url: string): string {
  return /^https:/i.test(url) ? 'https' : 'http';
}

// One favicon to try: its absolute URL and whether it's an SVG (RN's <Image> can't
// decode SVG — those render via react-native-svg's <SvgUri> instead).
interface FaviconCandidate {
  uri: string;
  svg: boolean;
}

// Resolve a favicon href (as written in the page) against the server origin. Handles
// absolute, scheme-relative (//host), root-relative (/path) and bare relative hrefs.
function resolveUrl(href: string, origin: string): string | null {
  const h = href.trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith('//')) return `${schemeOf(origin)}:${h}`;
  if (h.startsWith('/')) return origin + h;
  return `${origin}/${h.replace(/^\.?\//, '')}`;
}

// Read one attribute (case-insensitive, quoted) out of a single HTML tag string.
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return m ? m[1] : null;
}

// Pull every <link rel="...icon..."> out of a page's HTML — icon, shortcut icon,
// apple-touch-icon, mask-icon — resolved to absolute URLs and tagged svg/raster.
function iconsFromHtml(html: string, origin: string): FaviconCandidate[] {
  const out: FaviconCandidate[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    if (!/\bicon\b/.test(rel)) continue;
    const uri = resolveUrl(attr(tag, 'href') ?? '', origin);
    if (!uri) continue;
    const type = (attr(tag, 'type') ?? '').toLowerCase();
    out.push({ uri, svg: type.includes('svg') || /\.svg(?:[?#]|$)/i.test(uri) });
  }
  return out;
}

// The favicons to try for a server, best first: whatever the page's <head> declares,
// then the conventional root paths as a fallback for servers that declare nothing.
// `.ico` is dropped — neither <Image> (iOS) nor <SvgUri> can decode it.
function faviconCandidates(html: string | null, origin: string): FaviconCandidate[] {
  const guesses: FaviconCandidate[] = [
    { uri: `${origin}/favicon.svg`, svg: true },
    { uri: `${origin}/apple-touch-icon.png`, svg: false },
    { uri: `${origin}/favicon-32x32.png`, svg: false },
    { uri: `${origin}/favicon.png`, svg: false },
  ];
  const seen = new Set<string>();
  return [...(html ? iconsFromHtml(html, origin) : []), ...guesses].filter((c) => {
    if (/\.ico(?:[?#]|$)/i.test(c.uri) || seen.has(c.uri)) return false;
    seen.add(c.uri);
    return true;
  });
}

// First letter/digit of the host, for the no-favicon fallback tile.
function monogramOf(label: string): string {
  const m = /[a-z0-9]/i.exec(label);
  return (m ? m[0] : '?').toUpperCase();
}

// A stable, pleasant tile color derived from the host, so each server reads as
// distinct even before (or without) a favicon. RN understands hsl() strings.
function tintOf(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) % 360;
  return `hsl(${h}, 52%, 52%)`;
}

// The server's favicon. It reads the page's <head> to find the icon the server
// actually declares (the Onno SPA serves an SVG at a path the guesses miss, and
// returns an HTML 200 for any missing asset — so blind path-guessing never finds it),
// falling back to the conventional path guesses while that loads. Each candidate is
// tried in turn; if all fail it settles on a colored monogram tile so the row never
// shows a broken image.
//
// The tile keeps its per-server tint *behind* the favicon rather than flipping to
// white: Onno marks are monochrome glyphs designed for the server's colored header
// (this deployment's is a white circle), so a white chip would render them invisible.
// A mid-tone tint keeps light and dark glyphs legible, and raster icons that carry
// their own background simply cover it.
function ServerIcon({ url, label }: { url: string; label: string }) {
  const origin = useMemo(() => originOf(url), [url]);
  const [candidates, setCandidates] = useState<FaviconCandidate[]>(() =>
    origin ? faviconCandidates(null, origin) : [],
  );
  const [idx, setIdx] = useState(0);
  // The URL we've confirmed renders — compared against the current candidate so a
  // candidate swap (advance, or the <head> result arriving) shows the monogram until
  // the new icon actually loads, never a stale/empty tile.
  const [loadedUri, setLoadedUri] = useState<string | null>(null);

  // Ask the server which icon it declares. Falls back to the path guesses if the page
  // can't be fetched or declares none. Re-runs per server; aborts on unmount.
  useEffect(() => {
    if (!origin) return;
    let live = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    fetch(origin, { signal: ctrl.signal })
      .then((r) => r.text())
      .then((html) => {
        if (!live) return;
        setIdx(0);
        setCandidates(faviconCandidates(html, origin));
      })
      .catch(() => {})
      .finally(() => clearTimeout(t));
    return () => {
      live = false;
      ctrl.abort();
      clearTimeout(t);
    };
  }, [origin]);

  const cur = candidates[idx];
  const showFavicon = !!cur && loadedUri === cur.uri;
  const advance = () => setIdx((i) => i + 1);

  return (
    <View style={[styles.icon, { backgroundColor: tintOf(label) }]}>
      {!showFavicon && <Text style={styles.iconMono}>{monogramOf(label)}</Text>}
      {cur && (
        // Absolutely positioned (inset within the tile) so the loading/erroring icon
        // never shares the flex column with the monogram — the letter stays put.
        <View style={styles.iconImg} pointerEvents="none">
          {cur.svg ? (
            <SvgUri
              key={cur.uri}
              uri={cur.uri}
              width="100%"
              height="100%"
              onLoad={() => setLoadedUri(cur.uri)}
              onError={advance}
            />
          ) : (
            <Image
              key={cur.uri}
              source={{ uri: cur.uri }}
              onLoad={() => setLoadedUri(cur.uri)}
              onError={advance}
              resizeMode="contain"
              style={styles.fill}
            />
          )}
        </View>
      )}
    </View>
  );
}

// The three appearance modes, in cycle order.
const THEME_CYCLE: { key: ThemePref; icon: string; label: string }[] = [
  { key: 'system', icon: 'smartphone', label: 'System' },
  { key: 'light', icon: 'sun', label: 'Light' },
  { key: 'dark', icon: 'moon', label: 'Dark' },
];

// A compact 3-state button: shows the current mode (icon + label) and advances to
// the next on tap (System → Light → Dark → …). Small footprint vs. a full segmented
// control — it's a low-frequency setting, so cycling is fine.
function ThemeCycleButton({ value, onChange, c }: { value: ThemePref; onChange: (p: ThemePref) => void; c: ThemeColors }) {
  const i = Math.max(0, THEME_CYCLE.findIndex((o) => o.key === value));
  const cur = THEME_CYCLE[i];
  const next = THEME_CYCLE[(i + 1) % THEME_CYCLE.length].key;
  return (
    <Touchable
      onPress={() => onChange(next)}
      style={[styles.themeBtn, { borderColor: c.border, backgroundColor: c.surface }]}
    >
      <LucideIcon name={cur.icon} size={15} color={c.text} />
      <Text style={[styles.themeBtnText, { color: c.text }]}>{cur.label}</Text>
    </Touchable>
  );
}

export function ConnectScreen({ theme, themePref, onThemePref, servers, bottomInset = 0, onConnect, onRemove }: Props) {
  const c = colors(theme);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  function submit() {
    const norm = normalizeUrl(draft);
    if (!norm) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft('');
    onConnect(norm);
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        // Lift the URL field above the keyboard (iOS) instead of letting it hide behind it.
        automaticallyAdjustKeyboardInsets
      >
        <Text style={[styles.title, { color: c.text }]}>Connect to a server</Text>
        <Text style={[styles.subtitle, { color: c.muted }]}>
          Pick a Onno server or add a new one.
        </Text>

        {/* Add a new server */}
        <View style={styles.inputRow}>
          <TextInput
            value={draft}
            onChangeText={(t) => {
              setDraft(t);
              if (invalid) setInvalid(false);
            }}
            onSubmitEditing={submit}
            placeholder="https://demo.cloud.onno.su"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            style={[
              styles.input,
              {
                color: c.text,
                backgroundColor: c.fieldBg,
                borderColor: invalid ? c.dangerFg : c.fieldBorder,
              },
            ]}
          />
          <Touchable
            onPress={submit}
            disabled={draft.trim() === ''}
            style={[
              styles.addBtn,
              { backgroundColor: c.accentBg, opacity: draft.trim() === '' ? 0.5 : 1 },
            ]}
          >
            <Text style={[styles.addBtnText, { color: c.accentFg }]}>Connect</Text>
          </Touchable>
        </View>
        {invalid && (
          <Text style={[styles.fieldError, { color: c.dangerFg }]}>
            Enter a valid URL, e.g. https://demo.cloud.onno.su
          </Text>
        )}

        {/* Saved servers */}
        {servers.length > 0 && (
          <Text style={[styles.sectionLabel, { color: c.muted }]}>SAVED SERVERS</Text>
        )}
        <View style={[styles.list, { borderColor: c.border, backgroundColor: c.card }]}>
          {servers.length === 0 ? (
            <Text style={[styles.empty, { color: c.muted }]}>
              No saved servers yet — add one above.
            </Text>
          ) : (
            servers.map((s, i) => (
              <Touchable
                key={s.url}
                onPress={() => onConnect(s.url)}
                style={[
                  styles.row,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                ]}
              >
                <ServerIcon url={s.url} label={s.label} />
                <View style={styles.flex}>
                  <Text style={[styles.rowLabel, { color: c.text }]} numberOfLines={1}>
                    {s.label}
                  </Text>
                  <Text style={[styles.rowSub, { color: c.muted }]} numberOfLines={1}>
                    {schemeOf(s.url)}
                  </Text>
                </View>
                <Touchable
                  onPress={() => onRemove(s.url)}
                  hitSlop={10}
                  style={[styles.remove, { backgroundColor: c.surface }]}
                >
                  <LucideIcon name="x" size={15} color={c.muted} />
                </Touchable>
              </Touchable>
            ))
          )}
        </View>
      </ScrollView>

      {/* Appearance — a small cycle button in the bottom-right, above the home indicator. */}
      <View style={[styles.footer, { paddingBottom: 14 + bottomInset }]}>
        <View style={styles.footerInner}>
          <ThemeCycleButton value={themePref} onChange={onThemePref} c={c} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Cap the column and centre it so it doesn't stretch into a long line on an iPad.
  // The cap is wider than any phone, so phones render exactly as before.
  content: { padding: 24, paddingTop: 72, paddingBottom: 24, gap: 12, width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, marginBottom: 8 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
  },
  addBtn: {
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { fontWeight: '600', fontSize: 14 },
  fieldError: { fontSize: 13 },
  sectionLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginTop: 12 },
  list: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  empty: { padding: 16, fontSize: 14, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, gap: 12 },
  rowLabel: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12.5, marginTop: 1 },
  icon: { width: 38, height: 38, borderRadius: 9, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  iconMono: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  // The favicon's inset box — absolute so the loading/erroring icon never shares the
  // flex column with the monogram (the letter stays put, no jiggle).
  iconImg: { position: 'absolute', top: 5, left: 5, right: 5, bottom: 5 },
  fill: { width: '100%', height: '100%' },
  remove: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  // Bottom appearance bar (no divider — the button floats in the bottom-right).
  footer: { paddingHorizontal: 24, paddingTop: 8 },
  footerInner: { width: '100%', maxWidth: 480, alignSelf: 'center' },
  themeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-end',
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  themeBtnText: { fontSize: 13, fontWeight: '600' },
});
