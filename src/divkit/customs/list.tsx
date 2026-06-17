// onec-list — a catalog/document browse list. The server emits a descriptor
// (columns, sort, searchability, routes); the widget fetches rows from
// GET /api/list/{kind}/{name} and renders a bordered, horizontally-scrollable
// table. Row tap opens onec://{kind}/{name}/{id}. Port of onec_list.dart.

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { Row } from '../../api/onecClient';
import { applyFormat, isAvatarWidget, isImageWidget, looksLikeImageUrl } from '../format';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { LucideIcon } from './lucide';

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

function OnecList({ desc, host }: { desc: Record<string, any>; host: DivHost }) {
  const c = colors(host.theme);
  const kind = (desc.kind as string) ?? 'catalogs';
  const name = (desc.name as string) ?? '';
  const pageSize = Number(desc.pageSize ?? 100);
  const searchable = desc.searchable === true;
  const newUrl = desc.newUrl as string | undefined;
  const columns: Col[] = Array.isArray(desc.columns) ? desc.columns : [];

  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortColumn, setSortColumn] = useState<string | null>(desc.sort?.column ?? null);
  const [sortDesc, setSortDesc] = useState<boolean>(desc.sort?.descending === true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load(reset: boolean, q = query, sc = sortColumn, sd = sortDesc) {
    reset ? setLoading(true) : setLoadingMore(true);
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
    }
  }

  useEffect(() => {
    load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, name]);

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

  const widths = columns.map((col, i) => colWidth(col, i === 0));
  const tableWidth = widths.reduce((a, b) => a + b, 0) + 24;
  const title = (desc.title as string) ?? name;

  return (
    <View>
      <Text style={{ fontSize: 22, fontWeight: '700', color: c.text }}>{title}</Text>
      {!loading && <Text style={{ color: c.muted, fontSize: 13 }}>{total} {total === 1 ? 'row' : 'rows'}</Text>}

      {searchable && (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: c.fieldBorder, borderRadius: 8, paddingHorizontal: 10, height: 40, backgroundColor: c.fieldBg }}>
            <LucideIcon name="search" size={16} color={c.muted} />
            <TextInput placeholder="Search…" placeholderTextColor={c.muted} style={{ flex: 1, fontSize: 14, color: c.text, paddingVertical: 0 }} onChangeText={onQuery} />
          </View>
          {newUrl && (
            <Pressable style={{ width: 44, height: 40, borderRadius: 8, backgroundColor: c.accentBg, alignItems: 'center', justifyContent: 'center' }} onPress={() => host.fire(newUrl)}>
              <LucideIcon name="plus" size={20} color={c.accentFg} />
            </Pressable>
          )}
        </View>
      )}

      {loading ? (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}><ActivityIndicator color={c.text} /></View>
      ) : error ? (
        <View style={{ alignItems: 'center', paddingVertical: 32, gap: 10 }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>Failed to load: {error}</Text>
          <Pressable style={{ backgroundColor: c.accentBg, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }} onPress={() => load(true)}>
            <Text style={{ color: c.accentFg, fontWeight: '600', fontSize: 13 }}>Retry</Text>
          </Pressable>
        </View>
      ) : rows.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: 32 }}><Text style={{ color: c.muted, fontSize: 13 }}>{query ? 'No matches.' : 'No records.'}</Text></View>
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
            <View style={{ width: tableWidth }}>
              <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.border }}>
                {columns.map((col, i) => (
                  <Pressable key={i} style={{ width: widths[i], flexDirection: 'row', alignItems: 'center' }} onPress={() => toggleSort(col.columnName)}>
                    <Text style={{ fontSize: 12, color: c.muted, fontWeight: '500', flexShrink: 1 }} numberOfLines={1}>{col.label ?? col.columnName}</Text>
                    <LucideIcon name={sortColumn !== col.columnName ? 'chevrons-up-down' : sortDesc ? 'arrow-down' : 'arrow-up'} size={13} color={c.muted} />
                  </Pressable>
                ))}
              </View>
              {rows.map((row, r) => (
                <Pressable
                  key={r}
                  style={{ flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: r < rows.length - 1 ? 1 : 0, borderBottomColor: c.border }}
                  onPress={() => { if (row._id != null) host.fire(`onec://${kind}/${name}/${row._id}`); }}
                >
                  {columns.map((col, i) => (
                    <View key={i} style={{ width: widths[i], paddingRight: 12 }}>
                      <Cell row={row} col={col} first={i === 0} c={c} baseUrl={host.baseUrl} />
                    </View>
                  ))}
                </Pressable>
              ))}
            </View>
          </ScrollView>
          {rows.length < total && (
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              {loadingMore ? (
                <ActivityIndicator color={c.text} />
              ) : (
                <Pressable style={{ backgroundColor: c.accentBg, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }} onPress={() => load(false)}>
                  <Text style={{ color: c.accentFg, fontWeight: '600', fontSize: 13 }}>Load more ({total - rows.length})</Text>
                </Pressable>
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
  return (
    <Text numberOfLines={1} style={{ fontSize: 14, color: isRef ? c.primary : first ? c.text : c.muted, fontWeight: first ? '500' : '400' }}>
      {cellText(row, col)}
    </Text>
  );
}

export const onecList: CustomRenderer = ({ block, host }) => {
  const desc = (block.custom_props?.list as Record<string, any>) ?? {};
  return <OnecList desc={desc} host={host} />;
};
