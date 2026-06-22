# Onno mobile

React Native + Expo (SDK 56) client for an Onno server. The login screen is **server-driven**: the
server returns a DivKit card describing whatever it offers — a password form and/or one button per
SSO provider (`SsoProvider{ id, label, startUrl }`) — and the app renders it and routes the taps.

> Expo has changed a lot between versions — read the exact versioned docs at
> <https://docs.expo.dev/versions/v56.0.0/> before writing native/config code.

## Develop

```bash
npm install
npm start            # Metro / Expo dev server
npm run ios          # build & run the iOS dev client
npm run android      # build & run the Android dev client
npm test             # Jest unit tests (auth flow logic)
npx tsc --noEmit     # type-check
```

Native modules (incl. Telegram login below) require a **dev client / standalone build**
(`expo-dev-client`); they don't run in Expo Go.

---

## Login with Telegram (native SSO)

The same server-contributed Telegram SSO button works **natively** on the app — running Telegram's
official login SDK instead of the web/OIDC browser round-trip. The button still renders from the
server's `SsoProvider`; only the **tap handler** is platform-specific, and there's no second
hardcoded button.

### How it works

| Layer | File |
| --- | --- |
| Native module (iOS/Android bridges, wired to the official SDKs) | [`modules/onno-telegram-login/`](modules/onno-telegram-login/) |
| Expo config plugin (Info.plist / entitlements / manifest wiring) | [`plugins/withTelegramLogin.js`](plugins/withTelegramLogin.js) |
| JS wrapper (optional native binding + typed errors) | [`src/auth/telegramLogin.ts`](src/auth/telegramLogin.ts) |
| Flow orchestration (begin → SDK → exchange) | [`src/auth/telegramFlow.ts`](src/auth/telegramFlow.ts) |
| Tap-handler branch (native vs. web) | [`src/auth/sso.ts`](src/auth/sso.ts) + `onAction`/`signInWithTelegram` in [`App.tsx`](App.tsx) |
| Server calls | `telegramNativeBegin()` / `telegramNativeLogin()` in [`src/api/onnoClient.ts`](src/api/onnoClient.ts) |

Tap sequence when `id === "telegram"` on a native build with the module linked:

1. `POST /api/auth/telegram/native/begin` → `{ nonce }` plus, optionally, **this server's bot**
   (`clientId` / `redirectUri` / `scopes`). Replay protection + multi-tenant bot selection.
2. `telegramLogin({ nonce, clientId, redirectUri, scopes })` — runs the SDK for that bot. It opens the
   **Telegram app** when installed, otherwise falls back to **ASWebAuthenticationSession** (iOS) /
   **Custom Tab** (Android). Resolves to an OIDC **ID token** (JWT).
3. `POST /api/auth/telegram/native` with `{ idToken }` through the **same `OnnoClient`** — on `200`
   the server's `Set-Cookie` session lands in the shared cookie jar, so it persists across relaunch
   and authenticates every later `/api/**` request. The app then refreshes auth state and enters.

#### Multiple bots / multiple ERPs

This app connects to many servers, each with **its own Telegram bot** — so the bot is chosen at
**runtime**, not baked in. `/native/begin` returns the active server's `clientId` / `redirectUri` /
`scopes`, which are passed straight to the SDK (falling back to a build-time default bot if the server
sends none). The one native constraint: a redirect can only return to this binary if its mechanism was
registered **at build time**:

- **Custom scheme** (`onno-telegram://tglogin`) — registered once, **not** domain-bound, so it works
  for **any** bot registered to this app's bundle id/package in @BotFather. This is the default
  runtime `redirectUri` and the multi-tenant baseline.
- **Universal Links / App Links** (`app{appId}-login.tg.dev`) — nicer UX/security, but each domain
  must be listed in `universalLinkAppIds` at build time, so only for the finite set of bots you know up
  front. (The bridges match **any** `…-login.tg.dev` callback, so listing more is the only step.)

So: an unbounded set of ERPs works out of the box via the custom scheme; opt specific bots into
Universal Links by adding their `appId`s and rebuilding.

Each outcome is surfaced distinctly:

| Outcome | UX |
| --- | --- |
| Success | enters the app |
| Telegram not installed → web-auth fallback succeeded | enters the app + an info toast |
| User cancelled the SDK sheet | quiet "Telegram sign-in cancelled." toast |
| `401 telegram_login_failed` | error toast, stays on the login screen |
| Native module not in this build | **falls back to the server's web SSO flow** (`startUrl`) |

**Web** (and any native build without the module) always keeps opening `startUrl`.

### Setup

#### 1. Register each bot with @BotFather

For **every** bot/ERP, in Telegram **@BotFather → your bot → Bot Settings → Login Widget**, register
this app — the **same bundle id/package** for all of them:

- **iOS** — Bundle ID `su.onno.onnomobile` + your Apple **Team ID**.
- **Android** — package `su.onno.onnomobile` + the **SHA-256** signing-certificate fingerprint
  (one per signing key — debug, EAS, and Play App Signing each have their own; register all you use):

  ```bash
  keytool -list -v -keystore <your.keystore> -alias <alias> | grep SHA256
  ```

Each bot yields a **client id** (and an **app id** → the hosted domain `app{appId}-login.tg.dev`, which
Telegram hosts — no AASA/asset-links hosting on your side). Have each **server return its bot's
`clientId`** (and optionally `redirectUri`/`scopes`) from `/api/auth/telegram/native/begin`; default
`redirectUri` is the app's custom scheme. No secrets live in the app.

#### 2. Configure the plugin

`app.json` only needs build-time redirect registration — **not** per-bot ids (those come from the
server at runtime):

```json
["./plugins/withTelegramLogin", {
  "iosCustomScheme": "onno-telegram",
  "universalLinkAppIds": [],
  "defaultClientId": "",
  "defaultAppId": "",
  "scopes": ["profile"]
}]
```

- `iosCustomScheme` — registered as the any-bot redirect (CFBundleURLTypes / Android intent-filter)
  and the default runtime `redirectUri`. Always on.
- `universalLinkAppIds` — opt specific bots into Universal Links / verified App Links (adds the iOS
  Associated Domain + Android `autoVerify` app-link intent-filter per `appId`).
- `defaultClientId` / `defaultAppId` — optional single-tenant fallback baked into Info.plist /
  `<meta-data>` for when a server sends no per-bot config.

The native bridges read this config and the runtime overrides, drive the SDK, and the callback is
delivered automatically (iOS AppDelegate subscriber → `TelegramLogin.handle`; Android `OnNewIntent` →
`handleLoginResponse`), matching **any** `…-login.tg.dev` domain or the custom scheme.

#### 3. Add the SDK to each platform

The bridges are implemented but compile/run **with or without** the SDK linked (falling back to the
web flow until it's present). To turn it on:

- **iOS** — Xcode → *File → Add Package Dependencies…* →
  `https://github.com/TelegramMessenger/telegram-login-ios`, add to the app target.
- **Android** — add the GitHub Packages maven repo (with a `gpr.user`/`gpr.key` token) to
  `android/settings.gradle` and uncomment `implementation 'org.telegram:login-sdk:1.0.0'` in
  `modules/onno-telegram-login/android/build.gradle`.

Full snippets in [`modules/onno-telegram-login/README.md`](modules/onno-telegram-login/README.md).
Then rebuild the dev client (`npm run ios` / `npm run android`) — native/config-plugin changes need a
native rebuild, not just a Metro reload.

### Tests

```bash
npm test
```

- `src/auth/__tests__/sso.test.ts` — the tap-handler branch: native (iOS/Android, module linked) →
  the SDK; web, and native-without-module → the server `startUrl`; non-Telegram providers untouched.
- `src/auth/__tests__/telegramFlow.test.ts` — the begin → SDK → exchange sequence and order, the
  optional-nonce tolerance, the web-fallback flag, and error propagation (SDK cancel, `401`).
