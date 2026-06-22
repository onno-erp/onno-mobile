// HTTP client for one Onno server — a TypeScript port of the Flutter client's
// HTTP client, trimmed to what the RN app needs so far (auth + DivKit
// card fetch).
//
// CSRF: the server sets a non-HttpOnly `XSRF-TOKEN` cookie and requires it
// echoed as `X-XSRF-TOKEN` on every mutating request. Native fetch manages the
// (HttpOnly) session cookie automatically. Reading the token back is the hard part:
// on Android/web we can scrape it from the `Set-Cookie` response header (see
// captureCsrf), but iOS never exposes Set-Cookie to JS and there is no
// `document.cookie` — so we fetch the token from `GET /api/auth/csrf` (see
// ensureCsrf), which works on every platform without a native cookie module.

import { toast } from '../ui/toast';
import { saveCredentials } from './credentials';

export interface AuthUser {
  authenticated: boolean;
  username: string;
  roles: string[];
}

/** One app setting, backed by a framework `@Constant`. Booleans carry widget "switch". */
export interface SettingMeta {
  name: string;
  displayName: string;
  type: string;
  widget: string;
  value: unknown;
}

/** The result of a server action/page-action handler: optional toast + navigate + refresh. */
export interface ActionResult {
  message?: string | null;
  navigate?: string | null;
  refresh?: boolean;
}

/** A stored-media reference returned by `POST /api/media` (see MediaController). */
export interface StoredMedia {
  key?: string;
  url: string;
  contentType?: string;
  size?: number;
  filename?: string | null;
}

/** A file to upload — RN's FormData accepts this `{ uri, name, type }` shape directly. */
export interface UploadFile {
  uri: string;
  name: string;
  type: string;
}

/** The profile `POST /api/auth/telegram/native` returns on a successful native Telegram sign-in. */
export interface TelegramNativeUser {
  id: string;
  username?: string;
  name?: string;
}

/**
 * Which Telegram bot this server signs in with. Returned (optionally) by `/native/begin` so a single
 * app can talk to many servers/ERPs, each with its own bot — the values are passed to the SDK at
 * runtime. `redirectUri` defaults to the app's custom scheme (works for any bot); a `app{appId}-login.tg.dev`
 * Universal Link only resolves if that domain was registered in the build (see the config plugin).
 */
export interface TelegramBotConfig {
  clientId?: string;
  redirectUri?: string;
  scopes?: string[];
}

export class OnnoAuthError extends Error {
  /** HTTP status that caused it — 401 = bad credentials, 403 = CSRF rejection, etc. Lets
   *  callers distinguish "these creds are wrong" (forget them) from a transient/CSRF failure. */
  constructor(message: string, public status?: number) {
    super(message);
  }
}
export class OnnoRequestError extends Error {
  constructor(public path: string, public status: number) {
    super(`Request to ${path} failed (HTTP ${status})`);
  }
}

/**
 * A failed mutating request. Carries the parsed JSON error body (`data`) so a form can read
 * `data.fieldErrors`, plus a readable `message` (server `message`/`error`, else a fallback) for
 * the toast. Mirrors the web client's `ApiError`.
 */
export class ApiError extends Error {
  constructor(public path: string, public status: number, public data?: any) {
    super((data && (data.message || data.error)) || `Request to ${path} failed (HTTP ${status})`);
  }
  /** Inline field-level validation errors (a 422), if any — shown by the form, not toasted. */
  get fieldErrors(): Record<string, string[]> | undefined {
    const fe = this.data?.fieldErrors;
    return fe && typeof fe === 'object' && Object.keys(fe).length ? fe : undefined;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class OnnoClient {
  private csrf: string | null = null;
  /** Per-server stale-while-revalidate cache for GET reads (content/list/rows).
   *  Lets a screen paint last-known data instantly; cleared on any successful
   *  mutating request so writes are always reflected. */
  private cache = new Map<string, { v: unknown; ts: number }>();
  /** Within this window a cached read is served WITHOUT revalidating — so quick
   *  back-and-forth navigation costs no network and no re-render. SSE pushes and
   *  local writes still force fresh data (the cache is cleared / refresh forced). */
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(public baseUrl: string) {}

  // ----- core -----

  private async request(
    path: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<Response> {
    const method = (opts.method ?? 'GET').toUpperCase();
    // Mutations must echo the CSRF token in a header. On iOS we can't read it from
    // the XSRF-TOKEN cookie (Set-Cookie is hidden from JS, no document.cookie), so
    // fetch it from /api/auth/csrf first when we don't already have one.
    if (MUTATING.has(method) && !this.csrf) await this.ensureCsrf();

    let res = await this.send(method, path, opts);
    // A 403 on a write is usually a missing/stale token (e.g. the session rotated).
    // Refetch once and retry before surfacing the failure.
    if (MUTATING.has(method) && res.status === 403) {
      await this.ensureCsrf();
      res = await this.send(method, path, opts);
    }

    // A successful write invalidates everything we've cached — drop it so the
    // next read revalidates against the server.
    if (MUTATING.has(method) && ok(res)) this.cache.clear();
    return res;
  }

  private async send(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined> },
  ): Promise<Response> {
    const url = this.baseUrl.replace(/\/$/, '') + path + queryString(opts.query);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (MUTATING.has(method) && this.csrf) headers['X-XSRF-TOKEN'] = this.csrf;

    const res = await fetch(url, {
      method,
      headers,
      credentials: 'include',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    this.captureCsrf(res);
    return res;
  }

  /**
   * Obtain the session's CSRF token. Browsers read it from the non-HttpOnly XSRF-TOKEN
   * cookie (see captureCsrf), but native fetch on iOS never exposes Set-Cookie, so we
   * ask the server for it via `GET /api/auth/csrf` (added in onno-auth-starter). Best
   * effort: on failure the pending mutation just fails loudly with the real error.
   */
  private async ensureCsrf(): Promise<void> {
    try {
      const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/api/auth/csrf', {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      this.captureCsrf(res); // Android/web: token may arrive via Set-Cookie too.
      if (ok(res)) {
        const data = (await res.json()) as { token?: string | null };
        if (data?.token) this.csrf = data.token;
      }
    } catch {
      /* offline / unreachable — the mutation that needs the token will report it */
    }
  }

  /**
   * Pull the rotating XSRF token out of the Set-Cookie response header(s).
   *
   * RN/fetch expose multi-valued Set-Cookie inconsistently — and this bites with
   * servers behind a load balancer that prepend their own cookie (e.g. an affinity
   * cookie) *before* XSRF-TOKEN. So we try every shape: the standard multi-value
   * `getSetCookie()`, the spec-merged single string, and RN's internal header map —
   * scanning each for the token rather than trusting one accessor.
   */
  private captureCsrf(res: Response): void {
    const h = res.headers as any;
    const sources: Array<string | null | undefined> = [];
    if (typeof h.getSetCookie === 'function') {
      try {
        sources.push(...h.getSetCookie());
      } catch {
        /* ignore */
      }
    }
    sources.push(res.headers.get('set-cookie'));
    if (h.map) sources.push(h.map['set-cookie']);
    for (const s of sources) {
      const m = s && s.match(/XSRF-TOKEN=([^;,\s]+)/);
      if (m) {
        this.csrf = m[1];
        return;
      }
    }
  }

  private async json<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const res = await this.request(path, { query });
    if (res.status !== 200) throw new OnnoRequestError(path, res.status);
    return (await res.json()) as T;
  }

  /**
   * Throw (and toast) when a mutating response failed. Parses the JSON error body into an
   * `ApiError`. Like the web's `fetchJson`, a 401 (lapsed session) and a field-level validation
   * 422 are NOT toasted — the form shows field errors inline; everything else surfaces a toast.
   */
  private async ensureOk(res: Response, path: string): Promise<void> {
    if (ok(res)) return;
    let data: any;
    try {
      data = await res.json();
    } catch {
      /* non-JSON / empty body */
    }
    const err = new ApiError(path, res.status, data);
    if (res.status !== 401 && !err.fieldErrors) toast.error(err.message);
    throw err;
  }

  // ----- auth -----

  async me(): Promise<AuthUser> {
    const res = await this.request('/api/auth/me');
    if (res.status === 200) return normalizeUser(await res.json());
    return { authenticated: false, username: '', roles: [] };
  }

  async login(username: string, password: string): Promise<AuthUser> {
    // Always re-seed the session + CSRF cookie immediately before the (mutating)
    // login POST, so the X-XSRF-TOKEN header and the cookie the OS sends are freshly
    // in sync — not a possibly-stale token captured earlier.
    await this.me();
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    if (res.status === 200) {
      const user = normalizeUser(await res.json());
      // Remember the credentials so the next launch can auto sign in (the session
      // cookie won't survive a relaunch on iOS). Centralized here so every login
      // path persists consistently — the native fallback form, the onno-login-form
      // custom on the server-driven card, and the auto-login replay on connect.
      await saveCredentials(this.baseUrl, username, password);
      return user;
    }
    if (res.status === 401) throw new OnnoAuthError('Invalid username or password', 401);
    // 403 here is a CSRF rejection (the server enforces it), not bad credentials —
    // it means the app couldn't read/echo the XSRF-TOKEN cookie for this server.
    if (res.status === 403) throw new OnnoAuthError('Security check failed (CSRF, HTTP 403) — the app couldn’t read this server’s XSRF-TOKEN cookie.', 403);
    throw new OnnoAuthError(`Login failed (HTTP ${res.status})`, res.status);
  }

  /**
   * Begin a native Telegram sign-in: `POST /api/auth/telegram/native/begin` → `{ nonce }` plus,
   * optionally, this server's bot config (`clientId` / `redirectUri` / `scopes`) so one app can sign in
   * against many servers/ERPs each with their own bot. The nonce is replay protection. Optional — older
   * servers may not expose it, so callers tolerate a failure here and fall back to the build-time default.
   */
  async telegramNativeBegin(): Promise<{ nonce: string | null } & TelegramBotConfig> {
    const res = await this.request('/api/auth/telegram/native/begin', { method: 'POST' });
    if (res.status !== 200) throw new OnnoAuthError(`Telegram begin failed (HTTP ${res.status})`, res.status);
    const data = (await res.json().catch(() => ({}))) as { nonce?: string | null } & TelegramBotConfig;
    return {
      nonce: data?.nonce ?? null,
      clientId: data?.clientId,
      redirectUri: data?.redirectUri,
      scopes: Array.isArray(data?.scopes) ? data.scopes.map(String) : undefined,
    };
  }

  /**
   * Complete a native Telegram sign-in: `POST /api/auth/telegram/native` with the SDK's `{ idToken }`.
   * On success (200) the response carries `{ id, username, name }` AND a Set-Cookie session that lands
   * in the shared cookie jar — so every later `/api/**` request via this client is authenticated. A 401
   * means the token was rejected; we surface the server's `error` code (`telegram_login_failed`).
   */
  async telegramNativeLogin(idToken: string): Promise<TelegramNativeUser> {
    const res = await this.request('/api/auth/telegram/native', { method: 'POST', body: { idToken } });
    if (res.status === 200) {
      const j = (await res.json().catch(() => ({}))) as any;
      return { id: String(j?.id ?? ''), username: j?.username ?? undefined, name: j?.name ?? undefined };
    }
    if (res.status === 401) {
      let code = 'telegram_login_failed';
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) code = String(j.error);
      } catch {
        /* non-JSON body — keep the default code */
      }
      throw new OnnoAuthError(code, 401);
    }
    throw new OnnoAuthError(`Telegram login failed (HTTP ${res.status})`, res.status);
  }

  async logout(): Promise<void> {
    // End the server session, but KEEP the saved credentials: returning to this
    // server from the picker then signs straight back in (the connect() replay
    // re-uses them) instead of stopping at the login screen. Forgetting a server's
    // credentials for good is the "remove server" path in the picker, which clears
    // them explicitly. Best-effort — we're leaving this server regardless.
    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore — the session is being abandoned either way */
    }
  }

  /**
   * The server-driven login screen as a DivKit card (`GET /api/divkit/login`). Public — it renders
   * before sign-in. Describes whatever this server offers: a password sub-form (the `onno-login-form`
   * custom) and/or one button per SSO provider. The client just renders + routes its actions.
   */
  loginCard(o: { theme?: 'light' | 'dark'; step?: string } = {}): Promise<{ templates?: Record<string, unknown>; card: unknown }> {
    return this.json('/api/divkit/login', { theme: o.theme ?? 'light', step: o.step });
  }

  // ----- read cache (stale-while-revalidate) -----

  private contentKey(path: string, o: { viewport?: string; theme?: string; profile?: string }): string {
    return `content|${o.viewport ?? 'mobile'}|${o.theme ?? 'light'}|${o.profile ?? ''}|${path}`;
  }
  private listKey(kind: string, name: string, o: { q?: string; limit?: number; offset?: number; sort?: string; descending?: boolean }): string {
    return `list|${kind}|${name}|q=${o.q ?? ''}|sort=${o.sort ?? ''}|dir=${o.sort ? (o.descending ? 'desc' : 'asc') : ''}|limit=${o.limit ?? 100}|offset=${o.offset ?? 0}`;
  }
  private rowsKey(kind: string, name: string, o: { from?: string; to?: string; registerPath?: string }): string {
    return `rows|${kind}|${name}|${o.registerPath ?? ''}|${o.from ?? ''}|${o.to ?? ''}`;
  }

  /** Synchronous cache reads — let a component paint last-known data on its first
   *  render. `undefined` = miss. */
  peekContent(path: string, o: { viewport?: string; theme?: string; profile?: string } = {}) {
    return this.cache.get(this.contentKey(path, o))?.v as { templates?: Record<string, unknown>; card: unknown } | undefined;
  }
  peekListRows(kind: string, name: string, o: { q?: string; limit?: number; offset?: number; sort?: string; descending?: boolean } = {}) {
    return this.cache.get(this.listKey(kind, name, o))?.v as { total: number; offset: number; rows: Row[] } | undefined;
  }
  peekRows(kind: string, name: string, o: { from?: string; to?: string; registerPath?: string } = {}) {
    return this.cache.get(this.rowsKey(kind, name, o))?.v as Row[] | undefined;
  }

  /** Whether a cached read is recent enough to skip revalidation (see CACHE_TTL_MS).
   *  Navigation/mount uses this to avoid the re-fetch + re-render churn on quick
   *  revisits; an explicit refresh ignores it. */
  private freshAt(key: string): boolean {
    const e = this.cache.get(key);
    return !!e && Date.now() - e.ts < OnnoClient.CACHE_TTL_MS;
  }
  freshContent(path: string, o: { viewport?: string; theme?: string; profile?: string } = {}) {
    return this.freshAt(this.contentKey(path, o));
  }
  freshListRows(kind: string, name: string, o: { q?: string; limit?: number; offset?: number; sort?: string; descending?: boolean } = {}) {
    return this.freshAt(this.listKey(kind, name, o));
  }
  freshRows(kind: string, name: string, o: { from?: string; to?: string; registerPath?: string } = {}) {
    return this.freshAt(this.rowsKey(kind, name, o));
  }

  /** Store a read result with a fresh timestamp. */
  private store(key: string, v: unknown): void {
    this.cache.set(key, { v, ts: Date.now() });
  }

  // ----- DivKit cards -----

  /** Content card for an app route. `/` → the dashboard (`/home`). */
  async content(
    path: string,
    o: { viewport?: string; theme?: string; profile?: string } = {},
  ): Promise<{ templates?: Record<string, unknown>; card: unknown }> {
    const isHome = path === '/' || path === '';
    const url = isHome ? '/api/divkit/home' : `/api/divkit${path}`;
    const env = await this.json<{ templates?: Record<string, unknown>; card: unknown }>(url, {
      viewport: o.viewport ?? 'mobile',
      theme: o.theme ?? 'light',
      profile: o.profile,
    });
    this.store(this.contentKey(path, o), env);
    return env;
  }

  /** Chrome card set: `{ navStyle, home, nav, account }`. */
  shell(o: { viewport?: string; theme?: string; profile?: string } = {}): Promise<{
    navStyle?: string;
    home?: string;
    nav?: { templates?: Record<string, unknown>; card: unknown };
    account?: { templates?: Record<string, unknown>; card: unknown };
  }> {
    return this.json('/api/divkit/shell', {
      viewport: o.viewport ?? 'mobile',
      theme: o.theme ?? 'light',
      profile: o.profile,
    });
  }

  /**
   * The deployment's branding (`GET /api/branding`): app name, logo, and the per-mode brand
   * palette. The palette carries only the slots the consumer overrode (e.g. vetovet → green
   * `primary`); absent slots fall back to the app defaults. Returns null on older servers (404)
   * so the caller just keeps the default theme.
   */
  async branding(): Promise<{
    appName?: string;
    logoUrl?: string;
    palette?: { light?: Record<string, string>; dark?: Record<string, string> };
  } | null> {
    try {
      return await this.json('/api/branding');
    } catch {
      return null;
    }
  }

  // ----- generic entity REST (used by the custom widgets) -----

  /** Paged list rows: `GET /api/list/{kind}/{name}` → `{ total, offset, rows }`. */
  async listRows(
    kind: string,
    name: string,
    o: { q?: string; limit?: number; offset?: number; sort?: string; descending?: boolean } = {},
  ): Promise<{ total: number; offset: number; rows: Row[] }> {
    const data = await this.json<any>(`/api/list/${kind}/${name}`, {
      limit: String(o.limit ?? 100),
      offset: String(o.offset ?? 0),
      q: o.q || undefined,
      sort: o.sort || undefined,
      dir: o.sort ? (o.descending ? 'desc' : 'asc') : undefined,
    });
    const result = {
      total: Number(data?.total ?? 0),
      offset: Number(data?.offset ?? o.offset ?? 0),
      rows: asRows(data?.rows),
    };
    this.store(this.listKey(kind, name, o), result);
    return result;
  }

  /** Full row set: `GET /api/{kind}/{name}` (or a register's movements/turnover). */
  async rows(
    kind: string,
    name: string,
    o: { from?: string; to?: string; registerPath?: string } = {},
  ): Promise<Row[]> {
    const path = o.registerPath ? `/api/registers/${name}/${o.registerPath}` : `/api/${kind}/${name}`;
    const res = await this.request(path, { query: { from: o.from, to: o.to } });
    if (res.status !== 200) throw new OnnoRequestError(path, res.status);
    const result = asRows(await res.json());
    this.store(this.rowsKey(kind, name, o), result);
    return result;
  }

  /** Typeahead for a ref picker: `GET /api/{kind}/{name}?q=&limit=`. */
  typeahead(kind: string, name: string, q: string, limit = 30): Promise<Row[]> {
    return this.json<any>(`/api/${kind}/${name}`, { q, limit: String(limit) }).then(asRows);
  }

  async createEntity(kind: string, name: string, body: Row): Promise<Row> {
    const res = await this.request(`/api/${kind}/${name}`, { method: 'POST', body });
    await this.ensureOk(res, `/api/${kind}/${name}`);
    return (await res.json()) as Row;
  }

  async updateEntity(kind: string, name: string, id: string, body: Row): Promise<Row> {
    const res = await this.request(`/api/${kind}/${name}/${id}`, { method: 'PUT', body });
    await this.ensureOk(res, `/api/${kind}/${name}/${id}`);
    return (await res.json()) as Row;
  }

  async deleteEntity(kind: string, name: string, id: string): Promise<void> {
    const res = await this.request(`/api/${kind}/${name}/${id}`, { method: 'DELETE' });
    await this.ensureOk(res, `/api/${kind}/${name}/${id}`);
  }

  async postDocument(name: string, id: string): Promise<void> {
    const res = await this.request(`/api/documents/${name}/${id}/post`, { method: 'POST' });
    await this.ensureOk(res, `/api/documents/${name}/${id}/post`);
  }

  async unpostDocument(name: string, id: string): Promise<void> {
    const res = await this.request(`/api/documents/${name}/${id}/unpost`, { method: 'POST' });
    await this.ensureOk(res, `/api/documents/${name}/${id}/unpost`);
  }

  /** Run a custom list/detail action: `POST /api/actions/{kind}/{name}/{key}[?id=]`. */
  async runAction(
    kind: string,
    name: string,
    key: string,
    o: { id?: string; inputs?: Row } = {},
  ): Promise<{ message?: string; navigate?: string; refresh?: boolean }> {
    const res = await this.request(`/api/actions/${kind}/${name}/${key}`, {
      method: 'POST',
      query: { id: o.id },
      body: { inputs: o.inputs },
    });
    await this.ensureOk(res, `/api/actions/${kind}/${name}/${key}`);
    const m = (await res.json()) as any;
    return { message: m?.message, navigate: m?.navigate, refresh: m?.refresh === true };
  }

  // ----- comments -----

  comments(kind: string, name: string, id: string): Promise<Row[]> {
    return this.json<any>(`/api/comments/${kind}/${name}/${id}`).then(asRows);
  }

  /** `@`-mention typeahead across every readable catalog/document: `GET /api/mentions?q=`.
   *  Each row is `{ kind, name, entity, id, display, avatarUrl }`. 404 when mentions are
   *  disabled — the composer just posts plain text in that case. */
  searchMentions(q: string): Promise<Row[]> {
    return this.json<any>('/api/mentions', { q }).then(asRows);
  }

  async addComment(kind: string, name: string, id: string, body: string): Promise<Row> {
    const res = await this.request(`/api/comments/${kind}/${name}/${id}`, {
      method: 'POST',
      body: { body },
    });
    await this.ensureOk(res, `/api/comments/${kind}/${name}/${id}`);
    return (await res.json()) as Row;
  }

  async deleteComment(commentId: string): Promise<void> {
    const res = await this.request(`/api/comments/${commentId}`, { method: 'DELETE' });
    await this.ensureOk(res, `/api/comments/${commentId}`);
  }

  // ----- app settings (framework @Constant values, admin-only — onno-constants) -----

  /** All editable app settings: `GET /api/settings`. */
  getSettings(): Promise<SettingMeta[]> {
    return this.json<any>('/api/settings').then((d) => (Array.isArray(d) ? (d as SettingMeta[]) : []));
  }

  /** Persist changed settings in place: `PUT /api/settings` with a `{ name: value }` map. */
  async saveSettings(values: Row): Promise<void> {
    const res = await this.request('/api/settings', { method: 'PUT', body: values });
    await this.ensureOk(res, '/api/settings');
  }

  // ----- page-level action buttons (PageBuilder.actions — onno-actions) -----

  /**
   * Run a page-level action button: `POST /api/divkit/page-action?route=&key=&profile=`. The server
   * resolves the handler by re-composing the page at `route`; the profile rides along so the same
   * page variant resolves.
   */
  async runPageAction(route: string, key: string, profile?: string, inputs?: Row): Promise<ActionResult> {
    const res = await this.request('/api/divkit/page-action', {
      method: 'POST',
      query: { route, key, profile },
      body: { inputs: inputs ?? {} },
    });
    await this.ensureOk(res, '/api/divkit/page-action');
    const m = (await res.json()) as any;
    return { message: m?.message, navigate: m?.navigate, refresh: m?.refresh === true };
  }

  // ----- binary uploads (image/file field widgets — onno-form media controls) -----

  /**
   * Stream a file to the framework's binary-upload endpoint (`POST /api/media`) and resolve to its
   * stored reference. The body is multipart/form-data — we deliberately leave Content-Type unset so
   * fetch writes the multipart boundary itself; the CSRF header rides along (a mutating request).
   * Callers persist the returned `url` rather than base64-ing bytes through a field.
   */
  async uploadMedia(file: UploadFile): Promise<StoredMedia> {
    if (!this.csrf) await this.me(); // seed the session + CSRF cookie before the mutating POST
    const form = new FormData();
    // RN's FormData takes a `{ uri, name, type }` part; the cast satisfies the DOM lib types.
    form.append('file', { uri: file.uri, name: file.name, type: file.type } as any);
    const headers: Record<string, string> = {};
    if (this.csrf) headers['X-XSRF-TOKEN'] = this.csrf;
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/api/media', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: form,
    });
    this.captureCsrf(res);
    await this.ensureOk(res, '/api/media');
    return (await res.json()) as StoredMedia;
  }
}

export type Row = Record<string, any>;

function ok(res: Response): boolean {
  return res.status >= 200 && res.status < 300;
}

function asRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === 'object') as Row[];
  return [];
}

function queryString(q?: Record<string, string | undefined>): string {
  if (!q) return '';
  const parts = Object.entries(q)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function normalizeUser(j: any): AuthUser {
  return {
    authenticated: j?.authenticated === true,
    username: j?.username ?? '',
    roles: Array.isArray(j?.roles) ? j.roles.map(String) : [],
  };
}
