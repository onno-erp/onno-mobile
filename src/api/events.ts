// Live UI updates over Server-Sent Events (the server's `GET /api/events`, a
// Spring SseEmitter that fans out EntityChangedEvents — see UiEventPublisher).
// The web SPA streams it via `fetch().body.getReader()`; React Native's fetch has
// no streaming body, so we read the growing `responseText` of an XMLHttpRequest
// instead (the same technique react-native-sse uses) — pure JS, Expo-Go friendly,
// and it shares the native cookie jar so the session rides along.

// Flip to false to silence the [sse] diagnostics once the stream is confirmed working.
const DEBUG = true;
function log(...args: unknown[]) {
  // eslint-disable-next-line no-console
  if (DEBUG) console.log('[sse]', ...args);
}

export interface UiEvent {
  type: string; // "ready" | "created" | "changed" | "deleted" | "posted" | "unposted" | …
  entityType?: string; // "catalog" | "document" | "register"
  entityName?: string; // logical name, e.g. "Bank Account"; "*" for "any register"
  id?: string;
  naturalKey?: string;
  timestamp?: string;
}

const RECONNECT_MS = 3000;
// Cap retained responseText: the stream is long-lived and XHR keeps the whole body
// in memory. Past this we recycle the connection (a fresh XHR resets the buffer).
const MAX_BUFFER = 512 * 1024;

/**
 * Open a resilient SSE stream to `{baseUrl}/api/events`, invoking `onEvent` for each
 * `data:` JSON payload. Auto-reconnects (fixed backoff) on drop. Returns a stop()
 * that aborts the stream and cancels any pending reconnect.
 */
export function subscribeUiEvents(baseUrl: string, onEvent: (e: UiEvent) => void): () => void {
  const url = baseUrl.replace(/\/$/, '') + '/api/events';
  let stopped = false;
  let xhr: XMLHttpRequest | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;

  function scheduleReconnect(why: string) {
    if (stopped || retry) return; // dedupe: onload/onerror/onabort can all fire
    log('disconnected —', why, '— reconnecting in', RECONNECT_MS, 'ms');
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, RECONNECT_MS);
  }

  function connect() {
    if (stopped) return;
    attempts += 1;
    log('connecting', url, attempts > 1 ? `(attempt ${attempts})` : '');
    let offset = 0; // how much of responseText we've already parsed
    let buffer = ''; // unparsed remainder (a partial SSE frame)
    let loggedStatus = false;

    const x = new XMLHttpRequest();
    xhr = x;
    x.open('GET', url, true);
    x.setRequestHeader('Accept', 'text/event-stream');
    x.setRequestHeader('Cache-Control', 'no-cache');
    x.withCredentials = true; // carry the session cookie

    const consume = () => {
      if (!loggedStatus && x.readyState >= 2) {
        loggedStatus = true;
        log('HTTP', x.status, x.statusText || '');
        if (x.status && (x.status < 200 || x.status >= 300)) {
          // 401/403 here = the stream couldn't authenticate (session/CSRF) — the
          // events will never flow until that's fixed. Surface it loudly.
          log('stream not authorized — the session cookie did not ride along');
        }
      }
      const text = x.responseText;
      if (!text || text.length <= offset) return;
      // Normalize CRLF and append only the newly-arrived slice.
      buffer += text.slice(offset).replace(/\r\n/g, '\n');
      offset = text.length;

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // SSE: keep only `data:` lines (drop the `event:` name and `:keepalive` comments).
        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!payload) continue;
        try {
          const ev = JSON.parse(payload) as UiEvent;
          log('event', JSON.stringify(ev));
          if (!stopped) onEvent(ev);
        } catch {
          log('unparseable frame', JSON.stringify(frame));
        }
      }

      // Recycle a stream that has accumulated too much text (keepalives add up).
      if (offset > MAX_BUFFER) {
        log('buffer cap reached — recycling connection');
        try { x.abort(); } catch { /* noop */ }
      }
    };

    x.onreadystatechange = () => {
      // 3 = LOADING (data arriving incrementally), 4 = DONE
      if (x.readyState >= 2) consume();
    };
    x.onprogress = consume; // some RN versions deliver chunks via progress only
    x.onerror = () => scheduleReconnect('xhr error');
    x.onabort = () => scheduleReconnect('aborted'); // our MAX_BUFFER recycle (stop() sets `stopped` first)
    x.onload = () => scheduleReconnect('stream closed'); // server closed the stream → reconnect

    try {
      x.send();
    } catch (e) {
      scheduleReconnect('send threw: ' + String(e));
    }
  }

  connect();

  return () => {
    stopped = true;
    log('unsubscribed');
    if (retry) clearTimeout(retry);
    try { xhr?.abort(); } catch { /* noop */ }
  };
}

// ----- in-process fan-out (the RN stand-in for the web's `window` "onno:dataevent") -----
// One SSE stream lives in App; data-driven customs (onno-list, onno-widget) can't see it,
// so App re-publishes every event here and those widgets subscribe to self-refresh. Without
// this, reloading the content card doesn't touch a list/widget that fetches its own rows
// (its mount effect never re-runs — the card keeps the same React key across a reload).

type UiEventHandler = (event: UiEvent) => void;
const busHandlers = new Set<UiEventHandler>();

/** Fan a received event out to every subscribed widget. Called by App's SSE handler. */
export function publishUiEvent(event: UiEvent): void {
  for (const h of busHandlers) {
    try {
      h(event);
    } catch {
      /* a bad subscriber must not break the fan-out */
    }
  }
}

/** Subscribe to fanned-out events. Returns an unsubscribe. */
export function onUiEvent(handler: UiEventHandler): () => void {
  busHandlers.add(handler);
  return () => busHandlers.delete(handler);
}

/**
 * Does an event touch a specific entity (kind = catalogs|documents|registers, `name` = the
 * route/snake name the widget loads)? Used by self-fetching widgets — the entity-scoped
 * counterpart of the route-scoped `affectsSurface`. Mirrors the web's `eventMatches`.
 */
export function eventMatchesEntity(event: UiEvent, kind: string, name: string): boolean {
  if (!event || event.type === 'ready') return false;
  const typeOk =
    (kind === 'registers' && event.entityType === 'register') ||
    (kind === 'documents' && event.entityType === 'document') ||
    (kind === 'catalogs' && event.entityType === 'catalog');
  if (!typeOk) return false;
  const ename = event.entityName ?? '';
  if (ename === '*') return true;
  // Robust to either naming form: the list passes the route name ("properties"),
  // a widget may pass the logical name ("Properties"). Compare both raw and snaked.
  return ename === name || toSnake(ename) === name || toSnake(ename) === toSnake(name);
}

// Mirror of the server's UiLayoutResolver.toSnakeCase: nav routes use the snake-cased
// logical name ("Bank Accounts" -> "bank_accounts"), so SSE events match the same way.
function toSnake(name: string): string {
  const s = name.replace(/ /g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch >= 'A' && ch <= 'Z' && i > 0) out += '_';
    out += ch.toLowerCase();
  }
  return out;
}

/**
 * Does a server event touch the surface the client is currently showing? The mobile
 * client renders one content card at a time (no islands), so unlike the web we also
 * refresh 2-segment list surfaces — the list is part of the card we reload. The home
 * dashboard aggregates many entities, so any data change refreshes it.
 */
export function affectsSurface(event: UiEvent, route: string): boolean {
  if (!event || event.type === 'ready') return false;
  // Comment-thread changes live-sync through the comments widget's own listener and never
  // alter a list/detail/dashboard surface — keep them off the content refetch path, else
  // every comment post would needlessly reload the dashboard (which refreshes on any change).
  if (event.entityType === 'comment') return false;
  if (route === '/' || route === '') return true;

  const seg = route.split('/').filter(Boolean); // ["documents","bills",...]
  const kind = seg[0]; // catalogs | documents | registers
  const name = seg[1];
  if (!kind || !name) return false;
  const ename = event.entityName ?? '';

  if (kind === 'registers') {
    // Posting emits ("changed","register","*"); any register surface should refresh.
    return event.entityType === 'register' && (ename === '*' || toSnake(ename) === name);
  }
  if (kind === 'documents') {
    return event.entityType === 'document' && toSnake(ename) === name;
  }
  if (kind === 'catalogs') {
    return event.entityType === 'catalog' && toSnake(ename) === name;
  }
  return false;
}
