// onno-login-form — the username/password sub-form of the server-driven login screen
// (LoginDivBuilder emits it when password auth is enabled). DivKit can't read input
// values on a button tap, so this is a real RN form: it captures the credentials, calls
// the API client's login, and on success reloads the app at home. SSO buttons stay pure
// DivKit (a tap is just a redirect). Port of the web SPA's login-form-widget.tsx.
// custom_props: none.

import React, { useState } from 'react';
import { ActivityIndicator, Text, TextInput, View } from 'react-native';
import { colors } from '../theme';
import type { CustomRenderer, DivHost } from '../types';
import { Touchable } from '../../ui/touchable';

function LoginForm({ host }: { host: DivHost }) {
  const c = colors(host.theme);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const field = {
    borderWidth: 1,
    borderColor: c.fieldBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: c.text,
    backgroundColor: c.fieldBg,
    minHeight: 44,
  } as const;

  async function submit() {
    if (!username || !password || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await host.client.login(username, password);
      // Reload the app at home (mirrors the web's navigate-to-intended-page): `onno://app`
      // re-fetches the shell + the default content with a now-authenticated session.
      host.fire('onno://app');
    } catch {
      setError('The username or password is not correct.');
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || !username || !password;

  return (
    <View style={{ gap: 14, width: '100%' }}>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, color: c.text, fontWeight: '500' }}>Username</Text>
        <TextInput
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="username"
          placeholderTextColor={c.muted}
          style={field}
        />
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, color: c.text, fontWeight: '500' }}>Password</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          onSubmitEditing={submit}
          placeholderTextColor={c.muted}
          style={field}
        />
      </View>
      {error ? <Text style={{ fontSize: 13, color: c.dangerFg }}>{error}</Text> : null}
      <Touchable
        disabled={disabled}
        onPress={submit}
        style={{ backgroundColor: c.accentBg, borderRadius: 8, paddingVertical: 14, alignItems: 'center', opacity: disabled ? 0.6 : 1 }}
      >
        {submitting ? <ActivityIndicator color={c.accentFg} /> : <Text style={{ color: c.accentFg, fontWeight: '700', fontSize: 15 }}>Sign in</Text>}
      </Touchable>
    </View>
  );
}

export const onnoLoginForm: CustomRenderer = ({ host }) => <LoginForm host={host} />;
