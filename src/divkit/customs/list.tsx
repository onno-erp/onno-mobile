// onno-list — a catalog/document browse list. The server emits a descriptor
// (columns, sort, searchability, routes); the widget fetches rows from
// GET /api/list/{kind}/{name} and renders a bordered, horizontally-scrollable
// table. Row tap opens onno://{kind}/{name}/{id}. Port of the Flutter client's list custom.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Row } from '../../api/onnoClient';
import { applyFormat, isAvatarWidget, isImageWidget, looksLikeImageUrl } from '../format';
import { ContextMenuArea } from '../longPress';
import type { ContextMenuItem } from '../../ui/contextMenu';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { useLiveRefresh } from '../useLiveRefresh';
import { LucideIcon } from './lucide';
import { Touchable } from '../../ui/touchable';
import { geoSourceFrom, hasGeoSource, ListMapView } from './geo';

interface Col {
  columnName: string;
  label?: string;
  width?: string | number;
  widget?: string;
  format?: string;
}

function colWidth(col: Col, first: boolean): number {
  const w = col.width;
  if (typeof w === 'number') return w;
  if (typeof w === 'string') {
    const m = w.match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return first ? 170 : 150;
}

function cellText(row: Row, col: Col): string {
  const raw = row[col.columnName];
  if (raw === '__SECRET_SET__') return '•••• set';
  const display = row[`${col.columnName}_display`] ?? raw;
  if (display == null) return '';
  if (typeof display === 'boolean') return display ? 'Yes' : 'No';
  const text = String(display);
  if (text.startsWith('data:')) return '🖼';
  return applyFormat(text, col.format) ?? text;
}

// A custom list action declared by the server (desc.actions): `toolbar` (list-level) or
// `row` (per-record). A `server` action POSTs via onno://action/…; a navigate action routes
// its `url` (with `{id}` filled). Row actions can be tuned per-row via `row._actions[key]`.
interface ListAction {
  key: string;
  label: string;
  icon?: string;
  scope: 'toolbar' | 'row';
  server: boolean;
  url?: string;
  kind: string;
  name: string;
}

type ResolvedAction = { url: string; label: string; icon?: string; enabled: boolean };

/** Resolve a row action against the row's optional `_actions[key]` override; null when hidden. */
function resolveRowAction(a: ListAction, row: Row): ResolvedAction | null {
  const ov = (row._actions as Record<string, any> | undefined)?.[a.key];
  if (ov?.visible === false) return null;
  const id = row._id != null ? String(row._id) : '';
  const url = a.server ? `onno://action/${a.kind}/${a.name}/${a.key}/${id}` : (a.url ?? '').replace('{id}', id);
  return { url, label: ov?.label ?? a.label, icon: ov?.icon ?? a.icon, enabled: ov?.enabled !== false };
}

/** The action url for a toolbar (list-level, no row) action. */
function toolbarActionUrl(a: ListAction): string {
  return a.server ? `onno://action/${a.kind}/${a.name}/${a.key}` : a.url ?? '';
}

function OnnoList({ desc, host }: { desc: Record<string, any>; host: DivHost }) {
  const c = colors(host.theme);
  const kind = (desc.kind as string) ?? 'catalogs';
  const name = (desc.name as string) ?? '';
  const pageSize = Number(desc.pageSize ?? 100);
  const searchable = desc.searchable === true;
  const newUrl = desc.newUrl as string | undefined;
  const columns: Col[] = Array.isArray(desc.columns) ? desc.columns : [];
  // Custom server-declared actions: toolbar buttons (list header) + per-row actions
  // (inline trailing buttons + the long-press menu).
  const toolbarActions = useMemo<ListAction[]>(() => (Array.isArray(desc.actions) ? desc.actions : []).filter((a: ListAction) => a.scope === 'toolbar'), [desc.actions]);
  const rowActions = useMemo<ListAction[]>(() => (Array.isArray(desc.actions) ? desc.actions : []).filter((a: ListAction) => a.scope === 'row'), [desc.actions]);
  const actionColW = rowActions.length ? rowActions.length * 38 + 8 : 0;

  // Optional map view: the server attaches a `map` config (geo columns) to lists whose
  // records have a location. When present, offer a List/Map toggle (web: list.map).
  const mapCfg = desc.map && typeof desc.map === 'object' ? (desc.map as Record<string, any>) : null;
  const mapSource = useMemo(() => (mapCfg ? geoSourceFrom((k) => String(mapCfg[k] ?? '')) : null), [mapCfg]);
  const hasMap = !!mapSource && hasGeoSource(mapSource);
  const [view, setView] = useState<'table' | 'map'>(mapCfg?.defaultView ? 'map' : 'table');

  // Seed the first page from cache so a revisited list paints instantly; the
  // mount effect then revalidates it in the background (no full spinner).
  const seed = host.client.peekListRows(kind, name, {
    q: '',
    limit: pageSize,
    offset: 0,
    sort: desc.sort?.column ?? undefined,
    descending: desc.sort?.descending === true,
  });
  const [rows, setRows] = useState<Row[]>(() => seed?.rows ?? []);
  const [total, setTotal] = useState(() => seed?.total ?? 0);
  const [loading, setLoading] = useState(() => !seed);
  const [loadingMore, setLoadingMore] = useState(false);
  // Dim the table only for a user-initiated reload (sort/search); a background
  // revalidation refreshes silently (just the small header spinner).
  const [dimming, setDimming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(desc.sort?.column ?? null);
  const [sortDesc, setSortDesc] = useState<boolean>(desc.sort?.descending === true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(reset: boolean, q = query, sc = sortColumn, sd = sortDesc, background = false) {
    if (reset) {
      setLoading(true);
      if (!background) setDimming(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);
    try {
      const page = await host.client.listRows(kind, name, {
        q,
        limit: pageSize,
        offset: reset ? 0 : rows.length,
        sort: sc ?? undefined,
        descending: sd,
      });
      setRows((prev) => (reset ? page.rows : [...prev, ...page.rows]));
      setTotal(page.total);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setDimming(false);
    }
  }

  useEffect(() => {
    // Recently fetched → trust the seeded cache; skip the mount revalidation so a
    // quick revisit costs no network and no re-render. (SSE still refreshes below.)
    if (host.client.freshListRows(kind, name, { q: '', limit: pageSize, offset: 0, sort: desc.sort?.column ?? undefined, descending: desc.sort?.descending === true })) return;
    // Otherwise revalidate on mount; background so seeded rows refresh without dimming.
    load(true, query, sortColumn, sortDesc, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, name]);

  // Live updates: when a write to this entity arrives over SSE, refresh the visible
  // window in place (background — keeps rows on screen, just re-pulls them).
  useLiveRefresh(kind, name, () => load(true, query, sortColumn, sortDesc, true));

  function onQuery(q: string) {
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(true, q), 250);
  }

  function toggleSort(column: string) {
    let nextCol: string | null = column;
    let nextDesc = false;
    if (sortColumn === column) {
      if (!sortDesc) nextDesc = true;
      else { nextCol = null; nextDesc = false; }
    }
    setSortColumn(nextCol);
    setSortDesc(nextDesc);
    load(true, query, nextCol, nextDesc);
  }

  const widths = useMemo(() => columns.map((col, i) => colWidth(col, i === 0)), [columns]);
  const tableWidth = useMemo(() => widths.reduce((a, b) => a + b, 0) + 24 + actionColW, [widths, actionColW]);
  // Stable so memoized rows don't re-render as the list grows.
  const onOpen = useCallback(
    (row: Row) => {
      if (row._id != null) host.fire(`onno://${kind}/${name}/${row._id}`);
    },
    [host, kind, name],
  );
  // Warm the detail card on touch-down so it's usually ready by the time the tap lands.
  const onPrefetch = useCallback(
    (row: Row) => {
      if (row._id != null) host.prefetch?.(`onno://${kind}/${name}/${row._id}`);
    },
    [host, kind, name],
  );

  // Progressive render: paint the first chunk immediately, then reveal the rest a
  // chunk per frame, so mounting a long list never blocks the thread. Rows are
  // memoized (RowItem), so each frame only mounts the newly-revealed rows. A
  // re-mount (navigation) restarts from the first chunk — that's the whole point.
  const FIRST_PAINT = 12; // ≈ one screenful — rendered on the first frame for the fastest paint
  const STEP = 40; // then fill the rest in bigger batches so the list completes in a few frames
  const [limit, setLimit] = useState(FIRST_PAINT);
  useEffect(() => {
    if (limit >= rows.length) return;
    const raf = requestAnimationFrame(() => setLimit((n) => Math.min(n + STEP, rows.length)));
    return () => cancelAnimationFrame(raf);
  }, [limit, rows.length]);
  // A neutral row-press highlight (`surface` collapses into `card` in dark, so pick per theme).
  const rowPress = c.primarySoft;
  const title = (desc.title as string) ?? name;
  // First fetch (nothing to show yet) → full spinner. A re-sort/search of an
  // already-loaded list keeps its rows on screen and refreshes them in place.
  const initialLoading = loading && rows.length === 0;
  const reloading = loading && rows.length > 0;

  return (
    <View>
      <Text style={{ fontSize: 22, fontWeight: '700', color: c.text }}>{title}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 18 }}>
        {!initialLoading && <Text style={{ color: c.muted, fontSize: 13 }}>{total} {total === 1 ? 'row' : 'rows'}</Text>}
        {reloading && <ActivityIndicator size="small" color={c.muted} />}
      </View>

      {/* Toolbar (web parity): the Table/Map segmented control sits inline with the
          search box and New button. Search is table-only; a flex spacer keeps New
          right-aligned in map mode. */}
      {(hasMap || searchable || newUrl || toolbarActions.length > 0) && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
          {hasMap && (
            <View style={{ flexDirection: 'row', height: 40, alignItems: 'center', borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface, padding: 2 }}>
              {(['table', 'map'] as const).map((v) => {
                const active = view === v;
                return (
                  <Touchable
                    key={v}
                    onPress={() => setView(v)}
                    style={{
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 38,
                      height: 32,
                      borderRadius: 6,
                      backgroundColor: active ? c.card : 'transparent',
                      ...(active ? { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 } : null),
                    }}
                  >
                    <LucideIcon name={v === 'table' ? 'table-2' : 'map'} size={16} color={active ? c.text : c.muted} />
                  </Touchable>
                );
              })}
            </View>
          )}
          {searchable && view === 'table' ? (
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 8, paddingHorizontal: 10, height: 40, backgroundColor: c.fieldBg }}>
              <LucideIcon name="search" size={16} color={c.muted} />
              <TextInput placeholder="Search…" placeholderTextColor={c.muted} style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 0 }} onChangeText={onQuery} />
            </View>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {toolbarActions.map((a) => (
            <Touchable
              key={a.key}
              onPress={() => host.fire(toolbarActionUrl(a))}
              style={{ width: 44, height: 40, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' }}
            >
              <LucideIcon name={a.icon || 'zap'} size={18} color={c.text} />
            </Touchable>
          ))}
          {newUrl && (
            <Touchable style={{ width: 44, height: 40, borderRadius: 8, backgroundColor: c.accentBg, alignItems: 'center', justifyContent: 'center' }} onPress={() => host.fire(newUrl)}>
              <LucideIcon name="plus" size={20} color={c.accentFg} />
            </Touchable>
          )}
        </View>
      )}

      {view === 'map' && hasMap && mapSource ? (
        <ListMapView kind={kind} name={name} source={mapSource} labelField={mapCfg?.labelField} host={host} />
      ) : initialLoading ? (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}><ActivityIndicator color={c.text} /></View>
      ) : error ? (
        <View style={{ alignItems: 'center', paddingVertical: 32, gap: 10 }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>Failed to load: {error}</Text>
          <Touchable style={{ backgroundColor: c.accentBg, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }} onPress={() => load(true)}>
            <Text style={{ color: c.accentFg, fontWeight: '600', fontSize: 13 }}>Retry</Text>
          </Touchable>
        </View>
      ) : rows.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}><Text style={{ color: c.muted, fontSize: 13 }}>{query ? 'No matches.' : 'No records.'}</Text></View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
            <View style={{ width: tableWidth, opacity: dimming ? 0.5 : 1 }} pointerEvents={dimming ? 'none' : 'auto'}>
              <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
                {columns.map((col, i) => (
                  <Touchable key={i} style={{ width: widths[i], flexDirection: 'row', alignItems: 'center' }} onPress={() => toggleSort(col.columnName)}>
                    <Text style={{ fontSize: 12, color: c.muted, fontWeight: '500', flexShrink: 1 }} numberOfLines={1}>{col.label ?? col.columnName}</Text>
                    <LucideIcon name={sortColumn !== col.columnName ? 'chevrons-up-down' : sortDesc ? 'arrow-down' : 'arrow-up'} size={13} color={c.muted} />
                  </Touchable>
                ))}
                {actionColW > 0 ? <View style={{ width: actionColW }} /> : null}
              </View>
              {rows.slice(0, limit).map((row, r) => (
                <RowItem
                  key={r}
                  row={row}
                  columns={columns}
                  widths={widths}
                  c={c}
                  baseUrl={host.baseUrl}
                  rowPress={rowPress}
                  last={r === rows.length - 1}
                  onOpen={onOpen}
                  onPrefetch={onPrefetch}
                  host={host}
                  rowUrl={row._id != null ? `onno://${kind}/${name}/${row._id}` : undefined}
                  rowActions={rowActions}
                  actionColW={actionColW}
                />
              ))}
            </View>
          </ScrollView>
          {rows.length < total && (
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              {loadingMore ? (
                <ActivityIndicator color={c.text} />
              ) : (
                <Touchable style={{ backgroundColor: c.accentBg, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }} onPress={() => load(false)}>
                  <Text style={{ color: c.accentFg, fontWeight: '600', fontSize: 13 }}>Load more ({total - rows.length})</Text>
                </Touchable>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );
}

function Cell({ row, col, first, c, baseUrl }: { row: Row; col: Col; first: boolean; c: ThemeColors; baseUrl?: string }) {
  if (col.columnName === '_posted') {
    const posted = row._posted === true;
    return (
      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, alignSelf: 'flex-start', backgroundColor: posted ? c.successBg : c.surface }}>
        <Text style={{ fontSize: 11, fontWeight: '500', color: posted ? c.successFg : c.muted }}>{posted ? 'Posted' : 'Draft'}</Text>
      </View>
    );
  }
  if (isImageWidget(col.widget)) {
    const v = String(row[`${col.columnName}_display`] ?? row[col.columnName] ?? '');
    if (looksLikeImageUrl(v)) {
      const uri = v.startsWith('/') ? `${baseUrl ?? ''}${v}` : v;
      const dim = isAvatarWidget(col.widget) ? 28 : 40;
      return <Image source={{ uri }} style={{ width: dim, height: dim, borderRadius: isAvatarWidget(col.widget) ? dim / 2 : 6 }} />;
    }
  }
  const isRef = Object.prototype.hasOwnProperty.call(row, `${col.columnName}_ref`);
  const text = (
    <Text numberOfLines={1} style={{ fontSize: 14, color: isRef ? c.primary : first ? c.text : c.muted, fontWeight: first ? '500' : '400' }}>
      {cellText(row, col)}
    </Text>
  );
  // A Ref to an entity with an avatar: the server resolves it to `{col}_avatar`
  // (a URL) on the row. Draw it as a small round photo beside the display text.
  const avatar = row[`${col.columnName}_avatar`];
  if (typeof avatar === 'string' && looksLikeImageUrl(avatar)) {
    const uri = avatar.startsWith('/') ? `${baseUrl ?? ''}${avatar}` : avatar;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Image source={{ uri }} style={{ width: 24, height: 24, borderRadius: 12 }} />
        {text}
      </View>
    );
  }
  return text;
}

// A single table row. Memoized so progressive reveal (and any list re-render)
// only mounts newly-added rows — all props are referentially stable per row.
const RowItem = React.memo(function RowItem({
  row,
  columns,
  widths,
  c,
  baseUrl,
  rowPress,
  last,
  onOpen,
  onPrefetch,
  host,
  rowUrl,
  rowActions,
  actionColW,
}: {
  row: Row;
  columns: Col[];
  widths: number[];
  c: ThemeColors;
  baseUrl?: string;
  rowPress: string;
  last: boolean;
  onOpen: (row: Row) => void;
  onPrefetch: (row: Row) => void;
  host: DivHost;
  rowUrl?: string;
  rowActions: ListAction[];
  actionColW: number;
}) {
  // The record's actions (post/edit/custom…), resolved against this row's per-row state.
  const resolved = useMemo(
    () => rowActions.map((a) => resolveRowAction(a, row)).filter((r): r is ResolvedAction => r != null),
    [rowActions, row],
  );
  // The same actions feed the long-press menu (alongside Open / Share / Copy link).
  const extraItems = useMemo<ContextMenuItem[]>(
    () => resolved.filter((r) => r.enabled).map((r) => ({ label: r.label, icon: r.icon, onPress: () => host.fire(r.url) })),
    [resolved, host],
  );

  // Long-press a row = the web's right-click on a record: Open, its actions, Share, Copy
  // link, Open in browser — slide-to-select like an iOS context menu. The same actions
  // also sit inline as a trailing button column.
  return (
    <ContextMenuArea host={host} url={rowUrl} extraItems={extraItems}>
      <Pressable
        // Fixed minHeight + centered content so a row with an action button is the same
        // height as a text-only one (the button defines the height; padding is trimmed to fit).
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border, backgroundColor: pressed ? rowPress : 'transparent' })}
        android_ripple={{ color: rowPress }}
        onPress={() => onOpen(row)}
        onPressIn={() => onPrefetch(row)}
      >
        {columns.map((col, i) => (
          <View key={i} style={{ width: widths[i], paddingRight: 12 }}>
            <Cell row={row} col={col} first={i === 0} c={c} baseUrl={baseUrl} />
          </View>
        ))}
        {actionColW > 0 ? (
          <View style={{ width: actionColW, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
            {resolved.map((r, i) => (
              <Touchable
                key={i}
                disabled={!r.enabled}
                hitSlop={8}
                onPress={() => host.fire(r.url)}
                style={{ width: 32, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', opacity: r.enabled ? 1 : 0.4 }}
              >
                <LucideIcon name={r.icon || 'zap'} size={18} color={c.primary} />
              </Touchable>
            ))}
          </View>
        ) : null}
      </Pressable>
    </ContextMenuArea>
  );
});

export const onnoList: CustomRenderer = ({ block, host }) => {
  const desc = (block.custom_props?.list as Record<string, any>) ?? {};
  return <OnnoList desc={desc} host={host} />;
};
