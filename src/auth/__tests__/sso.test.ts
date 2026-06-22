import { resolveSsoTap } from '../sso';

const SERVER = 'https://erp.example.com';
const TG_START = '/api/auth/telegram/start';

describe('resolveSsoTap — the SSO button tap branch', () => {
  it('runs the native SDK for Telegram on a native platform when the module is linked', () => {
    const tap = resolveSsoTap({
      id: 'telegram',
      to: TG_START,
      serverUrl: SERVER,
      platform: 'ios',
      telegramAvailable: true,
    });
    expect(tap).toEqual({ kind: 'telegram-native', fallbackHref: `${SERVER}${TG_START}` });
  });

  it('runs the native SDK on Android too', () => {
    const tap = resolveSsoTap({
      id: 'telegram',
      to: TG_START,
      serverUrl: SERVER,
      platform: 'android',
      telegramAvailable: true,
    });
    expect(tap).toMatchObject({ kind: 'telegram-native' });
  });

  it('opens the server startUrl in the browser for Telegram on web', () => {
    const tap = resolveSsoTap({
      id: 'telegram',
      to: TG_START,
      serverUrl: SERVER,
      platform: 'web',
      telegramAvailable: false,
    });
    expect(tap).toEqual({ kind: 'web', href: `${SERVER}${TG_START}` });
  });

  it('falls back to the web flow on native when the module is NOT linked (e.g. Expo Go)', () => {
    const tap = resolveSsoTap({
      id: 'telegram',
      to: TG_START,
      serverUrl: SERVER,
      platform: 'ios',
      telegramAvailable: false,
    });
    expect(tap).toEqual({ kind: 'web', href: `${SERVER}${TG_START}` });
  });

  it('never hijacks a non-Telegram provider — uses the OIDC path when there is no startUrl', () => {
    const tap = resolveSsoTap({
      id: 'google',
      to: null,
      serverUrl: SERVER,
      platform: 'ios',
      telegramAvailable: true,
    });
    expect(tap).toEqual({ kind: 'web', href: `${SERVER}/oauth2/authorization/google` });
  });

  it('trims a trailing slash on the server url when building the href', () => {
    const tap = resolveSsoTap({
      id: 'telegram',
      to: TG_START,
      serverUrl: 'https://erp.example.com/',
      platform: 'web',
      telegramAvailable: false,
    });
    expect(tap).toEqual({ kind: 'web', href: `${SERVER}${TG_START}` });
  });

  it('returns null when there is nothing to open (no id, no startUrl)', () => {
    const tap = resolveSsoTap({
      id: '',
      to: null,
      serverUrl: SERVER,
      platform: 'ios',
      telegramAvailable: true,
    });
    expect(tap).toBeNull();
  });
});
