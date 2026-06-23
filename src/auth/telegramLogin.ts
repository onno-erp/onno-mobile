// JS wrapper around the OnnoTelegramLogin native module (see modules/onno-telegram-login).
// Exposes a single `telegramLogin()` call plus typed errors, and degrades gracefully when
// the native module isn't linked — Expo Go, web, or a JS-only test run — so the rest of the
// app still builds and the SSO button can fall back to the server's web flow.
//
// The native module drives Telegram's official login SDK (TelegramMessenger/telegram-login-ios
// and …/telegram-login-android): it opens the Telegram app when installed and falls back to an
// in-app browser (ASWebAuthenticationSession / Custom Tab) otherwise, then resolves to the OIDC
// ID token (a JWT) we POST to /api/auth/telegram/native.

import { requireOptionalNativeModule } from 'expo-modules-core';

export interface TelegramLoginResult {
  /** The OIDC ID token (JWT) minted by Telegram's login SDK. POST it to /api/auth/telegram/native. */
  idToken: string;
  /** True when Telegram wasn't installed and the SDK completed via its web-auth fallback. */
  viaWebFallback: boolean;
}

export type TelegramLoginErrorCode =
  /** The user dismissed the Telegram / web-auth sheet. */
  | 'cancelled'
  /** The native module is not present in this build (Expo Go / web / SDK not wired). */
  | 'unavailable'
  /** The SDK errored (network, misconfiguration, denied, …). */
  | 'failed';

export class TelegramLoginError extends Error {
  constructor(public code: TelegramLoginErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TelegramLoginError';
  }
}

/** Per-bot overrides passed to the SDK at runtime, so one app can sign in against many bots/ERPs.
 *  All optional — anything omitted falls back to the build-time default (the config plugin / Info.plist). */
export interface TelegramLoginOptions {
  nonce?: string;
  /** The bot's OIDC client id for this server. */
  clientId?: string;
  /** Redirect URI registered for this bot (the app's custom scheme, or a build-registered tg.dev domain). */
  redirectUri?: string;
  scopes?: string[];
}

interface NativeTelegramModule {
  login(options: {
    nonce?: string | null;
    clientId?: string | null;
    redirectUri?: string | null;
    scopes?: string[] | null;
  }): Promise<{ idToken: string; viaWebFallback?: boolean }>;
}

// `requireOptionalNativeModule` returns null instead of throwing when the module isn't linked,
// which is exactly the "fall back to the web flow" signal we want.
const native = requireOptionalNativeModule<NativeTelegramModule>('OnnoTelegramLogin');
console.log('[tg-native] OnnoTelegramLogin module linked:', native != null);

/** Whether the native Telegram login SDK is linked (a dev-client / standalone build, not Expo Go/web). */
export function isTelegramLoginAvailable(): boolean {
  return native != null;
}

/** Run Telegram's official login SDK and resolve to an ID token (+ whether the web fallback was used). */
export async function telegramLogin(options: TelegramLoginOptions = {}): Promise<TelegramLoginResult> {
  if (!native) {
    console.log('[tg-native] login() called but module is NOT linked — throwing unavailable');
    throw new TelegramLoginError('unavailable', 'The Telegram login module is not available in this build.');
  }
  console.log('[tg-native] calling native.login()', {
    nonce: options.nonce ? 'set' : 'none',
    clientId: options.clientId ?? null,
    redirectUri: options.redirectUri ?? null,
    scopes: options.scopes ?? null,
  });
  try {
    const res = await native.login({
      nonce: options.nonce ?? null,
      clientId: options.clientId ?? null,
      redirectUri: options.redirectUri ?? null,
      scopes: options.scopes ?? null,
    });
    console.log('[tg-native] native.login() resolved; idToken length=' + (res.idToken?.length ?? 0) + ' viaWebFallback=' + (res.viaWebFallback === true));
    return { idToken: res.idToken, viaWebFallback: res.viaWebFallback === true };
  } catch (e: any) {
    // Expo native modules reject with an Error whose `code` is the identifier we threw natively.
    const code = e?.code as string | undefined;
    console.log('[tg-native] native.login() rejected', { code, message: e?.message });
    if (code === 'ERR_TELEGRAM_CANCELLED') throw new TelegramLoginError('cancelled', 'Telegram sign-in was cancelled.');
    if (code === 'ERR_TELEGRAM_UNAVAILABLE') throw new TelegramLoginError('unavailable', e?.message);
    if (e instanceof TelegramLoginError) throw e;
    throw new TelegramLoginError('failed', e?.message ?? 'Telegram sign-in failed.');
  }
}
