import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ONEC_BASE_URL } from './src/api/config';
import { OnecClient } from './src/api/onecClient';
import { DivCard } from './src/divkit';
import type { DivCardEnvelope } from './src/divkit';
import { colors } from './src/divkit/theme';

type Status = 'connecting' | 'ready' | 'error';
type Shell = Awaited<ReturnType<OnecClient['shell']>>;

const VIEWPORT = 'mobile';
const NAV_RESERVE = 88; // height the floating bottom bar occupies

export default function App() {
  const client = useRef(new OnecClient(ONEC_BASE_URL)).current;
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [profile, setProfile] = useState<string | undefined>(undefined);
  const [shell, setShell] = useState<Shell | null>(null);
  const [route, setRoute] = useState('/');
  const [content, setContent] = useState<DivCardEnvelope | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');

  async function loadShell(th: 'light' | 'dark' = theme) {
    try {
      setShell(await client.shell({ viewport: VIEWPORT, theme: th, profile }));
    } catch {
      /* nav is non-fatal; content still shows */
    }
  }

  async function loadContent(path: string, th: 'light' | 'dark' = theme) {
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

  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- onec:// action routing (mirrors the Flutter HomeShell) -----
  function onAction(url: string) {
    if (!url.startsWith('onec://')) return;
    const rest = url.slice('onec://'.length);

    if (rest === 'logout') {
      client.logout().finally(connect);
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
            await client.deleteEntity(kind, name, id);
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

  // The server pads some content roots (e.g. the dashboard) itself; for routes
  // that don't (lists), the host supplies the standard 16px padding.
  const rootPadded = !!(content as any)?.card?.states?.[0]?.div?.paddings;
  const pad = rootPadded ? 0 : 16;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.bg }]}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />

      <View style={{ flex: 1 }}>
        {status === 'connecting' && !content ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.text} />
            <Text style={[styles.muted, { color: c.muted }]}>Connecting to {ONEC_BASE_URL.replace(/^https?:\/\//, '')}…</Text>
          </View>
        ) : status === 'error' ? (
          <View style={styles.center}>
            <Text style={styles.errTitle}>Couldn’t reach the server</Text>
            <Text style={[styles.muted, { color: c.muted }]}>{error}</Text>
            <Pressable style={[styles.btn, { backgroundColor: c.accentBg }]} onPress={() => loadContent(route)}>
              <Text style={[styles.btnText, { color: c.accentFg }]}>Retry</Text>
            </Pressable>
          </View>
        ) : content ? (
          <ScrollView contentContainerStyle={{ paddingHorizontal: pad, paddingTop: pad, paddingBottom: pad + (hasBottomBar ? NAV_RESERVE : 0) }}>
            <DivCard
              key={route}
              envelope={content}
              theme={theme}
              client={client}
              baseUrl={ONEC_BASE_URL}
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
          <View style={styles.navBar} pointerEvents="box-none">
            <DivCard
              envelope={shell!.nav as DivCardEnvelope}
              theme={theme}
              client={client}
              baseUrl={ONEC_BASE_URL}
              fire={onAction}
              vars={navVars}
            />
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  muted: { color: '#6B7280', fontSize: 13, textAlign: 'center' },
  errTitle: { fontSize: 15, fontWeight: '700', color: '#B91C1C' },
  btn: { backgroundColor: '#111827', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  navBar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
