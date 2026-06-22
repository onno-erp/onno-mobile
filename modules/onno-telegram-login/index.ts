// Local Expo module: native "Login with Telegram" for the Onno mobile client.
//
// The app does NOT import this file directly — it talks to the module through
// src/auth/telegramLogin.ts, which uses `requireOptionalNativeModule('OnnoTelegramLogin')`
// so the JS bundle still builds where the native side is absent (Expo Go / web / tests).
// This entry point exists for completeness and for direct/native-only consumers.
//
// Native sources:
//   • ios/OnnoTelegramLoginModule.swift  — wraps TelegramMessenger/telegram-login-ios
//   • android/.../OnnoTelegramLoginModule.kt — wraps TelegramMessenger/telegram-login-android
// Config plugin (Info.plist / AndroidManifest wiring): ../../plugins/withTelegramLogin.js

import { requireNativeModule } from 'expo-modules-core';

export interface OnnoTelegramLoginModule {
  /** Run the Telegram login SDK; resolves to the OIDC ID token (and whether the web fallback ran). */
  login(options: { nonce?: string | null }): Promise<{ idToken: string; viaWebFallback?: boolean }>;
}

export default requireNativeModule<OnnoTelegramLoginModule>('OnnoTelegramLogin');
