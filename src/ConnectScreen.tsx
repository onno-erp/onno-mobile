// The "choose a server" screen. Shown on startup when there's no last-used
// server, when the user logs out, and from the connection-error screen. Lets
// the user pick a previously-used OneC server or type a new one.

import { useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { normalizeUrl, type ServerEntry } from './api/servers';
import { colors } from './divkit/theme';
import { Touchable } from './ui/touchable';

interface Props {
  theme: 'light' | 'dark';
  servers: ServerEntry[];
  /** Bottom safe-area inset, so the scroll content clears the home indicator. */
  bottomInset?: number;
  onConnect: (url: string) => void;
  onRemove: (url: string) => void;
}

export function ConnectScreen({ theme, servers, bottomInset = 0, onConnect, onRemove }: Props) {
  const c = colors(theme);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);

  function submit() {
    const norm = normalizeUrl(draft);
    if (!norm) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft('');
    onConnect(norm);
  }

  return (
    <ScrollView
      style={[styles.flex, { backgroundColor: c.bg }]}
      contentContainerStyle={[styles.content, { paddingBottom: 24 + bottomInset }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      // Lift the URL field above the keyboard (iOS) instead of letting it hide behind it.
      automaticallyAdjustKeyboardInsets
    >
      <Text style={[styles.title, { color: c.text }]}>Connect to a server</Text>
        <Text style={[styles.subtitle, { color: c.muted }]}>
          Pick a OneC server or add a new one.
        </Text>

        {/* Add a new server */}
        <View style={styles.inputRow}>
          <TextInput
            value={draft}
            onChangeText={(t) => {
              setDraft(t);
              if (invalid) setInvalid(false);
            }}
            onSubmitEditing={submit}
            placeholder="http://localhost:8899"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            style={[
              styles.input,
              {
                color: c.text,
                backgroundColor: c.fieldBg,
                borderColor: invalid ? c.dangerFg : c.fieldBorder,
              },
            ]}
          />
          <Touchable
            onPress={submit}
            disabled={draft.trim() === ''}
            style={[
              styles.addBtn,
              { backgroundColor: c.accentBg, opacity: draft.trim() === '' ? 0.5 : 1 },
            ]}
          >
            <Text style={[styles.addBtnText, { color: c.accentFg }]}>Connect</Text>
          </Touchable>
        </View>
        {invalid && (
          <Text style={[styles.fieldError, { color: c.dangerFg }]}>
            Enter a valid URL, e.g. http://localhost:8899
          </Text>
        )}

        {/* Saved servers */}
        {servers.length > 0 && (
          <Text style={[styles.sectionLabel, { color: c.muted }]}>SAVED SERVERS</Text>
        )}
        <View style={[styles.list, { borderColor: c.border, backgroundColor: c.card }]}>
          {servers.length === 0 ? (
            <Text style={[styles.empty, { color: c.muted }]}>
              No saved servers yet — add one above.
            </Text>
          ) : (
            servers.map((s, i) => (
              <Touchable
                key={s.url}
                onPress={() => onConnect(s.url)}
                style={[
                  styles.row,
                  i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
                ]}
              >
                <View style={styles.flex}>
                  <Text style={[styles.rowLabel, { color: c.text }]} numberOfLines={1}>
                    {s.label}
                  </Text>
                </View>
                <Touchable onPress={() => onRemove(s.url)} hitSlop={10} style={styles.remove}>
                  <Text style={[styles.removeText, { color: c.muted }]}>✕</Text>
                </Touchable>
              </Touchable>
            ))
          )}
        </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Cap the column and centre it so it doesn't stretch into a long line on an iPad.
  // The cap is wider than any phone, so phones render exactly as before.
  content: { padding: 24, paddingTop: 72, gap: 12, width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, marginBottom: 8 },
  inputRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
  },
  addBtn: {
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: { fontWeight: '600', fontSize: 14 },
  fieldError: { fontSize: 13 },
  sectionLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginTop: 12 },
  list: { borderWidth: 1, borderRadius: 12, overflow: 'hidden' },
  empty: { padding: 16, fontSize: 14, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 12 },
  rowLabel: { fontSize: 15, fontWeight: '500' },
  remove: { paddingHorizontal: 4 },
  removeText: { fontSize: 16, fontWeight: '600' },
});
