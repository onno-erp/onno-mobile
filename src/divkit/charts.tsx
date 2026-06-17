// Native chart primitives drawn with react-native-svg — the RN equivalent of the
// web SPA's recharts usage (sparkline / bar / line / area / pie / donut / gauge).
// Each chart measures its own width via onLayout (RN SVG needs explicit sizes),
// then maps the data into SVG paths. Colors come from a theme-driven categorical
// palette mirroring the web `--chart-N` CSS vars, overridable per widget.

import React, { useId, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { formatCompact } from './format';
import type { ThemeColors } from './theme';
import type { SeriesData } from './widgetData';
import { SINGLE_SERIES } from './widgetData';

// ----- color resolution (mirrors lib/chart-colors.ts, with concrete HSL) -----

// The `--chart-N` palettes from the web index.css, per theme.
const PALETTE_LIGHT = ['222,83%,58%', '152,60%,42%', '38,92%,50%', '348,83%,58%', '262,70%,60%', '190,80%,42%', '24,90%,55%', '322,75%,58%'];
const PALETTE_DARK = ['222,90%,66%', '152,55%,52%', '38,92%,58%', '348,85%,66%', '262,78%,70%', '190,75%,52%', '24,90%,62%', '322,78%,66%'];

const hsl = (triple: string) => `hsl(${triple})`;

export function chartPalette(theme: 'light' | 'dark'): string[] {
  return (theme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT).map(hsl);
}

/** Resolve one `config("colors", …)` token: a named alias, a `chart-N` slot, or a literal color. */
function resolveColorToken(token: string, theme: 'light' | 'dark', c: ThemeColors): string {
  const t = token.trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  const palette = chartPalette(theme);
  const aliases: Record<string, string> = {
    primary: c.primary,
    success: c.successFg,
    warning: hsl('38,92%,50%'),
    destructive: c.dangerFg,
    danger: c.dangerFg,
    muted: c.muted,
  };
  if (lower in aliases) return aliases[lower];
  const slot = /^chart-([1-8])$/.exec(lower);
  if (slot) return palette[Number(slot[1]) - 1];
  return t; // a literal CSS color (#hex / rgb() / hsl() / named)
}

function parseColors(override: string | undefined, theme: 'light' | 'dark', c: ThemeColors): string[] {
  return (override ?? '').split(',').map((tok) => resolveColorToken(tok, theme, c)).filter(Boolean);
}

/** Exactly `count` colors: author overrides win slot-by-slot, palette fills (and cycles for) the rest. */
export function resolveColors(count: number, override: string | undefined, theme: 'light' | 'dark', c: ThemeColors): string[] {
  const palette = chartPalette(theme);
  const custom = parseColors(override, theme, c);
  return Array.from({ length: count }, (_, i) => custom[i] ?? palette[i % palette.length]);
}

/** A single color — the first override token, else the lead palette slot. */
export function resolveColor(override: string | undefined, theme: 'light' | 'dark', c: ThemeColors): string {
  return resolveColors(1, override, theme, c)[0];
}

// ----- layout helper: measure width before drawing -----

function ChartFrame({ height, children }: { height: number; children: (w: number) => React.ReactNode }) {
  const [w, setW] = useState(0);
  return (
    <View
      style={{ height, width: '100%', position: 'relative' }}
      onLayout={(e) => {
        const nw = Math.round(e.nativeEvent.layout.width);
        if (nw && nw !== w) setW(nw);
      }}
    >
      {w > 0 ? children(w) : null}
    </View>
  );
}

// ----- sparkline (axis-less area/line trend) -----

export function Sparkline({
  data,
  color,
  kind = 'area',
  height = 48,
  c,
}: {
  data: number[];
  color: string;
  kind?: 'area' | 'line';
  height?: number;
  c: ThemeColors;
}) {
  const gradId = `spark-${useId().replace(/:/g, '')}`;
  if (data.length === 0) return <View style={{ height }} />;
  if (data.length === 1) data = [data[0], data[0]];

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 2;

  return (
    <ChartFrame height={height}>
      {(w) => {
        const innerH = height - pad * 2;
        const pts = data.map((v, i) => {
          const x = (i / (data.length - 1)) * w;
          const y = pad + innerH - ((v - min) / span) * innerH;
          return [x, y] as const;
        });
        const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
        const base = height - pad;
        const area = `${line} L${w.toFixed(1)} ${base} L0 ${base} Z`;
        return (
          <Svg width={w} height={height}>
            {kind === 'area' && (
              <>
                <Defs>
                  <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <Stop offset="0%" stopColor={color} stopOpacity={0.35} />
                    <Stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </LinearGradient>
                </Defs>
                <Path d={area} fill={`url(#${gradId})`} />
              </>
            )}
            <Path d={line} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

// ----- shared XY axis math (bar / line / area) -----

const AXIS_W = 40;
const LABEL_H = 22;
const TOP_PAD = 6;

/** Round up to a "nice" axis maximum (1/2/5 × 10ⁿ). */
function niceCeil(x: number): number {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const f = x / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * base;
}

interface XYProps {
  data: SeriesData;
  colors: string[];
  c: ThemeColors;
  fmtAxis: (n: number) => string;
  stacked?: boolean;
  height?: number;
}

export function XYChart({ kind, ...p }: XYProps & { kind: 'bar' | 'line' | 'area' }) {
  const { data, colors, c, fmtAxis, stacked = false, height = 210 } = p;
  const keys = data.seriesKeys;
  const n = data.rows.length;

  let maxY = 0;
  for (const row of data.rows) {
    if (stacked) maxY = Math.max(maxY, keys.reduce((s, k) => s + (Number(row[k]) || 0), 0));
    else for (const k of keys) maxY = Math.max(maxY, Number(row[k]) || 0);
  }
  const top = niceCeil(maxY);

  return (
    <ChartFrame height={height}>
      {(w) => {
        const plotX = AXIS_W;
        const plotW = Math.max(1, w - AXIS_W);
        const plotH = height - LABEL_H - TOP_PAD;
        const yOf = (v: number) => TOP_PAD + plotH - (v / top) * plotH;
        const band = plotW / Math.max(1, n);

        const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
        const grid = ticks.map((t, i) => {
          const y = yOf(t);
          return (
            <G key={`g${i}`}>
              <Line x1={plotX} y1={y} x2={w} y2={y} stroke={c.border} strokeWidth={1} strokeDasharray="3 3" />
              <SvgText x={plotX - 6} y={y + 3} fontSize={9} fill={c.muted} textAnchor="end">
                {fmtAxis(t)}
              </SvgText>
            </G>
          );
        });

        const step = Math.max(1, Math.ceil(n / 6));
        const xLabels = data.rows.map((row, i) => {
          if (step > 1 && i % step !== 0) return null;
          const cx = plotX + (i + 0.5) * band;
          return (
            <SvgText key={`x${i}`} x={cx} y={height - 6} fontSize={9} fill={c.muted} textAnchor="middle">
              {String(row.label)}
            </SvgText>
          );
        });

        let marks: React.ReactNode;
        if (kind === 'bar') {
          marks = data.rows.flatMap((row, i) => {
            const x0 = plotX + i * band;
            if (stacked) {
              const barW = Math.min(band * 0.6, 48);
              const bx = x0 + (band - barW) / 2;
              let acc = 0;
              return keys.map((k, j) => {
                const v = Number(row[k]) || 0;
                const y1 = yOf(acc + v);
                const y2 = yOf(acc);
                acc += v;
                if (v <= 0) return null;
                const isTop = j === keys.length - 1;
                return <Rect key={`${i}-${j}`} x={bx} y={y1} width={barW} height={Math.max(0, y2 - y1)} fill={colors[j]} rx={isTop ? 3 : 0} />;
              });
            }
            const groupW = Math.min(band * 0.8, 48 * keys.length);
            const gx = x0 + (band - groupW) / 2;
            const rodW = groupW / keys.length;
            return keys.map((k, j) => {
              const v = Number(row[k]) || 0;
              const y = yOf(v);
              return <Rect key={`${i}-${j}`} x={gx + j * rodW + 1} y={y} width={Math.max(1, rodW - 2)} height={Math.max(0, TOP_PAD + plotH - y)} fill={colors[j]} rx={3} />;
            });
          });
        } else {
          const isArea = kind === 'area';
          const xOf = (i: number) => (n === 1 ? plotX + plotW / 2 : plotX + (i + 0.5) * band);
          marks = keys.flatMap((k, j) => {
            const pts = data.rows.map((row, i) => [xOf(i), yOf(Number(row[k]) || 0)] as const);
            const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
            const out: React.ReactNode[] = [];
            if (isArea && pts.length) {
              const baseY = (TOP_PAD + plotH).toFixed(1);
              out.push(<Path key={`a${j}`} d={`${d} L${pts[pts.length - 1][0].toFixed(1)} ${baseY} L${pts[0][0].toFixed(1)} ${baseY} Z`} fill={colors[j]} fillOpacity={0.15} />);
            }
            out.push(<Path key={`l${j}`} d={d} stroke={colors[j]} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />);
            return out;
          });
        }

        return (
          <Svg width={w} height={height}>
            {grid}
            {marks}
            {xLabels}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

// ----- pie / donut -----

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export function PieChartView({
  data,
  colors,
  c,
  kind,
  height = 230,
}: {
  data: SeriesData;
  colors: string[];
  c: ThemeColors;
  kind: 'pie' | 'donut';
  height?: number;
}) {
  const slices = data.rows.map((r, i) => ({ value: Number(r[SINGLE_SERIES]) || 0, color: colors[i % colors.length] }));
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const gap = kind === 'donut' ? 0.03 : 0; // small inter-slice gap (radians)

  return (
    <ChartFrame height={height}>
      {(w) => {
        const cx = w / 2;
        const cy = height / 2;
        const r = Math.min(w, height) / 2 - 8;
        const positive = slices.filter((s) => s.value > 0);
        let a0 = -Math.PI / 2;
        const paths = positive.map((sl, i) => {
          const frac = sl.value / total;
          const a1 = a0 + frac * 2 * Math.PI;
          // A lone full slice can't be drawn as an arc (start === end) — use a ring/circle.
          if (positive.length === 1) {
            a0 = a1;
            return <Circle key={i} cx={cx} cy={cy} r={r} fill={sl.color} />;
          }
          const d = arcPath(cx, cy, r, a0 + gap / 2, a1 - gap / 2);
          a0 = a1;
          return <Path key={i} d={d} fill={sl.color} stroke={c.card} strokeWidth={2} />;
        });
        return (
          <Svg width={w} height={height}>
            {paths}
            {kind === 'donut' && <Circle cx={cx} cy={cy} r={r * 0.6} fill={c.card} />}
          </Svg>
        );
      }}
    </ChartFrame>
  );
}

// ----- gauge (radial progress toward a target) -----

export function GaugeView({
  pct,
  color,
  c,
  height = 168,
  children,
}: {
  pct: number; // 0..100
  color: string;
  c: ThemeColors;
  height?: number;
  children?: React.ReactNode; // centered readout
}) {
  const frac = Math.max(0, Math.min(1, pct / 100));
  return (
    <ChartFrame height={height}>
      {(w) => {
        const size = Math.min(w, height);
        const cx = w / 2;
        const cy = height / 2;
        const ringW = size * 0.13;
        const r = size / 2 - ringW / 2 - 2;
        const circ = 2 * Math.PI * r;
        return (
          <>
            <Svg width={w} height={height}>
              <Circle cx={cx} cy={cy} r={r} stroke={c.border} strokeWidth={ringW} fill="none" />
              <Circle
                cx={cx}
                cy={cy}
                r={r}
                stroke={color}
                strokeWidth={ringW}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${(circ * frac).toFixed(2)} ${(circ * (1 - frac) + 1).toFixed(2)}`}
                rotation={-90}
                originX={cx}
                originY={cy}
              />
            </Svg>
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
              {children}
            </View>
          </>
        );
      }}
    </ChartFrame>
  );
}

// ----- legend (color swatch + key) -----

export function Legend({ labels, colors, c }: { labels: string[]; colors: string[]; c: ThemeColors }) {
  if (labels.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 8, justifyContent: 'center' }}>
      {labels.map((label, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: colors[i % colors.length] }} />
          <Text style={{ color: c.muted, fontSize: 11 }}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

export { formatCompact };
