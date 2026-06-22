// Expo config plugin for the native "Login with Telegram" flow (modules/onno-telegram-login).
//
// One app, many bots/ERPs. WHICH bot a sign-in uses (clientId/redirectUri/scopes) is chosen at
// RUNTIME — the server returns it from /api/auth/telegram/native/begin. But the OS only routes a
// redirect back to this binary if the redirect mechanism was registered at BUILD time, which is what
// this plugin does:
//
//   • Custom scheme (always) — `{iosCustomScheme}://tglogin`. NOT domain-bound, so it works for ANY
//     bot registered to this app's bundle id in @BotFather. This is the multi-tenant baseline and the
//     default runtime redirect.
//   • Universal Links / verified App Links (optional) — for each id in `universalLinkAppIds`, register
//     `app{id}-login.tg.dev`. Nicer UX/security, but only for the finite set of bots you list here.
//   • A single-tenant default bot (optional) — `defaultClientId` / `defaultAppId` baked into
//     Info.plist / manifest as the fallback when the server doesn't send per-bot config.
//
// Usage (app.json):
//   ["./plugins/withTelegramLogin", {
//     "iosCustomScheme": "onno-telegram",
//     "universalLinkAppIds": ["123456", "789012"],
//     "defaultClientId": "",
//     "defaultAppId": "",
//     "scopes": ["profile"]
//   }]
//
// No secrets — clientId/appId/redirect are public; the bot token + signing secrets live with
// @BotFather and the server.

const {
  withInfoPlist,
  withEntitlementsPlist,
  withAndroidManifest,
  AndroidConfig,
} = require('@expo/config-plugins');

const TELEGRAM_QUERY_SCHEMES = ['tg', 'tgapi'];
const ANDROID_PATH = '/tglogin';

const domainFor = (appId) => `app${appId}-login.tg.dev`;
// iOS redirect is the bare domain; Android appends the path.
const iosRedirectFor = (appId) => `https://${domainFor(appId)}`;
const androidRedirectFor = (appId) => `https://${domainFor(appId)}${ANDROID_PATH}`;

function withIos(config, { customScheme, universalLinkAppIds, defaultClientId, defaultAppId, scopes }) {
  config = withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;

    // Build-time defaults the native module reads (runtime /native/begin overrides these per bot).
    plist.TelegramLoginClientId = defaultClientId || '';
    plist.TelegramLoginRedirectUri = defaultAppId ? iosRedirectFor(defaultAppId) : `${customScheme}://tglogin`;
    plist.TelegramLoginScopes = scopes;
    plist.TelegramLoginCustomScheme = customScheme;

    // canOpenURL("tg://…") allow-list.
    const queries = new Set(plist.LSApplicationQueriesSchemes || []);
    TELEGRAM_QUERY_SCHEMES.forEach((s) => queries.add(s));
    plist.LSApplicationQueriesSchemes = Array.from(queries);

    // The custom scheme — always registered (the any-bot redirect).
    const urlTypes = plist.CFBundleURLTypes || [];
    if (!urlTypes.some((t) => (t.CFBundleURLSchemes || []).includes(customScheme))) {
      urlTypes.push({ CFBundleURLName: 'onno.telegram.login', CFBundleURLSchemes: [customScheme] });
    }
    plist.CFBundleURLTypes = urlTypes;
    return cfg;
  });

  // Associated Domains for each Universal-Link bot you opt into.
  if (universalLinkAppIds.length) {
    config = withEntitlementsPlist(config, (cfg) => {
      const key = 'com.apple.developer.associated-domains';
      const domains = new Set(cfg.modResults[key] || []);
      universalLinkAppIds.forEach((id) => domains.add(`applinks:${domainFor(id)}`));
      cfg.modResults[key] = Array.from(domains);
      return cfg;
    });
  }

  return config;
}

function withAndroid(config, { customScheme, universalLinkAppIds, defaultClientId, defaultAppId, scopes }) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, 'TelegramLoginClientId', defaultClientId || '');
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(
      app,
      'TelegramLoginRedirectUri',
      defaultAppId ? androidRedirectFor(defaultAppId) : `${customScheme}://tglogin`,
    );
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, 'TelegramLoginScopes', scopes.join(','));
    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, 'TelegramLoginCustomScheme', customScheme);

    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
    activity['intent-filter'] = activity['intent-filter'] || [];

    // The custom scheme — always registered (the any-bot redirect). No autoVerify (not a web link).
    addIntentFilter(activity, { scheme: customScheme }, (f) =>
      (f.data || []).some((d) => d.$ && d.$['android:scheme'] === customScheme && !d.$['android:host']),
    );

    // Verified app links for each Universal-Link bot you opt into.
    universalLinkAppIds.forEach((id) => {
      const host = domainFor(id);
      addIntentFilter(
        activity,
        { scheme: 'https', host, pathPrefix: ANDROID_PATH, autoVerify: true },
        (f) => (f.data || []).some((d) => d.$ && d.$['android:host'] === host),
      );
    });
    return cfg;
  });
}

/** Append a VIEW/BROWSABLE intent-filter unless `exists` already finds an equivalent one. */
function addIntentFilter(activity, { scheme, host, pathPrefix, autoVerify }, exists) {
  if (activity['intent-filter'].some(exists)) return;
  const data = { 'android:scheme': scheme };
  if (host) data['android:host'] = host;
  if (pathPrefix) data['android:pathPrefix'] = pathPrefix;
  activity['intent-filter'].push({
    $: autoVerify ? { 'android:autoVerify': 'true' } : {},
    action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
    category: [
      { $: { 'android:name': 'android.intent.category.DEFAULT' } },
      { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
    ],
    data: [{ $: data }],
  });
}

/** @type {import('@expo/config-plugins').ConfigPlugin<{ iosCustomScheme?: string; universalLinkAppIds?: string[]; defaultClientId?: string; defaultAppId?: string; scopes?: string[] }>} */
const withTelegramLogin = (config, props = {}) => {
  const opts = {
    customScheme: (props.iosCustomScheme || 'onno-telegram').trim(),
    universalLinkAppIds: (props.universalLinkAppIds || []).map((s) => String(s).trim()).filter(Boolean),
    defaultClientId: (props.defaultClientId || '').trim(),
    defaultAppId: (props.defaultAppId || '').trim(),
    scopes: props.scopes && props.scopes.length ? props.scopes : ['profile'],
  };
  config = withIos(config, opts);
  config = withAndroid(config, opts);
  return config;
};

module.exports = withTelegramLogin;
