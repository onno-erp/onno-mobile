// Descriptor + data plumbing for the dashboard widgets (onec-widget). Port of the
// web SPA's lib/widget-data.ts: one place that buckets/sums a widget's rows into
// single-number aggregates or time-bucketed, optionally multi-series datasets, so
// every widget orders and aggregates identically.

import { toNumber } from './format';
import type { NumberFormatOptions } from './format';

/** The descriptor the server ships in `custom_props.widget` (DashboardWidgetMeta). */
export class WidgetMeta {
  constructor(public raw: Record<string, any>) {}
  get title(): string { return this.raw.title ?? ''; }
  get widgetType(): string { return this.raw.widgetType ?? ''; }
  get entityType(): string { return this.raw.entityType ?? 'document'; }
  get entityName(): string { return this.raw.entityName ?? ''; }
  get maxItems(): number { return Number(this.raw.maxItems ?? 8); }
  get hint(): string { return this.raw.hint ?? ''; }
  get extra(): Record<string, any> { return this.raw.extraConfig ?? {}; }

  /** `dateField`/`titleField` are top-level on the meta (with an extraConfig fallback). */
  get dateField(): string { return this.raw.dateField || this.extra.dateField || '_date'; }
  get titleField(): string { return this.raw.titleField || this.extra.titleField || ''; }

  cfg(key: string, fallback = ''): string {
    const v = this.extra[key];
    return v == null ? fallback : String(v);
  }

  /** REST `{kind}` segment: documents | catalogs | registers. */
  get kind(): string {
    return this.entityType === 'catalog' ? 'catalogs' : this.entityType === 'register' ? 'registers' : 'documents';
  }
}

export type Metric = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type GroupByDate = 'day' | 'week' | 'month';

export interface AggregateSpec {
  metric: Metric;
  metricField?: string;
}

/** Reduce every row to one number (count / sum / avg / min / max over `metricField`). */
export function aggregate(rows: Record<string, any>[], spec: AggregateSpec | string, metricField?: string): number {
  const metric = typeof spec === 'string' ? (spec as Metric) : spec.metric;
  const field = typeof spec === 'string' ? metricField : spec.metricField;
  if (metric === 'count') return rows.length;
  if (!field) return 0;
  const nums = rows.map((r) => toNumber(r[field])).filter((n): n is number => n != null);
  if (!nums.length) return 0;
  switch (metric) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    default: return nums.reduce((a, b) => a + b, 0);
  }
}

// ----- date bucketing -----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');

function parseDate(raw: unknown): Date | null {
  if (raw == null) return null;
  const s = String(raw);
  const d = new Date(s.includes('T') || s.length <= 10 ? s : s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

/** ISO week number (1-53) for week bucketing/labels. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7; // Mon = 0
  t.setUTCDate(t.getUTCDate() - day + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fd = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fd + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { year: t.getUTCFullYear(), week };
}

/** A human label for one bucket value — formatted dates for time buckets, else raw. */
export function bucketLabel(value: unknown, groupByDate?: GroupByDate): string {
  if (typeof value === 'string' && groupByDate) {
    const d = parseDate(value);
    if (d) {
      if (groupByDate === 'day') return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
      if (groupByDate === 'week') return `Wk ${isoWeek(d).week}`;
      if (groupByDate === 'month') return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
    }
  }
  if (typeof value === 'boolean') return value ? 'Posted' : 'Draft';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

// A sortable key + display label. Date buckets get a zero-padded key so chronological
// order is plain string order; everything else keys on its own label (insertion order).
function bucketKey(value: unknown, groupByDate?: GroupByDate): { key: string; label: string } {
  if (typeof value === 'string' && groupByDate) {
    const d = parseDate(value);
    if (d) {
      if (groupByDate === 'day') {
        const key = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        return { key, label: `${MONTHS[d.getMonth()]} ${d.getDate()}` };
      }
      if (groupByDate === 'week') {
        const { year, week } = isoWeek(d);
        return { key: `${year}-W${pad2(week)}`, label: `Wk ${week}` };
      }
      if (groupByDate === 'month') {
        return { key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` };
      }
    }
  }
  const label = bucketLabel(value, undefined);
  return { key: label, label };
}

export interface SeriesSpec extends AggregateSpec {
  /** Field that defines the x-axis buckets. */
  groupBy: string;
  /** Date bucketing granularity when `groupBy` holds a date. */
  groupByDate?: GroupByDate;
  /** Optional field that splits each bucket into multiple colored series. */
  seriesBy?: string;
  /** Cap on distinct series; the rest fold into an "Other" series. */
  maxSeries?: number;
}

export interface SeriesData {
  /** Wide rows: `{ label, [seriesKey]: number, ... }`, one per x bucket, x-ordered. */
  rows: Array<Record<string, number | string>>;
  /** Series keys in stable order; `["value"]` (the single-series sentinel) when not split. */
  seriesKeys: string[];
  /** The grand total across every bucket and series. */
  total: number;
}

/** The single-series sentinel key used when `seriesBy` is unset. */
export const SINGLE_SERIES = 'value';

/**
 * Bucket rows into an x-ordered, optionally multi-series dataset. With no `seriesBy`
 * it yields one `"value"` series; with `seriesBy` it splits each bucket by that field,
 * orders series by total (largest first) and folds the tail beyond `maxSeries` into
 * "Other". Mirrors the web `buildSeries`.
 */
export function buildSeries(rows: Record<string, any>[], spec: SeriesSpec): SeriesData {
  const maxSeries = spec.maxSeries ?? 8;
  const buckets = new Map<string, { sortKey: string; label: string; series: Map<string, number> }>();
  const seriesTotals = new Map<string, number>();
  let total = 0;

  for (const row of rows) {
    const { key, label } = bucketKey(row[spec.groupBy], spec.groupByDate);
    let bucket = buckets.get(key);
    if (!bucket) buckets.set(key, (bucket = { sortKey: key, label, series: new Map() }));
    const seriesKey = spec.seriesBy ? bucketLabel(row[spec.seriesBy]) : SINGLE_SERIES;
    const inc = spec.metric === 'count' ? 1 : spec.metricField ? toNumber(row[spec.metricField]) ?? 0 : 0;
    bucket.series.set(seriesKey, (bucket.series.get(seriesKey) ?? 0) + inc);
    seriesTotals.set(seriesKey, (seriesTotals.get(seriesKey) ?? 0) + inc);
    total += inc;
  }

  let seriesKeys: string[];
  if (!spec.seriesBy) {
    seriesKeys = [SINGLE_SERIES];
  } else {
    const ranked = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    if (ranked.length > maxSeries) {
      const keep = new Set(ranked.slice(0, maxSeries - 1));
      for (const bucket of buckets.values()) {
        let other = 0;
        for (const [k, v] of bucket.series) {
          if (!keep.has(k)) {
            other += v;
            bucket.series.delete(k);
          }
        }
        if (other) bucket.series.set('Other', (bucket.series.get('Other') ?? 0) + other);
      }
      seriesKeys = [...ranked.slice(0, maxSeries - 1), 'Other'];
    } else {
      seriesKeys = ranked;
    }
  }

  const ordered = [...buckets.values()];
  if (spec.groupByDate) ordered.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const out = ordered.map((bucket) => {
    const wide: Record<string, number | string> = { label: bucket.label };
    for (const key of seriesKeys) wide[key] = bucket.series.get(key) ?? 0;
    return wide;
  });

  return { rows: out, seriesKeys, total };
}

/** NumberFormatOptions assembled from a widget's extraConfig (currency/unit/format/locale). */
export function numberOptions(meta: WidgetMeta, metric?: string): NumberFormatOptions {
  const opt = (k: string): string | undefined => meta.cfg(k) || undefined;
  return {
    currency: opt('currency'),
    unit: opt('unit'),
    unitPosition: opt('unitPosition'),
    format: meta.cfg('format') || (metric === 'count' ? 'integer' : undefined),
    locale: opt('locale'),
  };
}
