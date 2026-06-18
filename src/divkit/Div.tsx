// The recursive renderer: one DivKit block → native RN components. Targets RN's
// View / Text / Image / ScrollView. Templates are resolved up front; @{…}
// expressions in this node's own props are resolved here against the variables.

import React, { useEffect, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { resolve, resolveString, type Variables } from './expr';
import { ContextMenuArea, hasLinkMenu } from './longPress';
import { CustomPlaceholder, getCustom } from './registry';
import { boxStyle, color, containerStyle, textStyle } from './style';
import { colors } from './theme';
import { toast } from '../ui/toast';
import type { DivAction, DivBlock, DivHost } from './types';

// Make URLs / emails / phone numbers inside displayed text tappable. Phone matching is
// conservative (needs a leading + or separators) so it doesn't turn plain integers/IDs
// into links. Only the matched runs become tappable; the rest renders unchanged.
const LINK_RE =
  /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+|[\w.+-]+@[\w-]+\.[\w.-]+|\+\d[\d().\-\s]{6,}\d|\(\d{2,4}\)[\d().\-\s]{4,}\d|\b\d{3}[\s.\-]\d{3,4}[\s.\-]\d{3,4}\b)/g;

function hrefFor(m: string): string {
  if (/^https?:\/\//i.test(m)) return m;
  if (/^www\./i.test(m)) return 'https://' + m;
  if (m.includes('@')) return 'mailto:' + m.trim();
  return 'tel:' + m.replace(/[^\d+]/g, '');
}

function openLink(href: string): void {
  Linking.openURL(href).catch(() => toast.error("Couldn't open it"));
}

/** Split text into plain + linkable runs (url / email / phone); null when there are none. */
function linkify(text: string): Array<{ t: string; href?: string }> | null {
  if (!text) return null;
  LINK_RE.lastIndex = 0;
  if (!LINK_RE.test(text)) return null;
  LINK_RE.lastIndex = 0;
  const out: Array<{ t: string; href?: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index) });
    out.push({ t: m[0], href: hrefFor(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last) });
  return out;
}

interface Ctx {
  vars: Variables;
  host: DivHost;
}

function DivImpl({ block: rawBlock, ctx }: { block: DivBlock; ctx: Ctx }): React.ReactElement | null {
  if (!rawBlock || typeof rawBlock !== 'object') return null;
  // Resolve @{…} in this node's own props (colors, text, sizes, action urls).
  // Children resolve themselves; custom_props are left to the custom renderer.
  const block = resolveProps(rawBlock, ctx.vars) as DivBlock;
  if (block.visibility === 'gone') return null;

  const invisible = block.visibility === 'invisible';
  const baseStyle: StyleProp<ViewStyle> = [boxStyle(block), invisible ? { opacity: 0 } : null];

  // A single onPress, applied to the element that IS the layout box (so a
  // tappable container keeps its flexGrow/weight instead of being wrapped in a
  // content-sized Pressable).
  const actions: DivAction[] = block.actions ?? (block.action ? [block.action] : []);
  const onPress = actions.length
    ? () => {
        for (const a of actions) {
          const url = resolveString(a.url, ctx.vars);
          if (url) ctx.host.fire(url);
        }
      }
    : undefined;
  // Warm the destination on touch-down so it's usually ready by the time the tap
  // completes (best-effort; the host ignores non-navigation action urls).
  const onPressIn =
    actions.length && ctx.host.prefetch
      ? () => {
          for (const a of actions) {
            const url = resolveString(a.url, ctx.vars);
            if (url) ctx.host.prefetch!(url);
          }
        }
      : undefined;
  // Long-press = the web's right-click: a Copy link / Open in browser menu. Only
  // the first action that is a navigable link gets one, so non-link actions
  // (post/delete/…) keep their plain tap. `host` is threaded alongside so the
  // tappable element can be wrapped in <ContextMenuArea> (the gesture lives there).
  const menuUrl = actions.length
    ? actions.map((a) => resolveString(a.url, ctx.vars)).find((u) => u && hasLinkMenu(ctx.host, u))
    : undefined;

  switch (block.type) {
    case 'text': {
      // When tappable, the Pressable IS the layout box — it carries the weight/flex
      // and margins, and the Text keeps only its text styling. Otherwise a weighted
      // ref link (a tappable value with weight) collapses to its content width and the
      // label cell's weight shoves it to the right edge instead of filling the row.
      const raw = resolveString(block.text, ctx.vars);
      // Linkify plain values only — text that already has a tap action (ref cells, buttons)
      // keeps its action; we don't want a competing link inside it.
      const segs = onPress ? null : linkify(raw);
      const linkColor = colors(ctx.host.theme).primary;
      const text = (
        // Plain values are selectable (long-press to select / copy a field value); text that
        // has its own tap action (ref links, buttons) isn't, so selection doesn't fight the tap.
        <Text selectable={!onPress} style={[textStyle(block), onPress ? null : boxStyle(block)]} numberOfLines={block.max_lines}>
          {segs
            ? segs.map((s, i) =>
                s.href ? (
                  <Text key={i} style={{ color: linkColor, textDecorationLine: 'underline' }} onPress={() => openLink(s.href!)}>
                    {s.t}
                  </Text>
                ) : (
                  <Text key={i}>{s.t}</Text>
                ),
              )
            : raw}
        </Text>
      );
      return onPress ? (
        <ContextMenuArea host={ctx.host} url={menuUrl}>
          <Pressable onPress={onPress} onPressIn={onPressIn} style={({ pressed }) => [boxStyle(block), pressed ? { opacity: 0.6 } : null]}>
            {text}
          </Pressable>
        </ContextMenuArea>
      ) : (
        text
      );
    }

    case 'image': {
      const uri = absolutize(resolveString(block.image_url, ctx.vars), ctx.host.baseUrl);
      return <DivImage uri={uri} style={[{ width: 40, height: 40 }, baseStyle]} onPress={onPress} onPressIn={onPressIn} host={ctx.host} menuUrl={menuUrl} />;
    }

    case 'separator': {
      const horizontal = block.delimiter_style?.orientation !== 'vertical';
      return (
        <View
          style={[
            horizontal ? { height: 1, alignSelf: 'stretch' } : { width: 1, alignSelf: 'stretch' },
            { backgroundColor: color(block.delimiter_style?.color) ?? '#E5E7EB' },
            boxStyle(block),
          ]}
        />
      );
    }

    case 'gallery': {
      // A *bordered* horizontal scroll is a table (server's scrollX): the server puts the
      // border/background on the full-width scroll frame while the content (rows) is
      // wrap_content, so a narrow table leaves an empty bordered gap on the right. Fix:
      //  • move the decoration onto the content so the border wraps the rows, and
      //  • make the content fill the frame (flexGrow on the scroll content + a stretching
      //    wrapper) so the rows span the full width — fixed columns left-pack, the row
      //    backgrounds/separators/border reach the edge. A table wider than the screen
      //    still has extra width, so it scrolls as before.
      const bordered = !!block.border?.stroke?.color;
      let deco: ViewStyle | null = null;
      let frame: ViewStyle | null = null;
      if (bordered) {
        deco = { borderColor: color(block.border!.stroke!.color), borderWidth: block.border!.stroke!.width ?? 1, flexGrow: 1 };
        const bg = block.background?.find((x) => x.type === 'solid' && x.color);
        if (bg) deco.backgroundColor = color(bg.color);
        if (block.border?.corner_radius != null) {
          deco.borderRadius = block.border.corner_radius;
          deco.overflow = 'hidden';
        }
        // Strip the decoration off the (full-width) frame so it no longer draws the gap.
        frame = { backgroundColor: undefined, borderRadius: undefined, borderColor: undefined, borderWidth: undefined };
      }
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={[containerStyle({ ...block, orientation: 'horizontal' }), deco]}
          style={[baseStyle, frame]}
        >
          {(block.items ?? []).map((c, i) =>
            bordered ? (
              <View key={i} style={{ flexGrow: 1 }}>
                <Div block={c} ctx={ctx} />
              </View>
            ) : (
              <Div key={i} block={c} ctx={ctx} />
            ),
          )}
        </ScrollView>
      );
    }

    case 'grid': {
      const cols = block.column_count ?? 2;
      return (
        <Box style={[{ flexDirection: 'row', flexWrap: 'wrap' }, baseStyle]} onPress={onPress} onPressIn={onPressIn} host={ctx.host} menuUrl={menuUrl}>
          {(block.items ?? []).map((c, i) => (
            <View key={i} style={{ width: `${100 / cols}%` }}>
              <Div block={c} ctx={ctx} />
            </View>
          ))}
        </Box>
      );
    }

    case 'state': {
      const states = (block.states as Array<{ div: DivBlock }>) ?? [];
      const inner = states.length ? <Div block={states[0].div} ctx={ctx} /> : null;
      return onPress ? <Box style={baseStyle} onPress={onPress} onPressIn={onPressIn} host={ctx.host} menuUrl={menuUrl}>{inner}</Box> : inner;
    }

    case 'custom': {
      const type = block.custom_type ?? '';
      const renderer = getCustom(type);
      const inner = renderer
        ? renderer({ block, customProps: block.custom_props ?? {}, host: ctx.host })
        : <CustomPlaceholder type={type} />;
      return <Box style={baseStyle} onPress={onPress} onPressIn={onPressIn} host={ctx.host} menuUrl={menuUrl}>{inner}</Box>;
    }

    case 'container':
    default:
      return (
        <Box style={[containerStyle(block), baseStyle]} onPress={onPress} onPressIn={onPressIn} host={ctx.host} menuUrl={menuUrl}>
          {renderChildren(block.items ?? [], ctx)}
        </Box>
      );
  }
}

// Memoized so a re-render that doesn't change a subtree's block or ctx (vars)
// skips it — e.g. while a large container reveals its children chunk by chunk,
// the already-mounted children don't re-render.
export const Div = React.memo(DivImpl);

const CHUNK_FIRST = 12; // children rendered on the first frame
const CHUNK_STEP = 40; // children added per subsequent frame

/** Render a container's children. Small lists render directly; large ones mount
 *  progressively (a chunk per frame) so a heavy section never blocks the thread.
 *  Memoized Div keeps each step O(newly-revealed children). */
function renderChildren(items: DivBlock[], ctx: Ctx): React.ReactNode {
  if (items.length <= CHUNK_FIRST) {
    return items.map((c, i) => <Div key={i} block={c} ctx={ctx} />);
  }
  return <ChunkedChildren items={items} ctx={ctx} />;
}

function ChunkedChildren({ items, ctx }: { items: DivBlock[]; ctx: Ctx }) {
  const [limit, setLimit] = useState(CHUNK_FIRST);
  useEffect(() => {
    if (limit >= items.length) return;
    const raf = requestAnimationFrame(() => setLimit((n) => Math.min(n + CHUNK_STEP, items.length)));
    return () => cancelAnimationFrame(raf);
  }, [limit, items.length]);
  return (
    <>
      {items.slice(0, limit).map((c, i) => (
        <Div key={i} block={c} ctx={ctx} />
      ))}
    </>
  );
}

/** A layout box that becomes a Pressable (carrying the same style → same flex)
 *  when given an onPress, else a plain View. Wrapped in <ContextMenuArea> when its
 *  action is a link, so a long-press opens the Copy link / Open in browser menu. */
function Box({
  style,
  onPress,
  onPressIn,
  host,
  menuUrl,
  children,
}: {
  style: StyleProp<ViewStyle>;
  onPress?: () => void;
  onPressIn?: () => void;
  host?: DivHost;
  menuUrl?: string;
  children: React.ReactNode;
}) {
  if (!onPress) return <View style={style}>{children}</View>;
  const press = (
    <Pressable onPress={onPress} onPressIn={onPressIn} style={({ pressed }) => [style, pressed ? { opacity: 0.6 } : null]}>
      {children}
    </Pressable>
  );
  return host ? <ContextMenuArea host={host} url={menuUrl}>{press}</ContextMenuArea> : press;
}

// An image that collapses (renders nothing) if it fails to load, so a broken or
// offline url doesn't leave an empty sized box — e.g. the menu's brand logo when
// the device is offline, which otherwise reads as a large gap above the content.
function DivImage({
  uri,
  style,
  onPress,
  onPressIn,
  host,
  menuUrl,
}: {
  uri: string;
  style: StyleProp<ViewStyle>;
  onPress?: () => void;
  onPressIn?: () => void;
  host?: DivHost;
  menuUrl?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed || !uri) return null;
  const img = <Image source={{ uri }} style={style as any} resizeMode="cover" onError={() => setFailed(true)} />;
  if (!onPress) return img;
  const press = <Pressable onPress={onPress} onPressIn={onPressIn}>{img}</Pressable>;
  return host ? <ContextMenuArea host={host} url={menuUrl}>{press}</ContextMenuArea> : press;
}

// Shallow-deep resolve of a node's own expression-bearing props. Skips `items`
// (children render + resolve themselves) and `custom_props` (owned by the custom).
function resolveProps(node: unknown, vars: Variables): unknown {
  if (typeof node === 'string') return resolve(node, vars);
  if (Array.isArray(node)) return node.map((n) => resolveProps(n, vars));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = k === 'items' || k === 'custom_props' || k === 'states' ? v : resolveProps(v, vars);
    }
    return out;
  }
  return node;
}

function absolutize(url: string, baseUrl?: string): string {
  if (!url || !baseUrl) return url;
  if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url;
  return baseUrl.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

export { resolve };
