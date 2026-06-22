# onno-telegram-login (local Expo module)

Native **Login with Telegram** for the Onno mobile client. Wraps Telegram's official login SDKs so
the server-contributed Telegram SSO button works natively — no browser/WebView round-trip:

- iOS — [TelegramMessenger/telegram-login-ios](https://github.com/TelegramMessenger/telegram-login-ios) (Swift Package Manager)
- Android — [TelegramMessenger/telegram-login-android](https://github.com/TelegramMessenger/telegram-login-android) (GitHub Packages: `org.telegram:login-sdk`)

It exposes one JS method, `login({ nonce? }) → { idToken, viaWebFallback }`, consumed by
[`src/auth/telegramLogin.ts`](../../src/auth/telegramLogin.ts). Because the app loads the module with
`requireOptionalNativeModule`, the JS bundle still builds where the native side is absent (Expo Go,
web, Jest), and the SSO button falls back to the server's web flow.

> Requires a **dev client / standalone build** (`expo-dev-client`). It does not run in Expo Go.

## What's implemented

The bridges are wired to the real SDKs (not stubs):

| Path | Purpose |
| --- | --- |
| `index.ts` | `requireNativeModule('OnnoTelegramLogin')` + types |
| `expo-module.config.json` | registers the native module + the iOS AppDelegate subscriber |
| `ios/OnnoTelegramLoginModule.swift` | `TelegramLogin.configure(...)` + `TelegramLogin.login { … }`, reads config from Info.plist |
| `ios/OnnoTelegramLoginAppDelegate.swift` | forwards the Universal-Link / custom-scheme callback to `TelegramLogin.handle(_:)` |
| `ios/OnnoTelegramLogin.podspec` | `ExpoModulesCore` dep (the SDK itself is added via SPM) |
| `android/.../OnnoTelegramLoginModule.kt` | `init` / `startLogin` / `handleLoginResponse`, reads config from manifest `<meta-data>`, completes on `OnNewIntent` |
| `android/build.gradle` | Custom Tabs dep + the (commented) Telegram SDK coordinate |
| `android/src/main/AndroidManifest.xml` | `<queries>` so the SDK can see/launch Telegram |

Both sides keep building **with or without** the SDK linked: iOS via `#if canImport(TelegramLogin)`,
Android via a small reflection shim. Until the SDK is added they reject `ERR_TELEGRAM_UNAVAILABLE`,
which makes the app fall back to the server's web SSO flow.

## Enabling it (per deployment)

The config plugin ([`plugins/withTelegramLogin.js`](../../plugins/withTelegramLogin.js)) registers the
build-time redirect mechanisms. **Which bot** signs in is chosen at runtime (the server returns its
`clientId` from `/api/auth/telegram/native/begin`), so `app.json` only needs:

```json
["./plugins/withTelegramLogin", {
  "iosCustomScheme": "onno-telegram",
  "universalLinkAppIds": [],
  "defaultClientId": "",
  "defaultAppId": "",
  "scopes": ["profile"]
}]
```

The custom scheme works for **any** bot; add bot `appId`s to `universalLinkAppIds` to also register
their `app{appId}-login.tg.dev` Universal Links / App Links. See the root
[README](../../README.md#multiple-bots--multiple-erps) for the multi-tenant model.

Then add the SDK to each platform:

**iOS** — in Xcode, *File → Add Package Dependencies…* →
`https://github.com/TelegramMessenger/telegram-login-ios`, add it to the app target. (During
development you can append `?mode=developer` to the associated domain to bypass caching.)

**Android** — add the GitHub Packages repo to your app's `android/settings.gradle` and uncomment the
dependency in `android/build.gradle`:

```kotlin
// android/settings.gradle → dependencyResolutionManagement { repositories { … } }
maven {
  url = uri("https://maven.pkg.github.com/TelegramMessenger/telegram-login-android")
  credentials {
    username = providers.gradleProperty("gpr.user").orNull ?: System.getenv("GITHUB_USERNAME")
    password = providers.gradleProperty("gpr.key").orNull ?: System.getenv("GITHUB_TOKEN")
  }
}
```

```groovy
// modules/onno-telegram-login/android/build.gradle
implementation 'org.telegram:login-sdk:1.0.0'
```

(The GitHub token is a build-time credential — it never ships in the app.)

Finally rebuild the dev client (`npm run ios` / `npm run android`) — native/config-plugin changes need
a rebuild, not just a Metro reload. See the root [`README.md`](../../README.md#login-with-telegram-native-sso)
for the @BotFather registration steps.
