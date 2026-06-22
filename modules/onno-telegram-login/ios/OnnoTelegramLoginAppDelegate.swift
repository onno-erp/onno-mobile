import ExpoModulesCore

#if canImport(TelegramLogin)
import TelegramLogin
#endif

// Delivers the Telegram login redirect to the SDK.
//
// Telegram redirects to the app via the hosted Universal Link `https://app{appid}-login.tg.dev`
// (and/or the optional custom scheme), which lands in the AppDelegate. Expo fans `UIApplicationDelegate`
// callbacks out to registered subscribers, so we implement the URL-open and Universal-Link entry points
// and forward to `TelegramLogin.handle(_:)`, which completes the in-flight `TelegramLogin.login { … }`
// started by OnnoTelegramLoginModule.
//
// We claim only URLs that match our configured redirect (the tg.dev host or the custom scheme) so we
// don't swallow unrelated deep links. Registered via expo-module.config.json → apple.appDelegateSubscribers.

public class OnnoTelegramLoginAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // Configure the SDK as early as possible so a callback arriving right after launch is handled.
    #if canImport(TelegramLogin)
    TelegramLoginConfig.configureFromInfoPlistIfPossible()
    #endif
    return true
  }

  // Custom-scheme callback (yourapp://tglogin) and any direct open.
  public func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return Self.handleIfTelegram(url)
  }

  // Universal Link callback (https://app{appid}-login.tg.dev).
  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard
      userActivity.activityType == NSUserActivityTypeBrowsingWeb,
      let url = userActivity.webpageURL
    else {
      return false
    }
    return Self.handleIfTelegram(url)
  }

  /// Forward the URL to the SDK only when it's a Telegram redirect; returns whether we claimed it.
  /// Matches ANY `…-login.tg.dev` Universal Link (so multiple bots/ERPs work) or our custom scheme.
  private static func handleIfTelegram(_ url: URL) -> Bool {
    #if canImport(TelegramLogin)
    let customScheme = Bundle.main.infoDictionary?["TelegramLoginCustomScheme"] as? String

    let matchesUniversal = (url.host?.hasSuffix("-login.tg.dev")) ?? false
    let matchesScheme = customScheme != nil && url.scheme?.lowercased() == customScheme?.lowercased()
    guard matchesUniversal || matchesScheme else {
      return false
    }
    TelegramLogin.handle(url)
    return true
    #else
    return false
    #endif
  }
}
