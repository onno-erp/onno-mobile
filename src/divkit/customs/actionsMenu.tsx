// onno-actions-menu — the detail/list action bar. custom_props.items:
// [{ label, icon, url, tone: accent|normal|danger, placement: primary|menu }].
// Primary items render as inline buttons; menu items collapse under a "⋯" toggle.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Modal, Pressable, Text, View } from 'react-native';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer } from '../types';
import { LucideIcon } from './lucide';
import { Touchable } from '../../ui/touchable';

interface Item {
  label: string;
  icon?: string;
  url: string;
  tone?: string;
  placement?: string;
}

interface Anchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MENU_WIDTH = 220;
const ROW_HEIGHT = 44; // approx height of one menu row, for flip estimation
const GAP = 6; // gap between the toggle and the popover

function toneOf(tone: string | undefined, c: ThemeColors): { bg: string; fg: string; border: string } {
  switch (tone) {
    case 'accent': return { bg: c.accentBg, fg: c.accentFg, border: c.accentBg };
    case 'danger': return { bg: c.dangerBg, fg: c.dangerFg, border: c.dangerBg };
    default: return { bg: c.card, fg: c.text, border: c.border };
  }
}

export const onnoActionsMenu: CustomRenderer = ({ block, host }) => {
  const c = colors(host.theme);
  // Layered key + ambient shadow (iOS-menu style); deeper in dark mode so the
  // popover still separates from a dark background. boxShadow needs the New
  // Architecture (default on SDK 56) and follows the border radius cleanly,
  // unlike the legacy shadow*/elevation combo.
  const menuShadow =
    host.theme === 'dark'
      ? '0px 12px 36px rgba(0,0,0,0.48), 0px 4px 12px rgba(0,0,0,0.30)'
      : '0px 12px 36px rgba(0,0,0,0.09), 0px 4px 12px rgba(0,0,0,0.05)';
  const items: Item[] = Array.isArray(block.custom_props?.items) ? (block.custom_props!.items as Item[]) : [];
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const toggleRef = useRef<View>(null);
  const primary = items.filter((i) => i.placement !== 'menu');
  const menu = items.filter((i) => i.placement === 'menu');

  // Measure the toggle in window coordinates, then open — so the popover can be
  // pinned to the button and float above everything via a Modal.
  const openMenu = () => {
    toggleRef.current?.measureInWindow((x, y, w, h) => setAnchor({ x, y, w, h }));
  };

  // Spring the menu open (scale up from the corner nearest the button) on mount.
  useEffect(() => {
    if (!anchor) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, stiffness: 280, damping: 22, mass: 0.9 }).start();
  }, [anchor, anim]);

  // Ease back out, then unmount. Used for outside-tap and hardware-back dismiss.
  const close = () => {
    Animated.timing(anim, { toValue: 0, duration: 120, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(
      ({ finished }) => finished && setAnchor(null),
    );
  };

  // Right-align the popover to the toggle's right edge; flip above the button
  // when there isn't room below it (e.g. a trigger near the bottom of the screen).
  let popover: { right: number; top?: number; bottom?: number; up: boolean } | null = null;
  if (anchor) {
    const screen = Dimensions.get('window');
    const menuH = menu.length * ROW_HEIGHT + 8;
    const right = Math.max(8, screen.width - (anchor.x + anchor.w));
    const up = anchor.y + anchor.h + GAP + menuH > screen.height - 24;
    popover = up
      ? { right, bottom: screen.height - anchor.y + GAP, up }
      : { right, top: anchor.y + anchor.h + GAP, up };
  }

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {primary.map((it, i) => {
          const t = toneOf(it.tone, c);
          return (
            <Touchable
              key={i}
              onPress={() => host.fire(it.url)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1 }}
            >
              {it.icon ? <LucideIcon name={it.icon} size={16} color={t.fg} /> : null}
              <Text style={{ fontSize: 13, fontWeight: '600', color: t.fg }}>{it.label}</Text>
            </Touchable>
          );
        })}
        {menu.length > 0 && (
          <Touchable ref={toggleRef} collapsable={false} onPress={openMenu} style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: c.card, borderWidth: 1, borderColor: c.border }}>
            <LucideIcon name="ellipsis" size={18} color={c.text} />
          </Touchable>
        )}
      </View>

      {menu.length > 0 && (
        <Modal visible={!!anchor} transparent animationType="none" onRequestClose={close}>
          {/* Transparent full-screen backdrop: tap anywhere outside to dismiss. */}
          <Pressable style={{ flex: 1 }} onPress={close}>
            {popover && (
              <Animated.View
                style={{
                  position: 'absolute',
                  right: popover.right,
                  top: popover.top,
                  bottom: popover.bottom,
                  width: MENU_WIDTH,
                  backgroundColor: c.card,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: c.border,
                  paddingVertical: 4,
                  // Grow from the corner closest to the button — top-right when
                  // dropping down, bottom-right when flipped up.
                  transformOrigin: popover.up ? ['100%', '100%', 0] : ['100%', '0%', 0],
                  opacity: anim.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }),
                  transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
                  // Float above content with a soft layered shadow (cross-platform
                  // on the New Architecture; follows the border radius).
                  boxShadow: menuShadow,
                }}
              >
                {menu.map((it, i) => (
                  <Touchable
                    key={i}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 }}
                    onPress={() => {
                      setAnchor(null);
                      host.fire(it.url);
                    }}
                  >
                    {it.icon ? <LucideIcon name={it.icon} size={16} color={it.tone === 'danger' ? c.dangerFg : c.text} /> : null}
                    <Text style={{ fontSize: 15, color: it.tone === 'danger' ? c.dangerFg : c.text }}>{it.label}</Text>
                  </Touchable>
                ))}
              </Animated.View>
            )}
          </Pressable>
        </Modal>
      )}
    </View>
  );
};
