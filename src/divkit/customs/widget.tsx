// onec-widget — a dashboard tile. The server ships a descriptor
// (custom_props.widget); each widget fetches its own rows and renders. Port of
// the Flutter onec_widget.dart. `list` and `stat` are fully rendered; chart-ish
// types (sparkline/gauge/chart/kanban/calendar) show their headline aggregate in
// a card (no chart graphics yet) rather than a raw placeholder.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { Row } from '../../api/onecClient';
import {
  formatAmount,
  formatCompact,
  formatMonthDay,
  pickField,
  resolveCurrency,
  resolveText,
  splitFields,
  toNumber,
} from '../format';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { aggregate, WidgetMeta } from '../widgetData';

function useRows(host: DivHost, meta: WidgetMeta) {
  const [state, setState] = useState<{ rows: Row[] | null; error: string | null }>({ rows: null, error: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows =
          meta.entityType === 'register'
            ? await host.client.rows('registers', meta.entityName, {
                registerPath: 'turnover',
                from: '1970-01-01T00:00:00',
                to: '2999-12-31T23:59:59',
              })
            : await host.client.rows(meta.kind, meta.entityName);
        if (alive) setState({ rows, error: null });
      } catch (e: any) {
        if (alive) setState({ rows: null, error: String(e?.message ?? e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [meta.entityType, meta.entityName, meta.kind]);
  return state;
}

function Card({ meta, c, children }: { meta: WidgetMeta; c: ThemeColors; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 14, marginVertical: 6 }}>
      <Text style={{ fontSize: 15, fontWeight: '600', color: c.text }} numberOfLines={1}>
        {meta.title}
      </Text>
      <View style={{ marginTop: 8 }}>{children}</View>
    </View>
  );
}

const Loading = ({ c }: { c: ThemeColors }) => (
  <View style={{ height: 64, alignItems: 'center', justifyContent: 'center' }}>
    <ActivityIndicator color={c.text} />
  </View>
);
const Empty = ({ c, text = 'No data yet.' }: { c: ThemeColors; text?: string }) => (
  <Text style={{ color: c.muted, fontSize: 12 }}>{text}</Text>
);

const ListWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const dateField = meta.cfg('dateField', '_date');

  let body: React.ReactNode;
  if (error) body = <Empty c={c} text="No records yet." />;
  else if (!rows) body = <Loading c={c} />;
  else {
    const sorted = [...rows].sort((a, b) => String(b[dateField] ?? '').localeCompare(String(a[dateField] ?? '')));
    const items = sorted.slice(0, meta.maxItems);
    body =
      items.length === 0 ? (
        <Empty c={c} text="No records yet." />
      ) : (
        <View>
          {items.map((row, i) => {
            const headline = resolveText(row, {
              template: meta.cfg('titleTemplate') || undefined,
              fields: splitFields(meta.cfg('titleField')),
              fallbacks: ['_number', '_code', '_description', 'name'],
            });
            const secondaryFields = splitFields(meta.cfg('secondaryField'));
            const secondary = pickField(
              row,
              secondaryFields.length ? secondaryFields : ['client_display', 'primary_client_display', 'property_display', 'customer_display'],
            );
            const amountFields = splitFields(meta.cfg('amountField'));
            const amountRaw = pickField(row, amountFields.length ? amountFields : ['total', 'total_gross', 'amount', '_sum']);
            const amount = amountRaw != null ? toNumber(amountRaw) : null;
            const currency = resolveCurrency(row, meta.cfg('currencyField'), meta.cfg('currency'));
            const dateStr = row[dateField] != null ? String(row[dateField]) : null;
            return (
              <Pressable
                key={i}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 8 }}
                onPress={() => {
                  if (row._id != null) host.fire(`onec://${meta.kind}/${meta.entityName}/${row._id}`);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '600', color: c.text, fontSize: 14 }} numberOfLines={1}>
                    {headline || '—'}
                  </Text>
                  {secondary ? (
                    <Text style={{ color: c.muted, fontSize: 12 }} numberOfLines={1}>
                      {secondary}
                    </Text>
                  ) : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {amount != null ? <Text style={{ fontWeight: '500', color: c.text, fontSize: 13 }}>{formatAmount(amount, { currency: currency ?? undefined })}</Text> : null}
                  {dateStr ? <Text style={{ color: c.muted, fontSize: 12 }}>{formatMonthDay(dateStr) ?? ''}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      );
  }
  return <Card meta={meta} c={c}>{body}</Card>;
};

const StatWidget: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const metric = meta.cfg('metric', 'count');
  let body: React.ReactNode;
  if (error) body = <Empty c={c} />;
  else if (!rows) body = <Loading c={c} />;
  else {
    const value = aggregate(rows, metric, meta.cfg('metricField') || undefined);
    body = (
      <Text style={{ fontSize: 28, fontWeight: '700', color: c.text }}>
        {formatCompact(value, { currency: meta.cfg('currency') || undefined, format: metric === 'count' ? 'integer' : undefined })}
      </Text>
    );
  }
  return <Card meta={meta} c={c}>{body}</Card>;
};

const AggregateCard: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const meta = new WidgetMeta((customProps.widget as Record<string, any>) ?? {});
  const { rows, error } = useRows(host, meta);
  const metric = meta.cfg('metric', 'count');
  let body: React.ReactNode;
  if (error) body = <Empty c={c} />;
  else if (!rows) body = <Loading c={c} />;
  else {
    const value = aggregate(rows, metric, meta.cfg('metricField') || undefined);
    body = (
      <View>
        <Text style={{ fontSize: 28, fontWeight: '700', color: c.text }}>{formatCompact(value, { format: metric === 'count' ? 'integer' : undefined })}</Text>
        <Text style={{ color: c.muted, fontSize: 12 }}>{meta.widgetType} · chart view pending</Text>
      </View>
    );
  }
  return <Card meta={meta} c={c}>{body}</Card>;
};

export const onecWidget: CustomRenderer = (p) => {
  const meta = new WidgetMeta((p.customProps.widget as Record<string, any>) ?? {});
  switch (meta.widgetType) {
    case 'list': return <ListWidget {...p} />;
    case 'stat': return <StatWidget {...p} />;
    case 'sparkline':
    case 'gauge':
    case 'chart':
    case 'kanban':
    case 'calendar': return <AggregateCard {...p} />;
    default:
      return (
        <Card meta={meta} c={colors(p.host.theme)}>
          <Empty c={colors(p.host.theme)} text={`No renderer for "${meta.widgetType}".`} />
        </Card>
      );
  }
};
