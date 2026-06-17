// onec-actions-menu — the detail/list action bar. custom_props.items:
// [{ label, icon, url, tone: accent|normal|danger, placement: primary|menu }].
// Primary items render as inline buttons; menu items collapse under a "⋯" toggle.
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, type ThemeColors } from '../theme';
import type { CustomRenderer } from '../types';
import { LucideIcon } from './lucide';

interface Item {
  label: string;
  icon?: string;
  url: string;
  tone?: string;
  placement?: string;
}

function toneOf(tone: string | undefined, c: ThemeColors): { bg: string; fg: string; border: string } {
  switch (tone) {
    case 'accent': return { bg: c.accentBg, fg: c.accentFg, border: c.accentBg };
    case 'danger': return { bg: c.dangerBg, fg: c.dangerFg, border: c.dangerBg };
    default: return { bg: c.card, fg: c.text, border: c.border };
  }
}

export const onecActionsMenu: CustomRenderer = ({ block, host }) => {
  const c = colors(host.theme);
  const items: Item[] = Array.isArray(block.custom_props?.items) ? (block.custom_props!.items as Item[]) : [];
  const [open, setOpen] = useState(false);
  const primary = items.filter((i) => i.placement !== 'menu');
  const menu = items.filter((i) => i.placement === 'menu');

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {primary.map((it, i) => {
          const t = toneOf(it.tone, c);
          return (
            <Pressable
              key={i}
              onPress={() => host.fire(it.url)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: t.bg, borderColor: t.border, borderWidth: 1 }}
            >
              {it.icon ? <LucideIcon name={it.icon} size={16} color={t.fg} /> : null}
              <Text style={{ fontSize: 13, fontWeight: '600', color: t.fg }}>{it.label}</Text>
            </Pressable>
          );
        })}
        {menu.length > 0 && (
          <Pressable onPress={() => setOpen((o) => !o)} style={{ paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: c.card, borderWidth: 1, borderColor: c.border }}>
            <LucideIcon name="ellipsis" size={18} color={c.text} />
          </Pressable>
        )}
      </View>
      {open && menu.length > 0 && (
        <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.card, overflow: 'hidden' }}>
          {menu.map((it, i) => (
            <Pressable
              key={i}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 }}
              onPress={() => {
                setOpen(false);
                host.fire(it.url);
              }}
            >
              {it.icon ? <LucideIcon name={it.icon} size={16} color={it.tone === 'danger' ? c.dangerFg : c.text} /> : null}
              <Text style={{ fontSize: 14, color: it.tone === 'danger' ? c.dangerFg : c.text }}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
};
