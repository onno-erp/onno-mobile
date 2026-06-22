// Orchestrates the native "Login with Telegram" sequence, kept free of React/RN so it's
// unit-testable in isolation: begin (nonce) → run the SDK → exchange the ID token for a
// session cookie on our HTTP client.
//
//   const { user, viaWebFallback } = await runTelegramNativeLogin({ client, telegramLogin });
//
// The dependencies are injected (the real OnnoClient + the real telegramLogin in the app; fakes
// in tests), so the sequence and its tolerances can be asserted without a device or the SDK.

import type { TelegramNativeUser, TelegramBotConfig } from '../api/onnoClient';
import type { TelegramLoginResult, TelegramLoginOptions } from './telegramLogin';

/** The slice of OnnoClient this flow needs (kept narrow so tests can pass a fake). */
export interface TelegramFlowClient {
  telegramNativeBegin(): Promise<{ nonce: string | null } & TelegramBotConfig>;
  telegramNativeLogin(idToken: string): Promise<TelegramNativeUser>;
}

export type TelegramLoginFn = (options: TelegramLoginOptions) => Promise<TelegramLoginResult>;

export interface TelegramFlowResult {
  user: TelegramNativeUser;
  /** Telegram wasn't installed and the SDK completed via its web-auth fallback. */
  viaWebFallback: boolean;
}

/**
 * Drive the three-step native Telegram sign-in. Step 1 (the replay-protection nonce) is best-effort:
 * a server that doesn't expose `/native/begin`, or a transient failure, just proceeds without a nonce.
 * Steps 2 and 3 propagate their errors (SDK cancel/failure, or a 401 from the exchange) to the caller.
 */
export async function runTelegramNativeLogin(deps: {
  client: TelegramFlowClient;
  telegramLogin: TelegramLoginFn;
}): Promise<TelegramFlowResult> {
  // 1) Ask the server for a one-time nonce (replay protection) and, for a multi-tenant app, which bot
  //    THIS server signs in with (clientId/redirectUri/scopes). All optional — a failure or older
  //    server just falls back to the build-time default bot.
  let opts: TelegramLoginOptions = {};
  try {
    const begun = await deps.client.telegramNativeBegin();
    opts = {
      nonce: begun?.nonce ?? undefined,
      clientId: begun?.clientId,
      redirectUri: begun?.redirectUri,
      scopes: begun?.scopes,
    };
  } catch {
    opts = {};
  }

  // 2) Drive Telegram's official login SDK to mint an ID token (with this server's bot config).
  const { idToken, viaWebFallback } = await deps.telegramLogin(opts);

  // 3) Exchange the token for a session cookie on the SAME HTTP client, so the cookie persists
  //    across relaunch and authenticates every later /api/** request.
  const user = await deps.client.telegramNativeLogin(idToken);

  return { user, viaWebFallback };
}
