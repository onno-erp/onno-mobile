// onno-constants — the app-settings editor embedded into a page (PageBuilder.constants).
// Renders the framework's `@Constant` values as toggles/inputs (served by SettingsController,
// admin-only) and saves them in place via PUT /api/settings. Port of the web SPA's
// constants-editor.tsx. custom_props: { title, names?: string[] }.

import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Switch, Text, TextInput, View } from 'react-native';
import type { Row, SettingMeta } from '../../api/onnoClient';
import { colors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { Touchable } from '../../ui/touchable';

const isBool = (t: string) => /^(boolean|Boolean)$/.test(t);
const isNum = (t: string) => /^(Integer|Long|Double|Float|Short|BigDecimal|int|long|double)$/.test(t);

// DivKit passes the name list as an array; tolerate a JSON string too.
function parseNames(raw: unknown): string[] | null {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function ConstantsEditor({ host, title, names }: { host: DivHost; title?: string; names: string[] | null }) {
  const c = colors(host.theme);
  const [settings, setSettings] = useState<SettingMeta[] | null>(null);
  const [values, setValues] = useState<Row>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // A page can drop just a subset of constants by naming them; keying on the joined names keeps
  // the effect stable across renders.
  const namesKey = names && names.length ? names.join(',') : '';
  useEffect(() => {
    let cancelled = false;
    const wanted = namesKey ? new Set(namesKey.split(',')) : null;
    host.client
      .getSettings()
      .then((all) => {
        if (cancelled) return;
        const list = wanted ? all.filter((s) => wanted.has(s.name)) : all;
        setSettings(list);
        const seed: Row = {};
        for (const s of list) seed[s.name] = isBool(s.type) ? s.value === true : s.value ?? '';
        setValues(seed);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [namesKey]);

  const set = (name: string, val: unknown) => {
    setValues((prev) => ({ ...prev, [name]: val }));
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await host.client.saveSettings(values);
      Alert.alert('Saved', 'Settings saved');
      setDirty(false);
    } catch (e: any) {
      Alert.alert("Couldn't save settings", String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      {title ? <Text style={{ fontSize: 13, fontWeight: '600', color: c.text, marginBottom: 8 }}>{title}</Text> : null}

      {error ? (
        <View style={{ borderWidth: 1, borderColor: c.border, backgroundColor: c.card, borderRadius: 12, padding: 16 }}>
          <Text style={{ fontSize: 13, color: c.dangerFg }}>Failed to load settings: {error}</Text>
        </View>
      ) : !settings ? (
        <View style={{ height: 80, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.text} />
        </View>
      ) : settings.length === 0 ? (
        <View style={{ borderWidth: 1, borderColor: c.border, backgroundColor: c.card, borderRadius: 12, padding: 16 }}>
          <Text style={{ fontSize: 13, color: c.muted }}>No settings defined yet.</Text>
        </View>
      ) : (
        <>
          <View style={{ borderWidth: 1, borderColor: c.border, backgroundColor: c.card, borderRadius: 16, overflow: 'hidden' }}>
            {settings.map((s, i) => (
              <View
                key={s.name}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 16,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: c.border,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: c.text }}>{s.displayName}</Text>
                  <Text style={{ fontSize: 11, color: c.muted, marginTop: 2 }}>{isBool(s.type) ? 'On / off toggle' : s.type}</Text>
                </View>
                {isBool(s.type) ? (
                  <Switch value={values[s.name] === true} onValueChange={(v) => set(s.name, v)} />
                ) : (
                  <TextInput
                    value={values[s.name] == null ? '' : String(values[s.name])}
                    keyboardType={isNum(s.type) ? 'numeric' : 'default'}
                    placeholderTextColor={c.muted}
                    onChangeText={(t) => set(s.name, isNum(s.type) ? (t === '' ? '' : Number(t)) : t)}
                    style={{
                      width: 160,
                      borderWidth: 1,
                      borderColor: c.fieldBorder,
                      borderRadius: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      fontSize: 14,
                      color: c.text,
                      backgroundColor: c.fieldBg,
                      minHeight: 40,
                    }}
                  />
                )}
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14 }}>
            <Touchable
              disabled={saving || !dirty}
              onPress={save}
              style={{
                backgroundColor: c.accentBg,
                borderRadius: 8,
                paddingHorizontal: 16,
                paddingVertical: 10,
                opacity: saving || !dirty ? 0.5 : 1,
              }}
            >
              <Text style={{ color: c.accentFg, fontSize: 14, fontWeight: '600' }}>{saving ? 'Saving…' : 'Save changes'}</Text>
            </Touchable>
          </View>
        </>
      )}
    </View>
  );
}

export const onnoConstants: CustomRenderer = ({ customProps, host }) => {
  const title = (customProps.title as string) || undefined;
  const names = parseNames(customProps.names);
  return <ConstantsEditor host={host} title={title} names={names} />;
};
