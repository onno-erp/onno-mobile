require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'OnnoTelegramLogin'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage'] || 'https://onno.su'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Telegram's official iOS login SDK ships only as a Swift Package. A CocoaPods pod (this one) can't
  # `import` an SPM package attached to the app target, so we wrap the SDK's git source as its own pod
  # (../../../vendor/TelegramLogin.podspec, wired into the Podfile by plugins/withTelegramLogin.js) and
  # depend on it here — which makes `#if canImport(TelegramLogin)` true where the bridge compiles. The
  # guard still lets the sources build (web fallback) if the TelegramLogin pod isn't present.
  s.dependency 'TelegramLogin'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
