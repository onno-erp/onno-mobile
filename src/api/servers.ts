// Saved-server store for the connection switcher. Persists the list of Onno
// servers the user has connected to, plus the last one used, so the app can
// auto-connect on startup and offer a picker. Backed by AsyncStorage (included
// in Expo Go; no native rebuild needed).
//
// URLs are kept as the API ROOT, no trailing slash — same convention as
// `config.ts` (e.g. the Rentals example is `http://localhost:8899`).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { ONNO_BASE_URL } from './config';

export interface ServerEntry {
  /** Normalized base URL, no trailing slash. Acts as the identity of the entry. */
  url: string;
  /** Display label — the host[:port][/path], i.e. the URL without its scheme. */
  label: string;
}

const SERVERS_KEY = 'onno.servers';
const LAST_KEY = 'onno.lastServer';

/**
 * Coerce free-form input into a base URL we can talk to, or null if it can't
 * be one. Adds a default `http://` scheme, trims whitespace and trailing
 * slashes. Kept regex-based (not `URL`) — RN's URL polyfill is incomplete.
 */
export function normalizeUrl(input: string): string | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  // No scheme typed → default https for real hosts, http only for local/LAN dev
  // servers (which rarely have TLS). Picking http for a remote host fails against
  // HSTS/https-only deployments — the usual "can't connect to my server" cause.
  if (!/^https?:\/\//i.test(s)) s = (isLocalHost(s.split(/[/:?#]/)[0]) ? 'http://' : 'https://') + s;
  // require a non-empty host after the scheme
  if (!/^https?:\/\/[^\s/?#]+/i.test(s)) return null;
  return s.replace(/\/+$/, '');
}

/** Loopback / private-LAN / *.local hosts — the ones that usually speak http. */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * Upgrade a remembered `http://` URL to `https://` for non-local hosts. Real
 * deployments are TLS-only now — a stale http entry (e.g. one saved before the
 * https default existed) just drops the connection, so the app never even reaches
 * the login screen. Local/LAN hosts and already-https URLs are left untouched.
 */
export function upgradeScheme(url: string): string {
  const m = /^http:\/\/(.+)$/i.exec(url);
  if (!m) return url;
  const host = m[1].split(/[/:?#]/)[0];
  return isLocalHost(host) ? url : 'https://' + m[1];
}

/** Human label for a server: the URL minus its scheme (`localhost:8899`). */
export function labelFor(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

function entry(url: string): ServerEntry {
  return { url, label: labelFor(url) };
}

/**
 * The saved servers, most-recent first. On first run (nothing stored) this
 * seeds the list with the configured default so there's always something to
 * connect to.
 */
export async function loadServers(): Promise<ServerEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(SERVERS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      // Migrate stale http:// remote entries to https:// and dedupe by url, then
      // persist the cleaned list so the fix sticks across launches.
      const seen = new Set<string>();
      const list: ServerEntry[] = [];
      let changed = false;
      for (const e of parsed) {
        if (!e || typeof e.url !== 'string') continue;
        const url = upgradeScheme(e.url);
        if (url !== e.url) changed = true;
        if (seen.has(url)) {
          changed = true;
          continue;
        }
        seen.add(url);
        list.push(entry(url));
      }
      if (list.length) {
        if (changed) await saveServers(list);
        return list;
      }
    }
  } catch {
    /* fall through to the seed */
  }
  const seed = normalizeUrl(ONNO_BASE_URL);
  return seed ? [entry(seed)] : [];
}

async function saveServers(list: ServerEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(list));
  } catch {
    /* storage is best-effort */
  }
}

/**
 * Record a server as used: move it to the front of the list (adding it if
 * new) and mark it as the last-used one. Returns the updated list.
 */
export async function rememberServer(url: string): Promise<ServerEntry[]> {
  const norm = normalizeUrl(url);
  if (!norm) throw new Error('Invalid server URL');
  const rest = (await loadServers()).filter((e) => e.url !== norm);
  const list = [entry(norm), ...rest];
  await saveServers(list);
  await setLastServer(norm);
  return list;
}

/** Forget a saved server. Returns the updated list. */
export async function removeServer(url: string): Promise<ServerEntry[]> {
  const list = (await loadServers()).filter((e) => e.url !== url);
  await saveServers(list);
  const last = await getLastServer();
  if (last === url) await AsyncStorage.removeItem(LAST_KEY).catch(() => {});
  return list;
}

export async function getLastServer(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const up = upgradeScheme(raw); // self-heal a stale http:// remote last-used URL
    if (up !== raw) await setLastServer(up);
    return up;
  } catch {
    return null;
  }
}

export async function setLastServer(url: string): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_KEY, url);
  } catch {
    /* best-effort */
  }
}
