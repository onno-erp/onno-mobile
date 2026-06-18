// Maps DivKit visual props onto React Native style objects. This is the
// platform-specific half of the renderer — the part the Svelte web SDK does
// against the DOM/CSS, redone for RN's flexbox + StyleSheet model.

import type { TextStyle, ViewStyle } from 'react-native';
import type { DivBlock, DivEdge, DivSize } from './types';

/** DivKit colors are `#AARRGGBB` (alpha first); RN wants `#RRGGBBAA`. */
export function color(c?: string): string | undefined {
  if (!c) return undefined;
  const hex = c.replace('#', '');
  if (hex.length === 8) {
    const a = hex.slice(0, 2);
    const rgb = hex.slice(2);
    return `#${rgb}${a}`;
  }
  return c; // #RGB / #RRGGBB pass straight through
}

export function edge(e: DivEdge | undefined, prefix: 'padding' | 'margin'): ViewStyle {
  if (!e) return {};
  const s: Record<string, number> = {};
  const cap = prefix === 'padding' ? 'padding' : 'margin';
  if (e.horizontal != null) s[`${cap}Horizontal`] = e.horizontal;
  if (e.vertical != null) s[`${cap}Vertical`] = e.vertical;
  if (e.left != null) s[`${cap}Left`] = e.left;
  if (e.right != null) s[`${cap}Right`] = e.right;
  if (e.start != null) s[`${cap}Start`] = e.start;
  if (e.end != null) s[`${cap}End`] = e.end;
  if (e.top != null) s[`${cap}Top`] = e.top;
  if (e.bottom != null) s[`${cap}Bottom`] = e.bottom;
  return s as ViewStyle;
}

/** Translate a DivKit size into RN width/height + flex behaviour. */
export function size(sz: DivSize | undefined, axis: 'width' | 'height'): ViewStyle {
  if (!sz) return {};
  if (sz.type === 'fixed') return { [axis]: sz.value } as ViewStyle;
  if (sz.type === 'match_parent') {
    // `weight` means "share of the parent's main axis" → flexGrow.
    if (sz.weight != null) return { flexGrow: sz.weight, flexShrink: 1, flexBasis: 0 };
    return { [axis === 'width' ? 'alignSelf' : axis]: axis === 'width' ? 'stretch' : '100%' } as ViewStyle;
  }
  // wrap_content is RN's default.
  return {};
}

const H_ALIGN: Record<string, ViewStyle['alignItems']> = {
  left: 'flex-start', start: 'flex-start',
  center: 'center',
  right: 'flex-end', end: 'flex-end',
};
const V_ALIGN: Record<string, ViewStyle['justifyContent']> = {
  top: 'flex-start',
  center: 'center',
  bottom: 'flex-end',
};

/** True when a horizontal row splits into weighted columns (a label/value-style row). */
function hasWeightedChild(items?: DivBlock[]): boolean {
  return !!items?.some((c) => {
    const w = c.width as { type?: string; weight?: number } | undefined;
    return w?.type === 'match_parent' && w.weight != null;
  });
}

/** Container layout: orientation + cross/main-axis content alignment. */
export function containerStyle(b: DivBlock): ViewStyle {
  const horizontal = b.orientation === 'horizontal';
  const style: ViewStyle = {
    flexDirection: horizontal ? 'row' : 'column',
  };
  if (typeof b.item_spacing === 'number') {
    style.gap = b.item_spacing;
  } else if (horizontal && hasWeightedChild(b.items)) {
    // Label/value split rows (detail field rows: label weight 2, value weight 3) ship with
    // no gap, so a long label butts right against its value. Give the columns breathing room.
    style.gap = 12;
  }
  // In RN, alignItems is the cross axis, justifyContent the main axis.
  const ch = b.content_alignment_horizontal;
  const cv = b.content_alignment_vertical;
  if (horizontal) {
    if (ch) style.justifyContent = V_ALIGN[ch] ?? H_ALIGN[ch] as any;
    if (cv) style.alignItems = H_ALIGN[cv] ?? V_ALIGN[cv] as any;
  } else {
    if (ch) style.alignItems = H_ALIGN[ch];
    if (cv) style.justifyContent = V_ALIGN[cv];
  }
  return style;
}

const WEIGHT: Record<string, TextStyle['fontWeight']> = {
  light: '300',
  regular: '400',
  medium: '500',
  bold: '700',
};

export function textStyle(b: DivBlock): TextStyle {
  const s: TextStyle = {};
  if (b.font_size != null) s.fontSize = b.font_size;
  if (b.font_weight) s.fontWeight = WEIGHT[b.font_weight] ?? (b.font_weight as TextStyle['fontWeight']);
  const tc = color(b.text_color);
  if (tc) s.color = tc;
  if (b.text_alignment_horizontal) s.textAlign = b.text_alignment_horizontal as TextStyle['textAlign'];
  return s;
}

/** Shared box props: paddings, margins, size, background, border, alpha. */
export function boxStyle(b: DivBlock): ViewStyle {
  const s: ViewStyle = {
    ...edge(b.paddings, 'padding'),
    ...edge(b.margins, 'margin'),
    ...size(b.width, 'width'),
    ...size(b.height, 'height'),
  };
  const bg = b.background?.find((x) => x.type === 'solid' && x.color);
  if (bg) s.backgroundColor = color(bg.color);
  if (b.border?.corner_radius != null) s.borderRadius = b.border.corner_radius;
  if (b.border?.stroke?.color) {
    s.borderColor = color(b.border.stroke.color);
    s.borderWidth = b.border.stroke.width ?? 1;
  }
  if (b.alpha != null) s.opacity = b.alpha;
  if (b.alignment_horizontal) s.alignSelf = H_ALIGN[b.alignment_horizontal] as ViewStyle['alignSelf'];
  return s;
}
