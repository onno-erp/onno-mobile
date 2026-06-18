// Per-server saved sign-in credentials, so a returning user skips the login
// screen. The session itself rides on cookies, but Spring's JSESSIONID is a
// *session* cookie — iOS doesn't persist it across app launches, so every cold
// start lands on the login form. We instead remember the credentials and replay
// them silently on connect (see App's `connect`): if they still work, the user
// never sees the login screen.
//
// Storage: AsyncStorage. We originally used expo-secure-store (iOS Keychain — the
// right home for passwords), but in Expo Go on the iOS simulator `setItemAsync`
// resolves successfully yet the value never reads back (the keychain write doesn't
// persist), so "remember me" silently never worked — confirmed via logging: same
// key, save OK, immediate get returns null. AsyncStorage is what the rest of the
// app already trusts (server list, theme) and round-trips reliably. Tradeoff: the
// creds are app-sandboxed but not encrypted at rest; a standalone/dev build (not
// Expo Go) could switch back to SecureStore.
//
// Keyed per server URL — every server signed into is remembered independently, not
// just the last. The key uses the *canonical* server identity (`upgradeScheme` +
// trailing-slash trim), the same form the saved-server list uses, so creds survive
// `loadServers`/`getLastServer` auto-migrating a saved `http://` remote → `https://`
// (otherwise the migrated URL would key differently and the server would "forget").

import AsyncStorage from '@react-native-async-storage/async-storage';
import { upgradeScheme } from './servers';

export interface Credentials {
  username: string;
  password: string;
}

const KEY_PREFIX = 'onno.cred.';

/** Canonical server identity: scheme-upgraded + trailing-slash-trimmed, matching the server list. */
function canonical(serverUrl: string): string {
  return upgradeScheme(serverUrl.trim().replace(/\/+$/, ''));
}

/** AsyncStorage has no key charset limit, so we can key by the canonical URL directly. */
function keyFor(serverUrl: string): string {
  return KEY_PREFIX + canonical(serverUrl);
}

/** Remember the credentials for a server. Best-effort — a storage failure is non-fatal. */
export async function saveCredentials(serverUrl: string, username: string, password: string): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(serverUrl), JSON.stringify({ username, password }));
  } catch {
    /* best-effort */
  }
}

/** The saved credentials for a server, or null if none (or storage is unreadable). */
export async function getCredentials(serverUrl: string): Promise<Credentials | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(serverUrl));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.username !== 'string' || typeof v?.password !== 'string') return null;
    return { username: v.username, password: v.password };
  } catch {
    return null;
  }
}

/** Forget a server's saved credentials — only when a server is removed from the picker.
 *  A plain logout deliberately does NOT call this (see OnnoClient.logout): the creds are
 *  kept so re-selecting the server signs straight back in. */
export async function clearCredentials(serverUrl: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(serverUrl));
  } catch {
    /* best-effort */
  }
}
