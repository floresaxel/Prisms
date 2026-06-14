import { useState } from 'react';

import { signIn, signUp, type SessionUser } from '../auth';

export function Login({ onAuthed }: { onAuthed: (user: SessionUser) => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
    <div className="px-auth">
      <div className="px-brand" style={{ marginBottom: 18 }}>Prisms</div>
      <form onSubmit={submit}>
        {mode === 'up' && (
          <label className="px-field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label className="px-field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required data-testid="email" />
        </label>
        <label className="px-field">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required data-testid="password" />
        </label>
        {error != null && <div className="px-error" data-testid="auth-error">{error}</div>}
        <button className="px-btn px-btn--primary" type="submit" disabled={busy} data-testid="submit" style={{ width: '100%' }}>
          {busy ? '…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>
      <p className="px-muted" style={{ marginTop: 16, textAlign: 'center' }}>
        {mode === 'in' ? 'No account?' : 'Have an account?'}{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}>
          {mode === 'in' ? 'Register' : 'Sign in'}
        </a>
      </p>
    </div>
  );
}
