# CocoaPods wrapper for Telegram's official iOS Login SDK.
#
# The SDK (https://github.com/TelegramMessenger/telegram-login-ios) ships ONLY as a Swift Package —
# a single-target, dependency-free pure-Swift source library. Our native bridge
# (modules/onno-telegram-login) compiles as a CocoaPods pod, and a pod can't `import` a Swift Package
# attached to the app target (that's why `#if canImport(TelegramLogin)` was always false). So we wrap
# the SDK's git source as its own pod module named `TelegramLogin`; the bridge pod then depends on it
# (see OnnoTelegramLogin.podspec) and `import TelegramLogin` / `canImport(TelegramLogin)` resolve.
#
# No source is vendored into this repo — CocoaPods clones Telegram's official repo at the tag below
# during `pod install`. Wired into the Podfile by plugins/withTelegramLogin.js (`pod 'TelegramLogin'`).
Pod::Spec.new do |s|
  s.name         = 'TelegramLogin'
  s.version      = '1.0.0'
  s.summary      = "Telegram's official iOS Login SDK, packaged from its SPM source as a CocoaPods module."
  s.description  = 'Wrapper pod that builds TelegramMessenger/telegram-login-ios (a Swift Package) so a CocoaPods pod can import it.'
  s.homepage     = 'https://github.com/TelegramMessenger/telegram-login-ios'
  s.license      = { :type => 'Proprietary', :text => 'Telegram Login SDK — © Telegram. See https://github.com/TelegramMessenger/telegram-login-ios' }
  s.author       = { 'Telegram' => 'https://telegram.org' }
  s.platform     = :ios, '15.0'
  s.swift_version = '5.7'
  s.source       = { :git => 'https://github.com/TelegramMessenger/telegram-login-ios.git', :tag => '1.0.0' }
  s.source_files = 'Sources/TelegramLogin/**/*.swift'
end
