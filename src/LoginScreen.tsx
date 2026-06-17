// Sign-in screen, shown when a connected server reports no authenticated
// session (GET /api/auth/me → authenticated:false). Posts username/password to
// /api/auth/login via the client. The web renders a server-driven login card
// (/api/divkit/login) with a password form and/or SSO buttons; this native form
// covers the password (in-memory / form) case — the common one. Servers that are
// SSO-only aren't handled here yet.

import { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { colors } from './divkit/theme';
import { Touchable } from './ui/touchable';

interface Props {
  theme: 'light' | 'dark';
  /** The server being signed into, shown for context (host[:port], no scheme). */
  serverLabel: string;
  bottomInset?: number;
  /** Resolves on success (parent swaps this screen out); rejects on bad creds. */
  onSubmit: (username: string, password: string) => Promise<void>;
  onChangeServer: () => void;
}

export function LoginScreen({ theme, serverLabel, bottomInset = 0, onSubmit, onChangeServer }: Props) {
  const c = colors(theme);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = username.trim() !== '' && password !== '' && !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(username.trim(), password);
      // success: the parent transitions away from this screen — leave `submitting`
      // true so the button stays disabled during the brief unmount.
    } catch (e: any) {
      setError(String(e?.message ?? e) || 'Sign-in failed');
      setSubmitting(false);
    }
  }

  return (
    <ScrollView
      style={[styles.flex, { backgroundColor: c.bg }]}
      contentContainerStyle={[styles.content, { paddingBottom: 24 + bottomInset }]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      // iOS: inset the scroll area AND scroll the focused field above the keyboard
      // (KeyboardAvoidingView's "padding" shrank the area but left low fields hidden).
      automaticallyAdjustKeyboardInsets
      showsVerticalScrollIndicator={false}
    >
      <Text style={[styles.title, { color: c.text }]}>Sign in</Text>
        <Text style={[styles.subtitle, { color: c.muted }]}>
          Use your workspace credentials for <Text style={{ color: c.text }}>{serverLabel}</Text>.
        </Text>

        <Text style={[styles.label, { color: c.muted }]}>USERNAME</Text>
        <TextInput
          value={username}
          onChangeText={(t) => {
            setUsername(t);
            if (error) setError(null);
          }}
          placeholder="username"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
          returnKeyType="next"
          editable={!submitting}
          style={[styles.input, { color: c.text, backgroundColor: c.fieldBg, borderColor: error ? c.dangerFg : c.fieldBorder }]}
        />

        <Text style={[styles.label, { color: c.muted }]}>PASSWORD</Text>
        <TextInput
          value={password}
          onChangeText={(t) => {
            setPassword(t);
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          placeholder="password"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
          returnKeyType="go"
          editable={!submitting}
          style={[styles.input, { color: c.text, backgroundColor: c.fieldBg, borderColor: error ? c.dangerFg : c.fieldBorder }]}
        />

        {error && <Text style={[styles.fieldError, { color: c.dangerFg }]}>{error}</Text>}

        <Touchable
          onPress={submit}
          disabled={!canSubmit}
          style={[styles.submit, { backgroundColor: c.accentBg, opacity: canSubmit ? 1 : 0.5 }]}
        >
          {submitting ? (
            <ActivityIndicator color={c.accentFg} />
          ) : (
            <Text style={[styles.submitText, { color: c.accentFg }]}>Sign in</Text>
          )}
        </Touchable>

      <Touchable onPress={onChangeServer} disabled={submitting} hitSlop={8} style={styles.changeServer}>
        <Text style={[styles.changeServerText, { color: c.muted }]}>Change server</Text>
      </Touchable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Cap the column and centre it so the form doesn't stretch into a long line on an
  // iPad. The cap is wider than any phone, so phones render exactly as before.
  content: { padding: 24, paddingTop: 72, gap: 8, width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { fontSize: 24, fontWeight: '700' },
  subtitle: { fontSize: 14, marginBottom: 12 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginTop: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 15 },
  fieldError: { fontSize: 13, marginTop: 4 },
  submit: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', marginTop: 16, minHeight: 48 },
  submitText: { fontWeight: '600', fontSize: 15 },
  changeServer: { alignItems: 'center', marginTop: 16, paddingVertical: 4 },
  changeServerText: { fontSize: 14, fontWeight: '500' },
});
