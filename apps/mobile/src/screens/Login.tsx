import { useState } from 'react';
import { View } from 'react-native';

import { signIn, signUp, type SessionUser } from '../auth';
import { Btn, Field, H1, Muted, Screen } from '../ui';

export function Login({ onAuthed }: { onAuthed: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'in' ? await signIn(email, password) : await signUp(name, email, password);
      onAuthed(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'authentication failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen testID="login">
      <H1>Prisms</H1>
      <View style={{ gap: 10, marginTop: 12 }}>
        {mode === 'up' && <Field value={name} onChangeText={setName} placeholder="Name" testID="name" />}
        <Field value={email} onChangeText={setEmail} placeholder="Email" keyboardType="email-address" testID="email" />
        <Field value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry testID="password" />
        {error !== null && <Muted testID="auth-error">{error}</Muted>}
        <Btn title={busy ? '…' : mode === 'in' ? 'Sign in' : 'Create account'} variant="primary" onPress={() => void submit()} disabled={busy} testID="submit" />
        <Btn title={mode === 'in' ? 'No account? Register' : 'Have an account? Sign in'} onPress={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }} testID="toggle-mode" />
      </View>
    </Screen>
  );
}
