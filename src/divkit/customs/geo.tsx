// The map surfaces — all hand-written raster-tile slippy maps, since RN ships no map SDK / WebView:
//   • GeoField  — the single-point picker for `.widget("map")` (web geo-picker.tsx).
//   • MapEditor — the point/line/area geometry editor for `.widget("geojson")` (web map-editor.tsx).
//   • GeoMap    — the read-only map for the `onno-geo` detail custom + the dashboard `map` widget.
// The basemap is CARTO's themed monochrome raster (light_all/dark_all), exactly like the web SPA —
// not raw OpenStreetMap (which blocks app clients and isn't the monochrome look the web uses).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, PanResponder, Pressable, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';

const TILE = 256;
const MAP_HEIGHT = 220;
const MIN_ZOOM = 2;
const MAX_ZOOM = 19;
const DEFAULT_CENTER: [number, number] = [20, 0];

// CARTO's keyless monochrome basemap, themed to match the app (the same source the web SPA uses).
// `@2x` (512px) tiles rendered into a 256px box stay crisp on hi-dpi screens.
const SUBDOMAINS = ['a', 'b', 'c'];
function tileUri(theme: 'light' | 'dark', z: number, x: number, y: number): string {
  const variant = theme === 'dark' ? 'dark_all' : 'light_all';
  const s = SUBDOMAINS[(x + y) % SUBDOMAINS.length];
  return `https://${s}.basemaps.cartocdn.com/${variant}/${z}/${x}/${y}@2x.png`;
}

// ----- Web Mercator: lat/lng <-> world pixels at a zoom level -----

function project(lat: number, lng: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const x = ((lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function unproject(x: number, y: number, zoom: number): [number, number] {
  const scale = TILE * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return [lat, lng];
}

function parseLatLng(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const parts = value.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return null;
  const [lat, lng] = parts;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

const format = (lat: number, lng: number) => `${lat.toFixed(6)},${lng.toFixed(6)}`;
// Trim trailing zeros for display in the numeric fields (12.500000 -> "12.5").
const num = (n: number) => String(Number(n.toFixed(6)));

export function GeoField({ value, onChange, theme, lockScroll }: { value?: string; onChange: (v: string) => void; theme: 'light' | 'dark'; lockScroll?: (locked: boolean) => void }) {
  const c = colors(theme);
  const point = parseLatLng(value);
  const [center, setCenter] = useState<[number, number]>(point ?? DEFAULT_CENTER);
  const [zoom, setZoom] = useState(point ? 13 : MIN_ZOOM);
  const [width, setWidth] = useState(0);

  // The pan/tap handlers are created once, so read live state through a ref to avoid stale closures.
  const live = useRef({ center, zoom, width, onChange });
  live.current = { center, zoom, width, onChange };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 2,
      // Once we're interacting, don't let the surrounding ScrollView steal the gesture mid-pan.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        lockScroll?.(true); // freeze the page so the map owns this gesture
        const { center: ctr, zoom: z } = live.current;
        grab.current = {
          lx: e.nativeEvent.locationX,
          ly: e.nativeEvent.locationY,
          world: project(ctr[0], ctr[1], z),
          moved: 0,
        };
      },
      onPanResponderMove: (_e, g) => {
        const start = grab.current;
        if (!start) return;
        start.moved = Math.abs(g.dx) + Math.abs(g.dy);
        const z = live.current.zoom;
        setCenter(unproject(start.world[0] - g.dx, start.world[1] - g.dy, z));
      },
      onPanResponderRelease: (_e, g) => {
        lockScroll?.(false);
        const start = grab.current;
        grab.current = null;
        if (!start) return;
        const { zoom: z, width: w, onChange: cb } = live.current;
        // A tap (negligible travel) drops the pin where the finger landed; a drag just panned.
        if (start.moved + Math.abs(g.dx) + Math.abs(g.dy) < 6) {
          const tlx = start.world[0] - w / 2;
          const tly = start.world[1] - MAP_HEIGHT / 2;
          const [lat, lng] = unproject(tlx + start.lx, tly + start.ly, z);
          cb(format(lat, lng));
        }
      },
      onPanResponderTerminate: () => {
        lockScroll?.(false);
        grab.current = null;
      },
    }),
  ).current;
  const grab = useRef<{ lx: number; ly: number; world: [number, number]; moved: number } | null>(null);

  // ----- numeric fields (free typing; only committed when both parse to a valid point) -----

  const [latText, setLatText] = useState(point ? num(point[0]) : '');
  const [lngText, setLngText] = useState(point ? num(point[1]) : '');
  // Reflect an externally-set value (tap/pan/record load) into the fields — but not our own
  // just-typed value, or the cursor would jump.
  useEffect(() => {
    const p = parseLatLng(value);
    const curLat = latText.trim() === '' ? null : Number(latText);
    const curLng = lngText.trim() === '' ? null : Number(lngText);
    const same = p
      ? curLat != null && curLng != null && Math.abs(p[0] - curLat) < 1e-6 && Math.abs(p[1] - curLng) < 1e-6
      : curLat == null && curLng == null;
    if (!same) {
      setLatText(p ? num(p[0]) : '');
      setLngText(p ? num(p[1]) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (latStr: string, lngStr: string) => {
    if (latStr.trim() === '' && lngStr.trim() === '') {
      onChange('');
      return;
    }
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (latStr.trim() === '' || lngStr.trim() === '' || Number.isNaN(lat) || Number.isNaN(lng)) return;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
    onChange(format(lat, lng));
    setCenter([lat, lng]);
  };

  // ----- tile + marker geometry for the current view -----

  const view = useMemo(() => {
    if (width <= 0) return null;
    const { tiles, tlx, tly } = buildTiles(center, zoom, width, MAP_HEIGHT, theme);
    let marker: { left: number; top: number } | null = null;
    if (point) {
      const [mx, my] = project(point[0], point[1], zoom);
      marker = { left: mx - tlx, top: my - tly };
    }
    return { tiles, marker };
  }, [width, center, zoom, point?.[0], point?.[1], theme]);

  const fieldStyle = {
    borderWidth: 1,
    borderColor: c.fieldBorder,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: c.text,
    backgroundColor: c.fieldBg,
    minHeight: 40,
  } as const;

  return (
    <View style={{ gap: 8 }}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
        style={{ height: MAP_HEIGHT, borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: 'hidden', backgroundColor: c.surface }}
      >
        {/* Tiles are decorative — kept out of hit-testing so the map container is the
            touch target and locationX/Y stays container-relative (correct tap → pin). */}
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          {view?.tiles.map((t) => (
            <Image key={t.key} source={{ uri: t.uri }} style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE }} fadeDuration={0} />
          ))}
        </View>

        {view?.marker && (
          <View pointerEvents="none" style={{ position: 'absolute', left: view.marker.left - 13, top: view.marker.top - 34 }}>
            <Svg width={26} height={34} viewBox="0 0 26 34">
              <Path
                d="M13 0C5.82 0 0 5.82 0 13c0 9.2 11.1 19.6 11.6 20.04a2 2 0 0 0 2.8 0C14.9 32.6 26 22.2 26 13 26 5.82 20.18 0 13 0z"
                fill="#DC2626"
              />
              <Circle cx={13} cy={13} r={5} fill="#fff" />
            </Svg>
          </View>
        )}

        {/* Zoom controls */}
        <View style={{ position: 'absolute', top: 8, right: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
          {(['+', '−'] as const).map((sym, i) => (
            <Pressable
              key={sym}
              onPress={() => setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + (sym === '+' ? 1 : -1))))}
              style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: c.card, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
            >
              <Text style={{ fontSize: 20, fontWeight: '600', color: c.text, lineHeight: 22 }}>{sym}</Text>
            </Pressable>
          ))}
        </View>

        {/* Tile attribution (OSM requires it) */}
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 0, right: 0, backgroundColor: 'rgba(255,255,255,0.7)', paddingHorizontal: 4, borderTopLeftRadius: 4 }}>
          <Text style={{ fontSize: 9, color: '#333' }}>© OpenStreetMap, CARTO</Text>
        </View>

        {width > 0 && !view?.tiles.length && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 12, color: c.muted }}>Tap the map to set a location.</Text>
          </View>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 11, color: c.muted }}>Latitude</Text>
          <TextInput
            value={latText}
            onChangeText={(t) => {
              setLatText(t);
              commit(t, lngText);
            }}
            keyboardType="numbers-and-punctuation"
            placeholder="—"
            placeholderTextColor={c.muted}
            style={fieldStyle}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ fontSize: 11, color: c.muted }}>Longitude</Text>
          <TextInput
            value={lngText}
            onChangeText={(t) => {
              setLngText(t);
              commit(latText, t);
            }}
            keyboardType="numbers-and-punctuation"
            placeholder="—"
            placeholderTextColor={c.muted}
            style={fieldStyle}
          />
        </View>
      </View>
    </View>
  );
}

// ===== Read-only map — the `onno-geo` detail custom + the dashboard `map` widget =====
// The web client renders both with MapLibre; RN ships no map SDK, so — exactly like the
// GeoField editor above — this is a hand-written CARTO raster-tile map. It plots a set of
// normalized shapes (markers / paths / areas), auto-fitting the view to their bounds.
// Port of the web SPA's map-view.tsx + lib/geo.ts feature plumbing.

/** A drawable piece of geometry in [lat, lng], with an optional popup label + navigate href. */
export type GeoShape =
  | { kind: 'point'; lat: number; lng: number; label?: string; href?: string }
  | { kind: 'line'; path: [number, number][]; label?: string; href?: string }
  | { kind: 'polygon'; rings: [number, number][][]; label?: string; href?: string };

/** How a record sources its geometry — a `geoField`/lat+lng point and/or a GeoJSON field. */
export interface GeoSource {
  geoField?: string;
  latField?: string;
  lngField?: string;
  geoJsonField?: string;
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? null : n;
};

/** Read a {@link GeoSource} from a config getter (a widget's extraConfig / a list's map config). */
export function geoSourceFrom(get: (key: string) => string): GeoSource {
  const s = (v: string) => (v ? v : undefined);
  return { geoField: s(get('geoField')), latField: s(get('latField')), lngField: s(get('lngField')), geoJsonField: s(get('geoJsonField')) };
}

/** Whether a source names at least one usable geometry (a point pair or a GeoJSON field). */
export function hasGeoSource(src: GeoSource): boolean {
  return !!src.geoField || !!(src.latField && src.lngField) || !!src.geoJsonField;
}

/** A record's marker point per the source: the combined `geoField`, else the lat/lng pair. */
function extractLatLng(row: Record<string, any>, src: GeoSource): [number, number] | null {
  if (src.geoField) {
    const point = parseLatLng(row[src.geoField] == null ? undefined : String(row[src.geoField]));
    if (point) return point;
  }
  if (src.latField && src.lngField) {
    const lat = numOrNull(row[src.latField]);
    const lng = numOrNull(row[src.lngField]);
    if (lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return [lat, lng];
  }
  return null;
}

// GeoJSON stores coordinates as [lng, lat]; we keep [lat, lng] internally to match the rest of the file.
function geomToShapes(geom: any, props: { label?: string; href?: string }): GeoShape[] {
  if (!geom || typeof geom !== 'object') return [];
  const ll = (c: any): [number, number] | null => (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' ? [c[1], c[0]] : null);
  const ring = (r: any): [number, number][] => (Array.isArray(r) ? (r.map(ll).filter(Boolean) as [number, number][]) : []);
  switch (geom.type) {
    case 'Point': {
      const p = ll(geom.coordinates);
      return p ? [{ kind: 'point', lat: p[0], lng: p[1], ...props }] : [];
    }
    case 'MultiPoint':
      return (geom.coordinates ?? []).map(ll).filter(Boolean).map((p: [number, number]) => ({ kind: 'point', lat: p[0], lng: p[1], ...props }));
    case 'LineString':
      return [{ kind: 'line', path: ring(geom.coordinates), ...props }];
    case 'MultiLineString':
      return (geom.coordinates ?? []).map((line: any) => ({ kind: 'line', path: ring(line), ...props }));
    case 'Polygon':
      return [{ kind: 'polygon', rings: (geom.coordinates ?? []).map(ring), ...props }];
    case 'MultiPolygon':
      return (geom.coordinates ?? []).map((poly: any) => ({ kind: 'polygon', rings: (poly ?? []).map(ring), ...props }));
    case 'GeometryCollection':
      return (geom.geometries ?? []).flatMap((g: any) => geomToShapes(g, props));
    default:
      return [];
  }
}

function featureToShapes(f: any, base: { label?: string; href?: string }): GeoShape[] {
  if (!f || !f.geometry) return [];
  const props = { label: f.properties?.label ?? base.label, href: f.properties?.href ?? base.href };
  return geomToShapes(f.geometry, props);
}

/** Parse a stored value into shapes: a `"lat,lng"` point, or GeoJSON (Feature/FC/bare geometry). */
export function toShapes(value: unknown, base: { label?: string; href?: string } = {}): GeoShape[] {
  if (value == null || value === '') return [];
  const point = parseLatLng(typeof value === 'string' ? value : String(value));
  if (point) return [{ kind: 'point', lat: point[0], lng: point[1], ...base }];
  let obj: any = value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return [];
    try {
      obj = JSON.parse(t);
    } catch {
      return [];
    }
  }
  if (!obj || typeof obj !== 'object') return [];
  if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) return obj.features.flatMap((f: any) => featureToShapes(f, base));
  if (obj.type === 'Feature') return featureToShapes(obj, base);
  return geomToShapes(obj, base);
}

/** The shapes a record contributes per the source: a marker point + any `geoJsonField` geometry. */
export function shapesFromRow(row: Record<string, any>, src: GeoSource, props: { label?: string; href?: string }): GeoShape[] {
  const out: GeoShape[] = [];
  const point = extractLatLng(row, src);
  if (point) out.push({ kind: 'point', lat: point[0], lng: point[1], ...props });
  if (src.geoJsonField) out.push(...toShapes(row[src.geoJsonField], props));
  return out;
}

// ----- view geometry (tiles + bounds-fit) -----

function coordsOf(shapes: GeoShape[]): [number, number][] {
  const out: [number, number][] = [];
  for (const s of shapes) {
    if (s.kind === 'point') out.push([s.lat, s.lng]);
    else if (s.kind === 'line') out.push(...s.path);
    else for (const r of s.rings) out.push(...r);
  }
  return out;
}

/** Center + zoom that frames every shape within the box (single point → a sensible street zoom). */
function fitView(shapes: GeoShape[], width: number, height: number, maxZoom = 16): { center: [number, number]; zoom: number } {
  const pts = coordsOf(shapes);
  if (!pts.length || width <= 0) return { center: DEFAULT_CENTER, zoom: MIN_ZOOM };
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [la, ln] of pts) {
    minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la);
    minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln);
  }
  const center: [number, number] = [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
  if (minLat === maxLat && minLng === maxLng) return { center, zoom: Math.min(maxZoom, 15) };
  for (let z = maxZoom; z >= MIN_ZOOM; z--) {
    const [x1, y1] = project(maxLat, minLng, z);
    const [x2, y2] = project(minLat, maxLng, z);
    if (Math.abs(x2 - x1) <= width * 0.85 && Math.abs(y2 - y1) <= height * 0.85) return { center, zoom: z };
  }
  return { center, zoom: MIN_ZOOM };
}

function buildTiles(center: [number, number], zoom: number, width: number, height: number, theme: 'light' | 'dark') {
  const [cx, cy] = project(center[0], center[1], zoom);
  const tlx = cx - width / 2;
  const tly = cy - height / 2;
  const scale = 2 ** zoom;
  const tiles: { key: string; left: number; top: number; uri: string }[] = [];
  for (let tx = Math.floor(tlx / TILE); tx <= Math.floor((tlx + width) / TILE); tx++) {
    for (let ty = Math.floor(tly / TILE); ty <= Math.floor((tly + height) / TILE); ty++) {
      if (ty < 0 || ty >= scale) continue;
      const wx = ((tx % scale) + scale) % scale;
      tiles.push({ key: `${zoom}/${tx}/${ty}`, left: tx * TILE - tlx, top: ty * TILE - tly, uri: tileUri(theme, zoom, wx, ty) });
    }
  }
  return { tiles, tlx, tly };
}

function toPath(coords: [number, number][], toScreen: (lat: number, lng: number) => [number, number], close: boolean): string {
  if (!coords.length) return '';
  const d = coords.map(([lat, lng], i) => { const [x, y] = toScreen(lat, lng); return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');
  return close ? `${d} Z` : d;
}

/** Read-only map plotting `shapes`, auto-fit to their bounds. `interactive` enables pan + zoom. */
export function GeoMap({ shapes, theme, height = 200, host, interactive = false }: { shapes: GeoShape[]; theme: 'light' | 'dark'; height?: number; host?: DivHost; interactive?: boolean }) {
  const c = colors(theme);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState<{ center: [number, number]; zoom: number } | null>(null);
  const moved = useRef(false);

  // Auto-fit to the data until the user pans/zooms.
  useEffect(() => {
    if (width > 0 && !moved.current) setView(fitView(shapes, width, height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, shapes]);

  const center = view?.center ?? DEFAULT_CENTER;
  const zoom = view?.zoom ?? MIN_ZOOM;

  const live = useRef({ center, zoom });
  live.current = { center, zoom };
  const grab = useRef<{ world: [number, number] } | null>(null);
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        host?.lockScroll?.(true); // freeze the page so the map owns this pan
        const { center: ctr, zoom: z } = live.current;
        grab.current = { world: project(ctr[0], ctr[1], z) };
      },
      onPanResponderMove: (_e, g) => {
        const start = grab.current;
        if (!start) return;
        moved.current = true;
        const z = live.current.zoom;
        setView({ center: unproject(start.world[0] - g.dx, start.world[1] - g.dy, z), zoom: z });
      },
      onPanResponderRelease: () => { host?.lockScroll?.(false); grab.current = null; },
      onPanResponderTerminate: () => { host?.lockScroll?.(false); grab.current = null; },
    }),
  ).current;

  const geom = useMemo(() => {
    if (width <= 0) return null;
    const { tiles, tlx, tly } = buildTiles(center, zoom, width, height, theme);
    const toScreen = (lat: number, lng: number): [number, number] => {
      const [wx, wy] = project(lat, lng, zoom);
      return [wx - tlx, wy - tly];
    };
    const markers: { left: number; top: number; href?: string }[] = [];
    const paths: { d: string; fill: boolean }[] = [];
    for (const s of shapes) {
      if (s.kind === 'point') {
        const [x, y] = toScreen(s.lat, s.lng);
        markers.push({ left: x, top: y, href: s.href });
      } else if (s.kind === 'line') {
        paths.push({ d: toPath(s.path, toScreen, false), fill: false });
      } else {
        for (const r of s.rings) paths.push({ d: toPath(r, toScreen, true), fill: true });
      }
    }
    return { tiles, markers, paths };
  }, [width, height, center, zoom, shapes]);

  const zoomBy = (d: number) => { moved.current = true; setView({ center, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom + d)) }); };

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      {...(interactive ? pan.panHandlers : {})}
      style={{ height, borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: 'hidden', backgroundColor: c.surface }}
    >
      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
        {geom?.tiles.map((t) => (
          <Image key={t.key} source={{ uri: t.uri }} style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE }} fadeDuration={0} />
        ))}
      </View>

      {geom && geom.paths.length > 0 ? (
        <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
          {geom.paths.map((p, i) => (
            <Path key={i} d={p.d} fill={p.fill ? c.primary : 'none'} fillOpacity={p.fill ? 0.18 : 0} stroke={c.primary} strokeWidth={2} strokeLinejoin="round" />
          ))}
        </Svg>
      ) : null}

      {geom?.markers.map((m, i) => {
        const dot = { position: 'absolute' as const, left: m.left - 8, top: m.top - 8, width: 16, height: 16, borderRadius: 8, backgroundColor: c.primary, borderWidth: 2, borderColor: '#fff' };
        return m.href && host ? (
          <Pressable key={i} onPress={() => host.fire(m.href!)} style={dot} hitSlop={8} />
        ) : (
          <View key={i} pointerEvents="none" style={dot} />
        );
      })}

      {interactive ? (
        <View style={{ position: 'absolute', top: 8, right: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
          {(['+', '−'] as const).map((sym, i) => (
            <Pressable
              key={sym}
              onPress={() => zoomBy(sym === '+' ? 1 : -1)}
              style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: c.card, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
            >
              <Text style={{ fontSize: 20, fontWeight: '600', color: c.text, lineHeight: 22 }}>{sym}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View pointerEvents="none" style={{ position: 'absolute', bottom: 0, right: 0, backgroundColor: 'rgba(255,255,255,0.7)', paddingHorizontal: 4, borderTopLeftRadius: 4 }}>
        <Text style={{ fontSize: 9, color: '#333' }}>© OpenStreetMap, CARTO</Text>
      </View>
    </View>
  );
}

/**
 * `onno-geo` — the read-only detail map for a `.widget("map")` field. The server emits
 * `custom_props.geo = { value: "lat,lng" (or GeoJSON), label }`; we plot it pinned. Falls back to
 * the raw text when the value isn't valid geometry (mirrors the web GeoView), so nothing is swallowed.
 */
export const onnoGeo: CustomRenderer = ({ customProps, host }) => {
  const geo = (customProps.geo as { value?: string; label?: string } | undefined) ?? {};
  const shapes = toShapes(geo.value, { label: geo.label });
  if (!shapes.length) {
    const c = colors(host.theme);
    return <Text style={{ fontSize: 14, color: c.text }}>{geo.value ? String(geo.value) : '—'}</Text>;
  }
  return <GeoMap shapes={shapes} theme={host.theme} height={200} host={host} />;
};

// ===== ListMapView — the map alternative to an onno-list's table =====
// Fetches the entity's rows (capped — a map can't virtualize) and plots the ones with geometry as
// tappable markers/shapes; tapping a marker opens the record. The RN counterpart of the web SPA's
// list-map-view.tsx, drawn with the same hand-written GeoMap (no map SDK).

const MAP_CAP = 1000;

/** A record's feature label: the configured label column (display value), else a system id. */
function labelForRow(row: Record<string, any>, labelField?: string): string {
  const candidates = [
    labelField ? row[`${labelField}_display`] ?? row[labelField] : undefined,
    row._description,
    row._number,
    row._code,
  ];
  for (const v of candidates) if (v != null && String(v).trim() !== '') return String(v);
  return '';
}

export function ListMapView({
  kind,
  name,
  source,
  labelField,
  host,
  height = 520,
}: {
  kind: string;
  name: string;
  source: GeoSource;
  labelField?: string;
  host: DivHost;
  height?: number;
}) {
  const c = colors(host.theme);
  const [rows, setRows] = useState<Record<string, any>[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let alive = true;
    setRows(null);
    host.client
      .listRows(kind, name, { limit: MAP_CAP, offset: 0 })
      .then((r) => {
        if (alive) {
          setRows(r.rows);
          setTotal(r.total);
        }
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [kind, name]);

  const shapes = useMemo(() => {
    if (!rows) return [];
    const out: GeoShape[] = [];
    for (const row of rows) {
      const href = row._id != null ? `onno://${kind}/${name}/${row._id}` : undefined;
      out.push(...shapesFromRow(row, source, { label: labelForRow(row, labelField), href }));
    }
    return out;
  }, [rows, source, kind, name, labelField]);

  if (rows === null) {
    return (
      <View style={{ height, marginTop: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surface }}>
        <ActivityIndicator color={c.text} />
      </View>
    );
  }

  // One record can contribute a marker + a shape, so count distinct record hrefs.
  const placed = new Set(shapes.map((s) => s.href).filter(Boolean)).size;
  return (
    <View style={{ marginTop: 12, gap: 6 }}>
      <GeoMap shapes={shapes} theme={host.theme} height={height} host={host} interactive />
      <Text style={{ fontSize: 12, color: c.muted }}>
        {shapes.length === 0 ? 'No records with a location.' : `${placed} ${placed === 1 ? 'record' : 'records'} on the map`}
        {total > rows.length ? ` · showing first ${rows.length} of ${total} rows` : ''}
      </Text>
    </View>
  );
}

// ===== MapEditor — the geometry editor for a `.widget("geojson")` field =====
// Draw and edit points, paths (lines), and areas (polygons) over the themed basemap, storing the
// result as a GeoJSON FeatureCollection string. Pick a tool and tap to add points/vertices; tap
// Finish to complete a line/area; drag the round handles to reshape; long-press a shape to delete.
// The RN counterpart of the web SPA's map-editor.tsx (no MapLibre draw plugin).

type EditKind = 'point' | 'line' | 'area';
interface EditFeature {
  kind: EditKind;
  pts: [number, number][]; // [lat, lng]; an area's ring is stored open (no closing duplicate)
}

/** Parse the stored GeoJSON (or legacy "lat,lng") into editable features. */
function valueToEdit(value?: string): EditFeature[] {
  const out: EditFeature[] = [];
  for (const s of toShapes(value)) {
    if (s.kind === 'point') out.push({ kind: 'point', pts: [[s.lat, s.lng]] });
    else if (s.kind === 'line') out.push({ kind: 'line', pts: s.path });
    else {
      const ring = s.rings[0] ?? [];
      const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
      const open = closed ? ring.slice(0, -1) : ring;
      if (open.length) out.push({ kind: 'area', pts: open });
    }
  }
  return out;
}

/** Serialize editable features to a GeoJSON FeatureCollection string ("" when empty). */
function editToValue(features: EditFeature[]): string {
  if (!features.length) return '';
  const toLngLat = (pts: [number, number][]) => pts.map(([la, ln]) => [ln, la]);
  const fc = {
    type: 'FeatureCollection',
    features: features.map((f) => {
      if (f.kind === 'point') return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [f.pts[0][1], f.pts[0][0]] } };
      if (f.kind === 'line') return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: toLngLat(f.pts) } };
      const ring = toLngLat(f.pts);
      if (ring.length) ring.push(ring[0]); // close the polygon ring
      return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
    }),
  };
  return JSON.stringify(fc);
}

function screenPath(pts: [number, number][], close: boolean): string {
  if (!pts.length) return '';
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return close ? `${d} Z` : d;
}

// Screen-space hit tests for long-press delete (geometry projected to px first).
function pointInPoly(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function MapEditor({ value, onChange, theme, height = 340, lockScroll }: { value?: string; onChange: (v: string) => void; theme: 'light' | 'dark'; height?: number; lockScroll?: (locked: boolean) => void }) {
  const c = colors(theme);
  const [features, setFeatures] = useState<EditFeature[]>(() => valueToEdit(value));
  const [draft, setDraft] = useState<{ kind: 'line' | 'area'; pts: [number, number][] } | null>(null);
  const [tool, setTool] = useState<EditKind | null>(null);
  const [center, setCenter] = useState<[number, number]>(DEFAULT_CENTER);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [width, setWidth] = useState(0);
  const framed = useRef(false);

  const featuresRef = useRef(features);
  featuresRef.current = features;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const live = useRef({ center, zoom, width });
  live.current = { center, zoom, width };
  const lastEmitted = useRef(editToValue(features));

  const emit = (next: EditFeature[]) => {
    const str = editToValue(next);
    lastEmitted.current = str;
    onChange(str);
  };

  // Frame to existing geometry once we know our width.
  useEffect(() => {
    if (width <= 0 || framed.current) return;
    framed.current = true;
    const shapes = toShapes(value);
    if (shapes.length) {
      const v = fitView(shapes, width, height);
      setCenter(v.center);
      setZoom(v.zoom);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  // An external value change (form reset / record load) we didn't emit reloads the geometry.
  useEffect(() => {
    if ((value ?? '') === lastEmitted.current) return;
    const next = valueToEdit(value);
    lastEmitted.current = editToValue(next);
    setFeatures(next);
    setDraft(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const toScreen = (lat: number, lng: number, ct: [number, number], z: number, w: number): [number, number] => {
    const [cx, cy] = project(ct[0], ct[1], z);
    const [wx, wy] = project(lat, lng, z);
    return [wx - (cx - w / 2), wy - (cy - height / 2)];
  };
  const screenToLatLng = (sx: number, sy: number): [number, number] => {
    const { center: ct, zoom: z, width: w } = live.current;
    const [cx, cy] = project(ct[0], ct[1], z);
    return unproject(cx - w / 2 + sx, cy - height / 2 + sy, z);
  };
  const hitHandle = (sx: number, sy: number): { fi: number; vi: number } | null => {
    const { center: ct, zoom: z, width: w } = live.current;
    for (let fi = featuresRef.current.length - 1; fi >= 0; fi--) {
      const f = featuresRef.current[fi];
      for (let vi = 0; vi < f.pts.length; vi++) {
        const [x, y] = toScreen(f.pts[vi][0], f.pts[vi][1], ct, z, w);
        if ((x - sx) ** 2 + (y - sy) ** 2 <= 20 * 20) return { fi, vi };
      }
    }
    return null;
  };
  const hitShape = (sx: number, sy: number): number | null => {
    const { center: ct, zoom: z, width: w } = live.current;
    for (let fi = featuresRef.current.length - 1; fi >= 0; fi--) {
      const f = featuresRef.current[fi];
      const pts = f.pts.map(([la, ln]) => toScreen(la, ln, ct, z, w));
      if (f.kind === 'point') {
        if (Math.hypot(pts[0][0] - sx, pts[0][1] - sy) <= 12) return fi;
      } else if (f.kind === 'line') {
        for (let i = 1; i < pts.length; i++) if (distToSeg(sx, sy, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= 8) return fi;
      } else if (pointInPoly(sx, sy, pts)) {
        return fi;
      }
    }
    return null;
  };

  const grab = useRef<{ sx: number; sy: number; world: [number, number]; vertex: { fi: number; vi: number } | null; moved: number } | null>(null);
  const lp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearLp = () => {
    if (lp.current) {
      clearTimeout(lp.current);
      lp.current = null;
    }
  };
  const deleteAt = (fi: number) => {
    const next = featuresRef.current.filter((_, i) => i !== fi);
    setFeatures(next);
    emit(next);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        lockScroll?.(true); // freeze the page while drawing/dragging on the editor
        const sx = e.nativeEvent.locationX;
        const sy = e.nativeEvent.locationY;
        const { center: ct, zoom: z } = live.current;
        const vertex = hitHandle(sx, sy);
        grab.current = { sx, sy, world: project(ct[0], ct[1], z), vertex, moved: 0 };
        clearLp();
        // Long-press a shape to delete it (only when not drawing and not grabbing a handle).
        if (!vertex && !toolRef.current) {
          lp.current = setTimeout(() => {
            const fi = hitShape(sx, sy);
            if (fi != null) {
              deleteAt(fi);
              if (grab.current) grab.current.moved = 999; // suppress the release tap
            }
          }, 500);
        }
      },
      onPanResponderMove: (_e, g) => {
        const G = grab.current;
        if (!G) return;
        G.moved = Math.max(G.moved, Math.abs(g.dx) + Math.abs(g.dy));
        if (G.moved > 2) clearLp();
        if (G.vertex) {
          const ll = screenToLatLng(G.sx + g.dx, G.sy + g.dy);
          const { fi, vi } = G.vertex;
          const next = featuresRef.current.map((f, i) => (i === fi ? { ...f, pts: f.pts.map((p, j) => (j === vi ? ll : p)) } : f));
          featuresRef.current = next;
          setFeatures(next);
        } else if (G.moved > 2) {
          const z = live.current.zoom;
          setCenter(unproject(G.world[0] - g.dx, G.world[1] - g.dy, z));
        }
      },
      onPanResponderRelease: (_e, g) => {
        lockScroll?.(false);
        clearLp();
        const G = grab.current;
        grab.current = null;
        if (!G) return;
        if (G.vertex) {
          emit(featuresRef.current);
          return;
        }
        if (G.moved + Math.abs(g.dx) + Math.abs(g.dy) >= 6) return; // a pan, or a suppressed long-press
        const ll = screenToLatLng(G.sx, G.sy);
        const t = toolRef.current;
        if (t === 'point') {
          const next = [...featuresRef.current, { kind: 'point' as const, pts: [ll] }];
          setFeatures(next);
          emit(next);
        } else if (t === 'line' || t === 'area') {
          setDraft((prev) => (prev ? { ...prev, pts: [...prev.pts, ll] } : { kind: t, pts: [ll] }));
        }
      },
      onPanResponderTerminate: () => {
        lockScroll?.(false);
        clearLp();
        grab.current = null;
      },
    }),
  ).current;

  const finish = () => {
    const d = draftRef.current;
    if (!d) return;
    const ok = d.kind === 'line' ? d.pts.length >= 2 : d.pts.length >= 3;
    setDraft(null);
    if (!ok) return;
    const next = [...featuresRef.current, { kind: d.kind, pts: d.pts }];
    setFeatures(next);
    emit(next);
  };
  const undo = () => {
    const d = draftRef.current;
    if (d && d.pts.length > 0) {
      setDraft(d.pts.length > 1 ? { ...d, pts: d.pts.slice(0, -1) } : null);
      return;
    }
    const next = featuresRef.current.slice(0, -1);
    setFeatures(next);
    emit(next);
  };
  const clearAll = () => {
    setDraft(null);
    setFeatures([]);
    emit([]);
  };
  const pick = (t: EditKind) => {
    setDraft(null);
    setTool((cur) => (cur === t ? null : t));
  };
  const zoomBy = (d: number) => setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z + d)));

  const render = useMemo(() => {
    if (width <= 0) return null;
    const { tiles, tlx, tly } = buildTiles(center, zoom, width, height, theme);
    const scr = (la: number, ln: number): [number, number] => {
      const [wx, wy] = project(la, ln, zoom);
      return [wx - tlx, wy - tly];
    };
    const fills: string[] = [];
    const lines: string[] = [];
    const points: [number, number][] = [];
    const handles: [number, number][] = [];
    for (const f of features) {
      const pts = f.pts.map(([la, ln]) => scr(la, ln));
      pts.forEach((p) => handles.push(p));
      if (f.kind === 'point') points.push(pts[0]);
      else if (f.kind === 'line') lines.push(screenPath(pts, false));
      else fills.push(screenPath(pts, true));
    }
    let draftPath: { d: string; area: boolean } | null = null;
    if (draft && draft.pts.length) {
      const pts = draft.pts.map(([la, ln]) => scr(la, ln));
      const area = draft.kind === 'area' && pts.length >= 3;
      pts.forEach((p) => handles.push(p));
      draftPath = { d: screenPath(pts, area), area };
    }
    return { tiles, fills, lines, points, handles, draftPath };
  }, [width, height, center, zoom, theme, features, draft]);

  const Btn = ({ label, onPress, active, disabled }: { label: string; onPress: () => void; active?: boolean; disabled?: boolean }) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: active ? c.primary : c.fieldBorder, backgroundColor: active ? c.primary : c.fieldBg, opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ fontSize: 13, fontWeight: '600', color: active ? '#fff' : c.text }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Btn label="Point" active={tool === 'point'} onPress={() => pick('point')} />
        <Btn label="Line" active={tool === 'line'} onPress={() => pick('line')} />
        <Btn label="Area" active={tool === 'area'} onPress={() => pick('area')} />
        <View style={{ width: 1, height: 22, backgroundColor: c.border, marginHorizontal: 2 }} />
        <Btn label="Finish" disabled={!draft} onPress={finish} />
        <Btn label="Undo" onPress={undo} />
        <Btn label="Clear" onPress={clearAll} />
      </View>

      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        {...pan.panHandlers}
        style={{ height, borderRadius: 10, borderWidth: 1, borderColor: c.border, overflow: 'hidden', backgroundColor: c.surface }}
      >
        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
          {render?.tiles.map((t) => (
            <Image key={t.key} source={{ uri: t.uri }} style={{ position: 'absolute', left: t.left, top: t.top, width: TILE, height: TILE }} fadeDuration={0} />
          ))}
        </View>

        {render && width > 0 ? (
          <Svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0 }} pointerEvents="none">
            {render.fills.map((d, i) => (
              <Path key={`f${i}`} d={d} fill={c.primary} fillOpacity={0.18} stroke={c.primary} strokeWidth={2.5} strokeLinejoin="round" />
            ))}
            {render.lines.map((d, i) => (
              <Path key={`l${i}`} d={d} fill="none" stroke={c.primary} strokeWidth={2.5} strokeLinejoin="round" />
            ))}
            {render.draftPath ? (
              <Path d={render.draftPath.d} fill={render.draftPath.area ? c.primary : 'none'} fillOpacity={render.draftPath.area ? 0.1 : 0} stroke={c.primary} strokeWidth={2} strokeDasharray="6 4" />
            ) : null}
            {render.points.map(([x, y], i) => (
              <Circle key={`p${i}`} cx={x} cy={y} r={6} fill={c.primary} stroke="#fff" strokeWidth={2} />
            ))}
            {render.handles.map(([x, y], i) => (
              <Circle key={`h${i}`} cx={x} cy={y} r={5} fill={c.surface} stroke={c.primary} strokeWidth={2} />
            ))}
          </Svg>
        ) : null}

        <View style={{ position: 'absolute', top: 8, right: 8, borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
          {(['+', '−'] as const).map((sym, i) => (
            <Pressable
              key={sym}
              onPress={() => zoomBy(sym === '+' ? 1 : -1)}
              style={{ width: 34, height: 34, alignItems: 'center', justifyContent: 'center', backgroundColor: c.card, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
            >
              <Text style={{ fontSize: 20, fontWeight: '600', color: c.text, lineHeight: 22 }}>{sym}</Text>
            </Pressable>
          ))}
        </View>

        <View pointerEvents="none" style={{ position: 'absolute', bottom: 0, right: 0, backgroundColor: 'rgba(255,255,255,0.7)', paddingHorizontal: 4, borderTopLeftRadius: 4 }}>
          <Text style={{ fontSize: 9, color: '#333' }}>© OpenStreetMap, CARTO</Text>
        </View>
      </View>

      <Text style={{ fontSize: 11, color: c.muted }}>
        {tool === 'point'
          ? 'Tap the map to drop points.'
          : tool
            ? 'Tap to add vertices; tap Finish to complete. Drag handles to reshape.'
            : 'Pick a tool to draw. Drag a handle to reshape; long-press a shape to delete.'}
      </Text>
    </View>
  );
}
