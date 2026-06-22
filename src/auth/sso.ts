// Decides what tapping a server-contributed SSO button should do — kept as a pure function so the
// platform branch (native Telegram SDK vs. the web startUrl round-trip) is unit-testable without
// pulling in App.tsx. The button still renders from the server's SsoProvider; only the handler is
// platform-specific, and there's no second hardcoded button.

export type SsoTap =
  /** Run Telegram's native login SDK. `fallbackHref` is the server's web flow, used if the SDK
   *  turns out to be unavailable at tap time. */
  | { kind: 'telegram-native'; fallbackHref: string | null }
  /** Open this absolute URL in the system browser (the existing web SSO behavior). */
  | { kind: 'web'; href: string };

/**
 * Resolve an SSO button tap. `id` is the provider id (e.g. "telegram"); `to` is the provider's
 * `startUrl` carried on the action (a same-origin path), if any. Mirrors the web: navigate to a
 * same-origin `to`, else the OIDC `/oauth2/authorization/{id}` convention.
 *
 * Telegram is hijacked to the native SDK only on a native platform where the module is linked;
 * web — and any native build without the module — keeps the server's startUrl flow.
 */
export function resolveSsoTap(opts: {
  id: string;
  to: string | null;
  serverUrl: string;
  /** `Platform.OS` — 'ios' | 'android' | 'web' | … */
  platform: string;
  /** `isTelegramLoginAvailable()` — whether the native module is linked. */
  telegramAvailable: boolean;
}): SsoTap | null {
  const { id, to, serverUrl, platform, telegramAvailable } = opts;

  const path = to && to.startsWith('/') ? to : id ? `/oauth2/authorization/${id}` : null;
  const href = path ? `${serverUrl.replace(/\/$/, '')}${path}` : null;

  if (id === 'telegram' && platform !== 'web' && telegramAvailable) {
    return { kind: 'telegram-native', fallbackHref: href };
  }

  if (!href) return null;
  return { kind: 'web', href };
}
