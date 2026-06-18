// onno-actions — a page-level section of action buttons (PageBuilder.actions). Each
// button either runs an обработка-style server handler (POST /api/divkit/page-action)
// or routes the client. Port of the web SPA's page-actions-bar.tsx. custom_props:
// { heading, route, profile, buttons: [{ key, label, icon?, logo?, server, url? }] }.

import React, { useState } from 'react';
import { ActivityIndicator, Alert, Image, Text, View } from 'react-native';
import { colors } from '../theme';
import type { CustomRenderer } from '../types';
import { Touchable } from '../../ui/touchable';
import { LucideIcon } from './lucide';

interface ActionButton {
  key: string;
  label: string;
  icon?: string;
  /** Image URL/path shown instead of the lucide icon — e.g. a brand logo for "Connect with X". */
  logo?: string;
  server: boolean;
  url?: string;
}

function absolutize(url: string | undefined, baseUrl?: string): string | undefined {
  if (!url || !baseUrl) return url;
  if (/^https?:\/\//.test(url) || url.startsWith('data:')) return url;
  return baseUrl.replace(/\/$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

export const onnoActions: CustomRenderer = ({ customProps, host }) => {
  const c = colors(host.theme);
  const heading = (customProps.heading as string) || '';
  const route = (customProps.route as string) || '';
  const profile = (customProps.profile as string) || undefined;
  const buttons: ActionButton[] = Array.isArray(customProps.buttons) ? (customProps.buttons as ActionButton[]) : [];
  const [pending, setPending] = useState<Record<string, boolean>>({});

  if (buttons.length === 0) return null;

  const run = async (b: ActionButton) => {
    if (!b.server) {
      if (b.url) host.fire(b.url);
      return;
    }
    setPending((s) => ({ ...s, [b.key]: true }));
    try {
      const result = await host.client.runPageAction(route, b.key, profile);
      if (result.message) Alert.alert('Done', result.message);
      // A navigate result loads a new surface; otherwise a refresh result reloads this one
      // (the web relies on SSE here — mobile has no live stream, so re-fetch explicitly).
      if (result.navigate) host.fire(result.navigate);
      else if (result.refresh) host.refresh();
    } catch (e: any) {
      Alert.alert('Action failed', String(e?.message ?? e));
    } finally {
      setPending((s) => ({ ...s, [b.key]: false }));
    }
  };

  return (
    <View>
      {heading ? <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 8 }}>{heading}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderWidth: 1, borderColor: c.border, borderRadius: 16, backgroundColor: c.card, padding: 14 }}>
        {buttons.map((b) => {
          const busy = !!pending[b.key];
          const logo = absolutize(b.logo, host.baseUrl);
          return (
            <Touchable
              key={b.key}
              disabled={busy}
              onPress={() => run(b)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                height: 38,
                paddingHorizontal: 14,
                borderRadius: 8,
                backgroundColor: c.surface,
                borderWidth: 1,
                borderColor: c.border,
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.text} />
              ) : logo ? (
                <Image source={{ uri: logo }} style={{ width: 16, height: 16 }} resizeMode="contain" />
              ) : b.icon ? (
                <LucideIcon name={b.icon} size={16} color={c.text} />
              ) : null}
              <Text style={{ fontSize: 13, fontWeight: '600', color: c.text }}>{b.label}</Text>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
};
