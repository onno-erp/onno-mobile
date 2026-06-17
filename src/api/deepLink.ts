// Deep-link parsing for "open the app pointed at a server". Two OS mechanisms
// feed this, both ultimately producing a base URL to hand to `connectTo`:
//
//   1. Custom scheme   onec://connect?url=https://acme.cloud.onno.su
//      Works for ANY server (cloud or self-hosted) with zero per-server setup —
//      typically minted as a QR on the server's web login page. Anyone can mint
//      one, so it's UNTRUSTED: the caller confirms before connecting to a server
//      the user hasn't already saved.
//
//   2. Universal / App Link   https://acme.cloud.onno.su  (a real https tap)
//      Only fires for `*.cloud.onno.su`, the parent domain we own and register
//      at build time. Because the OS only routes these after verifying the
//      domain association, they're inherently TRUSTED — connect without a prompt.
//
// Pure + framework-free so the routing in App.tsx stays a thin wiring layer.
// Kept regex-based (not `URL`) to match servers.ts — RN's URL polyfill is
// incomplete, but its URLSearchParams (used for query parsing) is fine.

import { normalizeUrl } from './servers';

/** The parent domain whose subdomains open via universal links (see issue #5). */
const CLOUD_PARENT = '.cloud.onno.su';

export interface ConnectIntent {
  /** Normalized base URL to point the app at (no trailing slash). */
  url: string;
  /**
   * Whether the link is inherently trusted. Universal links into our cloud are
   * (the OS verified the domain); `onec://connect?url=` links are not, so an
   * unknown target must be confirmed before a client is created for it.
   */
  trusted: boolean;
}

/**
 * A single-level `*.cloud.onno.su` subdomain — `acme.cloud.onno.su` but NOT the
 * bare root or a nested `a.b.cloud.onno.su` (matches the entitlement wildcard,
 * which only covers one level).
 */
function isCloudHost(host: string): boolean {
  if (!host.endsWith(CLOUD_PARENT)) return false;
  const sub = host.slice(0, -CLOUD_PARENT.length);
  return sub.length > 0 && !sub.includes('.');
}

/**
 * Parse an incoming OS deep link into a connect intent, or null if it isn't one
 * we handle. Tolerant of both encoded and bare `url=` values and of an optional
 * trailing slash after `connect`.
 */
export function parseDeepLink(raw: string | null | undefined): ConnectIntent | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  // 1) Custom scheme: onec://connect?url=<base>
  const connect = /^onec:\/\/connect\b(.*)$/i.exec(s);
  if (connect) {
    const q = connect[1].indexOf('?');
    if (q < 0) return null;
    const url = normalizeUrl(new URLSearchParams(connect[1].slice(q + 1)).get('url') ?? '');
    return url ? { url, trusted: false } : null;
  }

  // 2) Universal / App Link into our cloud. Connect to the link's own origin
  //    (scheme + host[:port]); any path is ignored since the app lands on '/'.
  const link = /^(https?):\/\/([^/?#]+)/i.exec(s);
  if (link) {
    const scheme = link[1].toLowerCase();
    const host = link[2].split(':')[0].toLowerCase();
    if (scheme === 'https' && isCloudHost(host)) {
      const url = normalizeUrl(`https://${link[2]}`);
      if (url) return { url, trusted: true };
    }
  }

  return null;
}
