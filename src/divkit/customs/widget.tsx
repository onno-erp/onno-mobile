// onno-widget — a dashboard tile. The server ships a descriptor
// (custom_props.widget); each widget fetches its own rows and renders. Port of
// the web SPA's widget-bridge.tsx + the per-type widget components. All types are
// rendered natively: list / stat / sparkline / gauge / chart (bar/line/area/
// donut/pie) / kanban / calendar.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import type { Row } from '../../api/onnoClient';
import {
  formatAmount,
  formatCompact,
  formatMonthDay,
  formatNumber,
  pickField,
  resolveCurrency,
  resolveText,
  splitFields,
  toNumber,
} from '../format';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { useLiveRefresh } from '../useLiveRefresh';
import {
  aggregate,
  buildSeries,
  numberOptions,
  SINGLE_SERIES,
  WidgetMeta,
  type GroupByDate,
  type Metric,
} from '../widgetData';
import { GaugeView, Legend, PieChartView, resolveColor, resolveColors, Sparkline, XYChart } from '../charts';
import { GeoMap, geoSourceFrom, hasGeoSource, shapesFromRow, type GeoShape } from './geo';
import { HintGlyph } from './icon';
import { LucideIcon } from './lucide';
import { Touchable } from '../../ui/touchable';

// ----- shared shell -----

function useRows(host: DivHost, meta: WidgetMeta) {
  const isRegister = meta.entityType === 'register';
  const kind = isRegister ? 'registers' : meta.kind;
  const opts = isRegister
    ? { registerPath: 'turnover', from: '1970-01-01T00:00:00', to: '2999-12-31T23:59:59' }
    : {};
  // Seed from cache so a revisited widget paints its last data immediately (no
  // loading flash); the effect then revalidates in the background.
  const [state, setState] = useState<{ rows: Row[] | null; error: string | null }>(() => ({
    rows: host.client.peekRows(kind, meta.entityName, opts) ?? null,
    error: null,
  }));
  const reload = useCallback(() => {
    let alive = true;
    host.client
      .rows(kind, meta.entityName, opts)
      .then((rows) => alive && setState({ rows, error: null }))
      // Keep any cached rows on a background-refresh failure; only error on a cold miss.
      .catch((e: any) => alive && setState((s) => (s.rows ? s : { rows: null, error: String(e?.message ?? e) })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, meta.entityName, JSON.stringify(opts)]);
  useEffect(() => {
    // Recently fetched → trust the cache; skip the mount refetch + re-render churn.
    if (host.client.freshRows(kind, meta.entityName, opts)) return;
    return reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);
  // Live updates: refetch when a write to this widget's entity arrives over SSE
  // (posting fans out a register "*" change, which matches register widgets too).
  useLiveRefresh(kind, meta.entityName, reload);
  return state;
}

function Card({
  meta,
  c,
  mutedTitle = false,
  right,
  children,
}: {
  meta: WidgetMeta;
  c: ThemeColors;
  mutedTitle?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <View style={{ backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 14, marginVertical: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          <Text
            style={mutedTitle ? { fontSize: 13, fontWeight: '500', color: c.muted } : { fontSize: 15, fontWeight: '600', color: c.text }}
            numberOfLines={1}
          >
            {meta.title}
          </Text>
          <HintGlyph text={meta.hint} c={c} size={13} />
        </View>
        {right}
      </View>
      <View style={{ marginTop: 8 }}>{children}</View>
    </View>
  );
}

const Loading = ({ c, height = 64 }: { c: ThemeColors; height?: number }) => (
  <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
    <ActivityIndicator color={c.text} />
  </View>
);
const Empty = ({ c, text = 'No data yet.', height }: { c: ThemeColors; text?: string; height?: number }) => (
  <View style={height ? { height, alignItems: 'center', justifyContent: 'center' } : undefined}>
    <Text style={{ color: c.muted, fontSize: 12 }}>{text}</Text>
  </View>
);

const openRow = (host: DivHost, meta: WidgetMeta, row: Row) => {
  if (row._id != null) host.fire(`onno://${meta.kind}/${meta.entityName}/${row._id}`);
};

// ----- list (recent records) -----

const ListWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const dateField = meta.dateField;

  let body: React.ReactNode;
  if (error) body = <Empty c={c} text="No records yet." />;
  else if (!rows) body = <Loading c={c} />;
  else {
    const sorted = [...rows].sort((a, b) => String(b[dateField] ?? '').localeCompare(String(a[dateField] ?? '')));
    const items = sorted.slice(0, meta.maxItems || 8);
    body =
      items.length === 0 ? (
        <Empty c={c} text="No records yet." />
      ) : (
        <View>
          {items.map((row, i) => {
            const headline = resolveText(row, {
              template: meta.cfg('titleTemplate') || undefined,
              fields: splitFields(meta.titleField),
              fallbacks: ['_number', '_code', '_description', 'name'],
            });
            const secondaryFields = splitFields(meta.cfg('secondaryField'));
            const secondary = pickField(
              row,
              secondaryFields.length ? secondaryFields : ['client_display', 'primary_client_display', 'property_display', 'customer_display'],
            );
            const amountFields = meta.cfg('amountField') ? [meta.cfg('amountField')] : ['total', 'total_gross', 'amount', '_sum'];
            const amountRaw = pickField(row, amountFields);
            const amount = amountRaw != null ? toNumber(amountRaw) : null;
            const currency = resolveCurrency(row, meta.cfg('currencyField'), meta.cfg('currency'));
            const dateStr = row[dateField] != null ? String(row[dateField]) : null;
            return (
              <Touchable key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 8 }} onPress={() => openRow(host, meta, row)}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', color: c.text, fontSize: 14 }} numberOfLines={1}>
                    {headline || secondary || '—'}
                  </Text>
                  {headline && secondary ? (
                    <Text style={{ color: c.muted, fontSize: 12 }} numberOfLines={1}>
                      {secondary}
                    </Text>
                  ) : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {amount != null ? <Text style={{ fontWeight: '500', color: c.text, fontSize: 13 }}>{formatAmount(amount, { currency: currency ?? undefined })}</Text> : null}
                  {dateStr ? <Text style={{ color: c.muted, fontSize: 12 }}>{formatMonthDay(dateStr) ?? ''}</Text> : null}
                </View>
              </Touchable>
            );
          })}
        </View>
      );
  }
  return (
    <Card meta={meta} c={c}>
      {body}
    </Card>
  );
};

// ----- stat (headline + delta badge + sparkline) -----

const StatWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const metric = meta.cfg('metric', 'count') as Metric;
  const metricField = meta.cfg('metricField') || undefined;
  const groupBy = meta.cfg('groupBy', '_date');
  // Monthly trend by default — a day-over-day delta on a long series is noise.
  const groupByDate = ((meta.cfg('groupByDate') as GroupByDate) || (groupBy === '_date' ? 'month' : undefined)) as GroupByDate | undefined;
  const color = resolveColor(meta.cfg('colors') || undefined, host.theme, c);
  const opts = numberOptions(meta, metric);

  let body: React.ReactNode;
  if (error) body = <Empty c={c} />;
  else if (!rows) body = <Loading c={c} />;
  else {
    const series = buildSeries(rows, { groupBy, groupByDate, metric, metricField });
    const points = series.rows.map((r) => Number(r[SINGLE_SERIES]) || 0);
    const last = points.length ? points[points.length - 1] : undefined;
    const prev = points.length > 1 ? points[points.length - 2] : undefined;
    const delta = last != null && prev != null && prev !== 0 ? (last - prev) / prev : null;
    const period = groupByDate === 'day' ? 'day' : groupByDate === 'week' ? 'week' : 'month';
    const up = delta != null && delta > 0;
    const flat = delta == null || delta === 0;
    const deltaColor = flat ? c.muted : up ? c.successFg : c.dangerFg;
    body = (
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <Text style={{ fontSize: 28, fontWeight: '700', color: c.text }}>{formatCompact(series.total, opts)}</Text>
          {delta != null && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1, paddingBottom: 3 }}>
              <LucideIcon name={flat ? 'arrow-right' : up ? 'arrow-up-right' : 'arrow-down-right'} size={13} color={deltaColor} />
              <Text style={{ color: deltaColor, fontSize: 12, fontWeight: '600' }}>{Math.abs(delta * 100).toFixed(1)}%</Text>
            </View>
          )}
        </View>
        <View style={{ marginTop: 10 }}>
          <Sparkline data={points} color={color} kind={meta.cfg('kind') === 'line' ? 'line' : 'area'} height={56} c={c} />
        </View>
        {delta != null && <Text style={{ marginTop: 4, color: c.muted, fontSize: 11 }}>vs previous {period}</Text>}
      </View>
    );
  }
  return (
    <Card meta={meta} c={c} mutedTitle>
      {body}
    </Card>
  );
};

// ----- sparkline (headline + inline sparkline, no delta) -----

const SparklineWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const metric = meta.cfg('metric', 'count') as Metric;
  const metricField = meta.cfg('metricField') || undefined;
  const groupBy = meta.cfg('groupBy', '_date');
  const groupByDate = ((meta.cfg('groupByDate') as GroupByDate) || (groupBy === '_date' ? 'day' : undefined)) as GroupByDate | undefined;
  const color = resolveColor(meta.cfg('colors') || undefined, host.theme, c);
  const opts = numberOptions(meta, metric);

  let total = 0;
  let points: number[] = [];
  if (rows) {
    const series = buildSeries(rows, { groupBy, groupByDate, metric, metricField });
    total = series.total;
    points = series.rows.map((r) => Number(r[SINGLE_SERIES]) || 0);
  }

  return (
    <Card meta={meta} c={c} mutedTitle right={rows ? <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }}>{formatCompact(total, opts)}</Text> : undefined}>
      {error ? <Empty c={c} /> : !rows ? <Loading c={c} height={48} /> : <Sparkline data={points} color={color} kind={meta.cfg('kind') === 'line' ? 'line' : 'area'} height={48} c={c} />}
    </Card>
  );
};

// ----- gauge (radial progress toward a target) -----

const GaugeWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const metric = meta.cfg('metric', 'count') as Metric;
  const color = resolveColor(meta.cfg('colors') || undefined, host.theme, c);
  const opts = numberOptions(meta, metric);

  let body: React.ReactNode;
  if (error) body = <Empty c={c} height={168} />;
  else if (!rows) body = <Loading c={c} height={168} />;
  else {
    const value = aggregate(rows, metric, meta.cfg('metricField') || undefined);
    const target = toNumber(meta.cfg('target'));
    const hasTarget = target != null && target > 0;
    const pct = hasTarget ? Math.max(0, Math.min(100, (value / target) * 100)) : 100;
    body = (
      <GaugeView pct={pct} color={color} c={c}>
        <Text style={{ fontSize: 24, fontWeight: '700', color: c.text }}>{formatCompact(value, opts)}</Text>
        {hasTarget && <Text style={{ marginTop: 6, fontSize: 11, color: c.muted }}>{`${Math.round(pct)}% of ${formatCompact(target!, opts)}`}</Text>}
      </GaugeView>
    );
  }
  return (
    <Card meta={meta} c={c} mutedTitle>
      {body}
    </Card>
  );
};

// ----- chart (bar / line / area / donut / pie) -----

const CHART_KINDS = ['bar', 'line', 'area', 'donut', 'pie'];

const ChartWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const metric = meta.cfg('metric', 'count') as Metric;
  const metricField = meta.cfg('metricField') || undefined;
  let kind = meta.cfg('kind', 'bar');
  if (!CHART_KINDS.includes(kind)) kind = 'bar';
  const round = kind === 'donut' || kind === 'pie';
  const groupBy = meta.cfg('groupBy', '_date');
  const groupByDate = ((meta.cfg('groupByDate') as GroupByDate) || (groupBy === '_date' ? 'day' : undefined)) as GroupByDate | undefined;
  const stacked = meta.cfg('stacked') === 'true';
  const opts = numberOptions(meta, metric);

  const series = useMemo(
    () =>
      rows
        ? buildSeries(rows, { groupBy, groupByDate, seriesBy: round ? undefined : meta.cfg('seriesBy') || undefined, metric, metricField })
        : null,
    [rows, groupBy, groupByDate, round, metric, metricField, meta.cfg('seriesBy')],
  );

  let body: React.ReactNode;
  let right: React.ReactNode;
  if (error) body = <Empty c={c} height={230} />;
  else if (!series) body = <Loading c={c} height={230} />;
  else if (series.rows.length === 0) body = <Empty c={c} height={230} />;
  else {
    right = <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{formatNumber(series.total, opts)}</Text>;
    const fmtAxis = (n: number) => formatCompact(n, opts);
    const chartColors = resolveColors(round ? series.rows.length : series.seriesKeys.length, meta.cfg('colors') || undefined, host.theme, c);
    const multi = series.seriesKeys.length > 1 || series.seriesKeys[0] !== SINGLE_SERIES;
    if (round) {
      body = (
        <View>
          <PieChartView data={series} colors={chartColors} c={c} kind={kind as 'pie' | 'donut'} />
          <Legend labels={series.rows.map((r) => String(r.label))} colors={chartColors} c={c} />
        </View>
      );
    } else {
      body = (
        <View>
          <XYChart kind={kind as 'bar' | 'line' | 'area'} data={series} colors={chartColors} c={c} fmtAxis={fmtAxis} stacked={stacked} />
          {multi && <Legend labels={series.seriesKeys} colors={chartColors} c={c} />}
        </View>
      );
    }
  }
  return (
    <Card meta={meta} c={c} right={right}>
      {body}
    </Card>
  );
};

// ----- kanban (grouped board: Draft / Posted) -----

interface KanbanColumn {
  key: string;
  label: string;
  match: (row: Row) => boolean;
}

function kanbanColumns(meta: WidgetMeta): KanbanColumn[] {
  const groupBy = meta.cfg('groupBy', '_posted');
  if (groupBy === '_posted' && meta.entityType === 'document') {
    return [
      { key: 'draft', label: 'Draft', match: (r) => !r._posted },
      { key: 'posted', label: 'Posted', match: (r) => Boolean(r._posted) },
    ];
  }
  return [];
}

const KanbanWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const columns = kanbanColumns(meta);
  const titleField = meta.titleField || '_number';

  if (columns.length === 0) {
    return (
      <Card meta={meta} c={c}>
        <Empty c={c} text={`Kanban grouping "${meta.cfg('groupBy', '_posted')}" is not supported.`} />
      </Card>
    );
  }

  let body: React.ReactNode;
  if (error) body = <Empty c={c} />;
  else if (!rows) body = <Loading c={c} height={120} />;
  else {
    body = (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 2 }}>
        {columns.map((col) => {
          const cards = rows.filter(col.match).slice(0, meta.maxItems || 12);
          return (
            <View key={col.key} style={{ width: 250, backgroundColor: c.surface, borderRadius: 10, padding: 8, gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 }}>
                <Text style={{ fontSize: 11, fontWeight: '600', color: c.muted, letterSpacing: 0.5 }}>{col.label.toUpperCase()}</Text>
                <View style={{ minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ fontSize: 10, fontWeight: '600', color: c.muted }}>{cards.length}</Text>
                </View>
              </View>
              {cards.length === 0 ? (
                <View style={{ borderWidth: 1, borderColor: c.border, borderStyle: 'dashed', borderRadius: 8, paddingVertical: 14, alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, color: c.muted }}>No items</Text>
                </View>
              ) : (
                cards.map((row, i) => <KanbanCard key={i} row={row} c={c} titleField={titleField} onPress={() => openRow(host, meta, row)} />)
              )}
            </View>
          );
        })}
      </ScrollView>
    );
  }
  return (
    <Card meta={meta} c={c}>
      {body}
    </Card>
  );
};

function KanbanCard({ row, c, titleField, onPress }: { row: Row; c: ThemeColors; titleField: string; onPress: () => void }) {
  const number = String(row[titleField] ?? row._number ?? row._code ?? '');
  const primary = String(row.customer_display ?? row.client_display ?? row.primary_client_display ?? row._description ?? row.name ?? '');
  const secondary = String(row.property_display ?? row.warehouse_display ?? '');
  const dateStr = typeof row._date === 'string' ? row._date : null;
  const amount = typeof row.total === 'number' ? row.total : null;
  return (
    <Touchable style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10, gap: 4 }} onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 10, color: c.muted, fontWeight: '600', letterSpacing: 0.5 }}>{number.toUpperCase()}</Text>
        {dateStr ? <Text style={{ fontSize: 10, color: c.muted }}>{formatMonthDay(dateStr) ?? ''}</Text> : null}
      </View>
      {primary ? (
        <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={2}>
          {primary}
        </Text>
      ) : null}
      {secondary ? (
        <Text style={{ fontSize: 11, color: c.muted }} numberOfLines={1}>
          {secondary}
        </Text>
      ) : null}
      {amount != null ? <Text style={{ fontSize: 12, fontWeight: '500', color: c.text, alignSelf: 'flex-end' }}>{formatAmount(amount)}</Text> : null}
    </Touchable>
  );
}

// ----- calendar (month grid + agenda for the selected day) -----

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const CalendarWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const dateField = meta.dateField;
  const titleField = meta.titleField || '_number';

  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState<string | null>(() => ymd(today));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  useEffect(() => {
    if (meta.entityType !== 'document') {
      setRows([]);
      return;
    }
    let alive = true;
    const from = `${year}-${pad2(month + 1)}-01T00:00:00`;
    const to = `${year}-${pad2(month + 1)}-${pad2(new Date(year, month + 1, 0).getDate())}T23:59:59`;
    (async () => {
      try {
        const r = await host.client.rows(meta.kind, meta.entityName, { from, to });
        if (alive) {
          setRows(r);
          setError(null);
        }
      } catch (e: any) {
        if (alive) {
          setRows([]);
          setError(String(e?.message ?? e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta.entityType, meta.entityName, meta.kind, year, month]);

  // dayKey -> events on that day
  const byDay = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const row of rows ?? []) {
      const raw = row[dateField];
      if (typeof raw !== 'string' || !raw) continue;
      const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
      if (isNaN(d.getTime())) continue;
      const key = ymd(d);
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return map;
  }, [rows, dateField]);

  if (meta.entityType !== 'document') {
    return (
      <Card meta={meta} c={c}>
        <Empty c={c} text="Calendar is only available for documents." />
      </Card>
    );
  }

  // Build the 6×7 grid, weeks starting Monday.
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const goMonth = (delta: number) => {
    setCursor(new Date(year, month + delta, 1));
  };
  const goToday = () => {
    setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelected(ymd(today));
  };

  const selectedEvents = selected ? byDay.get(selected) ?? [] : [];
  const todayKey = ymd(today);

  return (
    <Card
      meta={meta}
      c={c}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Touchable onPress={goToday} style={{ paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}>
            <Text style={{ fontSize: 11, color: c.text, fontWeight: '500' }}>Today</Text>
          </Touchable>
          <Touchable onPress={() => goMonth(-1)} hitSlop={6} style={{ padding: 4 }}>
            <LucideIcon name="chevron-left" size={16} color={c.muted} />
          </Touchable>
          <Touchable onPress={() => goMonth(1)} hitSlop={6} style={{ padding: 4 }}>
            <LucideIcon name="chevron-right" size={16} color={c.muted} />
          </Touchable>
        </View>
      }
    >
      <Text style={{ fontSize: 12, color: c.muted, marginBottom: 8 }}>{`${MONTH_NAMES[month]} ${year}`}</Text>

      {!rows ? (
        <Loading c={c} height={200} />
      ) : (
        <>
          <View style={{ flexDirection: 'row' }}>
            {WEEKDAYS.map((w) => (
              <Text key={w} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: c.muted, fontWeight: '600' }}>
                {w}
              </Text>
            ))}
          </View>
          {Array.from({ length: cells.length / 7 }, (_, week) => (
            <View key={week} style={{ flexDirection: 'row' }}>
              {cells.slice(week * 7, week * 7 + 7).map((day, i) => {
                if (!day) return <View key={i} style={{ flex: 1, height: 40 }} />;
                const key = ymd(day);
                const events = byDay.get(key) ?? [];
                const isSel = key === selected;
                const isToday = key === todayKey;
                return (
                  <Touchable key={i} onPress={() => setSelected(key)} style={{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' }}>
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: isSel ? c.primary : 'transparent',
                        borderWidth: isToday && !isSel ? 1 : 0,
                        borderColor: c.primary,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: isSel ? '#FFFFFF' : c.text, fontWeight: isToday ? '700' : '400' }}>{day.getDate()}</Text>
                    </View>
                    <View style={{ flexDirection: 'row', gap: 2, height: 4, marginTop: 1 }}>
                      {events.slice(0, 3).map((ev, j) => (
                        <View key={j} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: ev._posted ? c.primary : c.muted }} />
                      ))}
                    </View>
                  </Touchable>
                );
              })}
            </View>
          ))}

          <View style={{ marginTop: 10, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
            {error ? (
              <Empty c={c} text="Couldn’t load events." />
            ) : selectedEvents.length === 0 ? (
              <Empty c={c} text="No events on this day." />
            ) : (
              selectedEvents.map((row, i) => {
                const headline = resolveText(row, { fields: splitFields(titleField), fallbacks: ['_number', '_code', '_description', 'name'] });
                const secondary = pickField(row, ['customer_display', 'client_display', 'property_display', '_description']);
                const amount = toNumber(pickField(row, ['total', 'total_gross', 'amount']));
                return (
                  <Touchable key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 8 }} onPress={() => openRow(host, meta, row)}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: row._posted ? c.primary : c.muted }} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }} numberOfLines={1}>
                        {headline || '—'}
                      </Text>
                      {secondary ? (
                        <Text style={{ fontSize: 11, color: c.muted }} numberOfLines={1}>
                          {secondary}
                        </Text>
                      ) : null}
                    </View>
                    {amount != null ? <Text style={{ fontSize: 12, fontWeight: '500', color: c.text }}>{formatAmount(amount)}</Text> : null}
                  </Touchable>
                );
              })
            )}
          </View>
        </>
      )}
    </Card>
  );
};

// ----- map (records plotted on a read-only map) -----

const MapWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const source = useMemo(() => geoSourceFrom((k) => meta.cfg(k)), [meta.raw]);

  const shapes = useMemo<GeoShape[]>(() => {
    if (!rows || !hasGeoSource(source)) return [];
    const out: GeoShape[] = [];
    for (const row of rows) {
      const label = resolveText(row, { fields: splitFields(meta.titleField), fallbacks: ['_description', '_number', '_code', 'name'] });
      const href = row._id != null ? `onno://${meta.kind}/${meta.entityName}/${row._id}` : undefined;
      out.push(...shapesFromRow(row, source, { label, href }));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, source, meta.titleField, meta.kind, meta.entityName]);

  let body: React.ReactNode;
  if (!hasGeoSource(source)) body = <Empty c={c} text="No geo source configured." height={200} />;
  else if (error) body = <Empty c={c} text="Couldn’t load locations." height={200} />;
  else if (!rows) body = <Loading c={c} height={200} />;
  else if (shapes.length === 0) body = <Empty c={c} text="No locations yet." height={200} />;
  else body = <GeoMap shapes={shapes} theme={host.theme} height={300} host={host} interactive />;

  const markerCount = shapes.filter((s) => s.kind === 'point').length;
  return (
    <Card meta={meta} c={c} right={markerCount > 0 ? <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{markerCount}</Text> : undefined}>
      {body}
    </Card>
  );
};

// ----- registry -----

export const onnoWidget: CustomRenderer = (p) => {
  const meta = new WidgetMeta((p.customProps.widget as Record<string, any>) ?? {});
  switch (meta.widgetType) {
    case 'list': return <ListWidget {...p} />;
    case 'stat': return <StatWidget {...p} />;
    case 'sparkline': return <SparklineWidget {...p} />;
    case 'gauge': return <GaugeWidget {...p} />;
    case 'chart': return <ChartWidget {...p} />;
    case 'kanban': return <KanbanWidget {...p} />;
    case 'calendar': return <CalendarWidget {...p} />;
    case 'map': return <MapWidget {...p} />;
    default:
      return (
        <Card meta={meta} c={colors(p.host.theme)}>
          <Empty c={colors(p.host.theme)} text={`No renderer for "${meta.widgetType}".`} />
        </Card>
      );
  }
};
