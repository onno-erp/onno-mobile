// The recursive renderer: one DivKit block → native RN components. Targets RN's
// View / Text / Image / ScrollView. Templates are resolved up front; @{…}
// expressions in this node's own props are resolved here against the variables.

import React from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { resolve, resolveString, type Variables } from './expr';
import { CustomPlaceholder, getCustom } from './registry';
import { boxStyle, color, containerStyle, textStyle } from './style';
import type { DivAction, DivBlock, DivHost } from './types';

interface Ctx {
  vars: Variables;
  host: DivHost;
}

export function Div({ block: rawBlock, ctx }: { block: DivBlock; ctx: Ctx }): React.ReactElement | null {
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

  switch (block.type) {
    case 'text': {
      const node = (
        <Text style={[textStyle(block), boxStyle(block)]} numberOfLines={block.max_lines}>
          {resolveString(block.text, ctx.vars)}
        </Text>
      );
      return onPress ? (
        <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}>
          {node}
        </Pressable>
      ) : (
        node
      );
    }

    case 'image': {
      const uri = absolutize(resolveString(block.image_url, ctx.vars), ctx.host.baseUrl);
      const img = <Image source={{ uri }} style={[{ width: 40, height: 40 }, baseStyle] as any} resizeMode="cover" />;
      return onPress ? <Pressable onPress={onPress}>{img}</Pressable> : img;
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

    case 'gallery':
      return (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={containerStyle({ ...block, orientation: 'horizontal' })}
          style={baseStyle}
        >
          {(block.items ?? []).map((c, i) => (
            <Div key={i} block={c} ctx={ctx} />
          ))}
        </ScrollView>
      );

    case 'grid': {
      const cols = block.column_count ?? 2;
      return (
        <Box style={[{ flexDirection: 'row', flexWrap: 'wrap' }, baseStyle]} onPress={onPress}>
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
      return onPress ? <Box style={baseStyle} onPress={onPress}>{inner}</Box> : inner;
    }

    case 'custom': {
      const type = block.custom_type ?? '';
      const renderer = getCustom(type);
      const inner = renderer
        ? renderer({ block, customProps: block.custom_props ?? {}, host: ctx.host })
        : <CustomPlaceholder type={type} />;
      return <Box style={baseStyle} onPress={onPress}>{inner}</Box>;
    }

    case 'container':
    default:
      return (
        <Box style={[containerStyle(block), baseStyle]} onPress={onPress}>
          {(block.items ?? []).map((c, i) => (
            <Div key={i} block={c} ctx={ctx} />
          ))}
        </Box>
      );
  }
}

/** A layout box that becomes a Pressable (carrying the same style → same flex)
 *  when given an onPress, else a plain View. */
function Box({
  style,
  onPress,
  children,
}: {
  style: StyleProp<ViewStyle>;
  onPress?: () => void;
  children: React.ReactNode;
}) {
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [style, pressed ? { opacity: 0.6 } : null]}>
      {children}
    </Pressable>
  );
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
