import ExpoModulesCore

#if canImport(TelegramLogin)
import TelegramLogin
#endif

// Native bridge for "Login with Telegram" on iOS.
//
// Wraps Telegram's official login SDK (TelegramMessenger/telegram-login-ios, added via Swift Package
// Manager). The SDK opens the Telegram app when installed and otherwise presents a secure
// ASWebAuthenticationSession; on success it returns an OIDC ID token (a JWT) that the JS layer POSTs
// to /api/auth/telegram/native.
//
// Config (clientId / redirectUri / scopes) is written into Info.plist by the Expo config plugin
// (plugins/withTelegramLogin.js) so nothing is hardcoded here. The redirect callback is delivered by
// OnnoTelegramLoginAppDelegate (registered as an Expo AppDelegate subscriber) which forwards the URL
// to `TelegramLogin.handle(_:)`.
//
// Promise contract (consumed by src/auth/telegramLogin.ts):
//   resolve(["idToken": String, "viaWebFallback": Bool])
//   reject("ERR_TELEGRAM_CANCELLED", …)   — user dismissed the sheet
//   reject("ERR_TELEGRAM_UNAVAILABLE", …) — SDK not linked / not configured
//   reject("ERR_TELEGRAM_FAILED", …)      — anything else
//
// The `#if canImport(TelegramLogin)` guard keeps the module compiling even before the SPM package is
// added (it then reports "unavailable", so the app falls back to the server's web SSO flow).

public class OnnoTelegramLoginModule: Module {
  public func definition() -> ModuleDefinition {
    Name("OnnoTelegramLogin")

    AsyncFunction("login") { (options: [String: Any?], promise: Promise) in
      DispatchQueue.main.async {
        OnnoTelegramLoginModule.startLogin(options: options, promise: promise)
      }
    }
  }

  static func startLogin(options: [String: Any?], promise: Promise) {
    #if canImport(TelegramLogin)
    // Per-login overrides (which bot/ERP) take precedence over the build-time default, so one app can
    // sign in against many servers. `nonce` is reserved for replay protection; the current SDK doesn't
    // take one, so it's bound by the server rather than threaded through the SDK here.
    guard let cfg = TelegramLoginConfig.resolve(options: options) else {
      promise.reject("ERR_TELEGRAM_UNAVAILABLE", "Telegram login is not configured (no clientId from the server or app.json).")
      return
    }

    TelegramLoginConfig.configure(cfg)

    TelegramLogin.login { result in
      switch result {
      case .success(let loginData):
        promise.resolve(["idToken": loginData.idToken, "viaWebFallback": false])
      case .failure(let error):
        switch error {
        case .cancelled:
          promise.reject("ERR_TELEGRAM_CANCELLED", "The user cancelled Telegram sign-in.")
        default:
          promise.reject("ERR_TELEGRAM_FAILED", error.localizedDescription)
        }
      }
    }
    #else
    _ = options
    promise.reject(
      "ERR_TELEGRAM_UNAVAILABLE",
      "Telegram login SDK is not linked in this build. Add it via Swift Package Manager — see modules/onno-telegram-login/README.md."
    )
    #endif
  }
}

#if canImport(TelegramLogin)
/// Resolves the bot config — per-login overrides from JS first, then the build-time Info.plist
/// defaults — and (re)configures the SDK for that bot.
struct TelegramLoginConfig {
  let clientId: String
  let redirectUri: String
  let scopes: [String]

  private static var lastConfigured: String?

  /// Default redirect when neither JS nor Info.plist provides one: the custom scheme works for any bot.
  private static var defaultRedirectUri: String {
    let info = Bundle.main.infoDictionary
    if let r = info?["TelegramLoginRedirectUri"] as? String, !r.isEmpty { return r }
    if let s = info?["TelegramLoginCustomScheme"] as? String, !s.isEmpty { return "\(s)://tglogin" }
    return ""
  }

  static func resolve(options: [String: Any?]) -> TelegramLoginConfig? {
    let info = Bundle.main.infoDictionary
    let clientId = (options["clientId"] as? String)?.nonEmpty
      ?? (info?["TelegramLoginClientId"] as? String)?.nonEmpty
    guard let clientId else { return nil }

    let redirectUri = (options["redirectUri"] as? String)?.nonEmpty ?? defaultRedirectUri
    guard !redirectUri.isEmpty else { return nil }

    let scopes = (options["scopes"] as? [String])?.nonEmpty
      ?? (info?["TelegramLoginScopes"] as? [String])
      ?? ["profile"]
    return TelegramLoginConfig(clientId: clientId, redirectUri: redirectUri, scopes: scopes)
  }

  static func configure(_ cfg: TelegramLoginConfig) {
    // Reconfigure only when the bot actually changes (cheap idempotence across repeat logins).
    let key = "\(cfg.clientId)|\(cfg.redirectUri)|\(cfg.scopes.joined(separator: ","))"
    guard key != lastConfigured else { return }
    TelegramLogin.configure(clientId: cfg.clientId, redirectUri: cfg.redirectUri, scopes: cfg.scopes)
    lastConfigured = key
  }

  /// Configure from Info.plist if a default bot is set (used at app launch by the AppDelegate subscriber).
  static func configureFromInfoPlistIfPossible() {
    if let cfg = resolve(options: [:]) {
      configure(cfg)
    }
  }
}

private extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}

private extension Array where Element == String {
  var nonEmpty: [String]? { isEmpty ? nil : self }
}
#endif
