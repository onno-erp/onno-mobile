// Local app preferences, persisted with AsyncStorage (Expo Go friendly — no
// native rebuild). The light/dark theme mirrors the web SPA, which remembers the
// chosen theme in localStorage ("onno-ui-theme") and restores it on load (see
// onno-ui-starter providers/theme-provider.tsx). On top of that we add a `system`
// option (follow the OS appearance) — the RN-native default a phone user expects.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeName = 'light' | 'dark';
/** The user's theme choice: an explicit mode, or `system` to follow the OS. */
export type ThemePref = ThemeName | 'system';

const THEME_KEY = 'onno.theme';

/** The saved theme preference, or null if none chosen yet (caller treats null as
 *  `system`). Old builds stored only 'light'/'dark'; those still read back fine. */
export async function getStoredThemePref(): Promise<ThemePref | null> {
  try {
    const v = await AsyncStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

/** Remember the chosen theme preference. Best-effort — a storage failure is non-fatal. */
export async function setStoredThemePref(pref: ThemePref): Promise<void> {
  try {
    await AsyncStorage.setItem(THEME_KEY, pref);
  } catch {
    /* best-effort */
  }
}

// Last viewed route, per server. Lets a cold-start / relaunch (iOS terminates a
// backgrounded app while multitasking) restore the page you were on instead of
// dropping you back at the home screen.
const ROUTE_PREFIX = 'onno.route.';

/** The last route viewed on `serverUrl`, or null if none saved yet. */
export async function getLastRoute(serverUrl: string): Promise<string | null> {
  try {
    return (await AsyncStorage.getItem(ROUTE_PREFIX + serverUrl)) || null;
  } catch {
    return null;
  }
}

/** Remember the last route for `serverUrl`. Best-effort. */
export async function setLastRoute(serverUrl: string, route: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ROUTE_PREFIX + serverUrl, route);
  } catch {
    /* best-effort */
  }
}
