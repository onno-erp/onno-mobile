// Registry for `onno-*` div-custom blocks — the RN counterpart of the Flutter
// client's OnnoCustomHandler. Renderers are registered in ./customs.

import React from 'react';
import { Text, View } from 'react-native';
import type { CustomRenderer } from './types';

const registry: Record<string, CustomRenderer> = {};

export function registerCustom(type: string, renderer: CustomRenderer): void {
  registry[type] = renderer;
}

export function getCustom(type: string): CustomRenderer | undefined {
  return registry[type];
}

/** Shown for an unimplemented or unknown custom type — never crashes the card. */
export function CustomPlaceholder({ type }: { type: string }) {
  return (
    <View
      style={{
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#E5E7EB',
        backgroundColor: '#F9FAFB',
        alignSelf: 'flex-start',
      }}
    >
      <Text style={{ fontSize: 12, color: '#6B7280' }}>⟨{type}⟩</Text>
    </View>
  );
}
