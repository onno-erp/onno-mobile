// onno-icon / onno-hint — the lightweight chrome customs.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, Modal, Pressable, Text, View } from 'react-native';
import { color } from '../style';
import { colors, isDark, type ThemeColors } from '../theme';
import type { CustomRenderer } from '../types';
import { Touchable } from '../../ui/touchable';
import { LucideIcon } from './lucide';

// onno-icon: a lucide glyph by name. Highlights with `activeColor` when the
// card's `active_path` variable matches this icon's `activePath` (nav bar).
export const onnoIcon: CustomRenderer = ({ customProps, host }) => {
  const name = customProps.name as string | undefined;
  const size = Number(customProps.size ?? 16);
  const activePath = customProps.activePath as string | undefined;
  const activeColor = color(customProps.activeColor as string | undefined);
  const baseColor = color(customProps.color as string | undefined);
  const current = host.getVar('active_path');
  const isActive = !!activeColor && activePath != null && current === activePath;
  return <LucideIcon name={name} size={size} color={(isActive ? activeColor : baseColor) ?? '#374151'} />;
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A muted help glyph that reveals author-supplied hint text on tap — mobile's
 * equivalent of the web's hover tooltip (see web `HintIcon`). Theme-aware, and
 * renders nothing when the text is blank, so callers can pass an optional hint
 * unconditionally. Used by the `onno-hint` custom and next to widget titles.
 */
export function HintGlyph({
  text,
  c,
  size = 14,
  color: glyphColor,
}: {
  text?: string | null;
  c: ThemeColors;
  size?: number;
  color?: string;
}) {
  const [anchor, setAnchor] = useState<Rect | null>(null);
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const ref = useRef<View>(null);

  // Spring the bubble in once we know both the trigger position and its size
  // (we need the measured size to center/flip before showing it).
  useEffect(() => {
    if (!anchor || !dim) return;
    anim.setValue(0);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, stiffness: 300, damping: 24, mass: 0.8 }).start();
  }, [anchor, dim, anim]);

  const trimmed = text?.trim();
  if (!trimmed) return null;

  const open = () => {
    setDim(null);
    ref.current?.measureInWindow((x, y, w, h) => setAnchor({ x, y, w, h }));
  };
  const close = () => {
    Animated.timing(anim, { toValue: 0, duration: 110, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(
      ({ finished }) => finished && setAnchor(null),
    );
  };

  // Center the bubble on the glyph, clamped to the screen; flip above when it
  // would overflow the bottom.
  let pos: { left: number; top?: number; bottom?: number; up: boolean } | null = null;
  if (anchor && dim) {
    const screen = Dimensions.get('window');
    const left = Math.min(Math.max(8, anchor.x + anchor.w / 2 - dim.w / 2), Math.max(8, screen.width - dim.w - 8));
    const up = anchor.y + anchor.h + 8 + dim.h > screen.height - 24;
    pos = up
      ? { left, bottom: screen.height - anchor.y + 8, up }
      : { left, top: anchor.y + anchor.h + 8, up };
  }

  const shadow = isDark(c)
    ? '0px 12px 36px rgba(0,0,0,0.48), 0px 4px 12px rgba(0,0,0,0.30)'
    : '0px 12px 36px rgba(0,0,0,0.09), 0px 4px 12px rgba(0,0,0,0.05)';

  return (
    <>
      <Touchable ref={ref} collapsable={false} hitSlop={8} onPress={open} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <LucideIcon name="help-circle" size={size} color={glyphColor ?? c.muted} />
      </Touchable>
      <Modal visible={!!anchor} transparent animationType="none" onRequestClose={close}>
        {/* Transparent full-screen backdrop: tap anywhere to dismiss. */}
        <Pressable style={{ flex: 1 }} onPress={close}>
          <Animated.View
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              setDim((d) => (d && d.w === width && d.h === height ? d : { w: width, h: height }));
            }}
            style={{
              position: 'absolute',
              left: pos?.left ?? 0,
              top: pos?.top,
              bottom: pos?.bottom,
              maxWidth: 260,
              paddingVertical: 8,
              paddingHorizontal: 12,
              backgroundColor: c.card,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: 10,
              boxShadow: shadow,
              // Grow from the edge nearest the glyph (top-center down, bottom-center up).
              transformOrigin: pos?.up ? ['50%', '100%', 0] : ['50%', '0%', 0],
              opacity: pos ? anim.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }) : 0,
              transform: [{ scale: pos ? anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) : 0.9 }],
            }}
          >
            <Text style={{ color: c.text, fontSize: 13, lineHeight: 18 }}>{trimmed}</Text>
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

// onno-hint: a tappable help glyph that reveals the author-supplied `text`.
export const onnoHint: CustomRenderer = ({ customProps, host }) => (
  <HintGlyph
    text={customProps.text as string | undefined}
    c={colors(host.theme)}
    size={Number(customProps.size ?? 14)}
    color={color(customProps.color as string | undefined)}
  />
);
