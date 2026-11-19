import { useState } from 'react';

import { LAYER_DOORS, ThresholdLockup, ThresholdMark } from '@prisms/ui';

import { signIn, signUp, type SessionUser } from '../auth';
import { config } from '../config';

/** The host this client signs in to: a split deploy's API, else this origin. */
function serverHost(): string {
  try {
    if (config.apiBaseUrl) return new URL(config.apiBaseUrl).host;
  } catch {
    /* a relative or malformed base falls through to this origin */
  }
  return window.location.host;
}

/**
 * The brand panel's picture: all six layers of the plan as doors on one floor,
 * fading from the far frame (vision) to the filled door (now). Decorative.
 */
const CORRIDOR_STROKES = ['#33405c', '#45537a', '#5f6f94', '#8796b5', '#bfc8da'];

function Corridor() {
  return (
    <svg className="px-auth-corridor" viewBox="0 8 200 170" aria-hidden="true" focusable="false">
      <line x1="0" y1="170" x2="200" y2="170" stroke="#26314a" strokeWidth="1.2" />
      {LAYER_DOORS.map((pts, i) => {
        const last = i === LAYER_DOORS.length - 1;
        return (
          <polygon
            key={i}
            points={pts}
            fill={last ? '#4d82ff' : 'none'}
            stroke={last ? '#4d82ff' : CORRIDOR_STROKES[i]}
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        );
      })}
    </svg>
  );
}

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
    <div className="px-auth-split">
      <aside className="px-auth-brand">
        <ThresholdLockup size={30} tone="reversed" className="px-auth-logo" />
        <Corridor />
        <div className="px-auth-pitch">
          <p className="px-auth-pitch-h">Your plan lives on your server.</p>
          <p className="px-auth-pitch-b">
            Sign in once and this device keeps its own full copy. It works offline and catches up when you reconnect.
          </p>
        </div>
      </aside>

      <main className="px-auth-main">
        <div className="px-auth">
          <div className="px-auth-head">
            <h1>{mode === 'in' ? 'Sign in' : 'Create an account'}</h1>
            <p className="px-auth-server" data-testid="auth-server">
              <ThresholdMark size={14} compact /> {serverHost()}
            </p>
          </div>
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
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
                required
                data-testid="password"
              />
            </label>
            {error != null && <div className="px-error" data-testid="auth-error">{error}</div>}
            <button className="px-btn px-btn--primary px-auth-submit" type="submit" disabled={busy} data-testid="submit">
              {busy ? '…' : mode === 'in' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p className="px-auth-switch">
            {mode === 'in' ? 'New here?' : 'Have an account?'}{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}>
              {/* "Register" stays the link's first word: the e2e suite finds it by that name */}
              {mode === 'in' ? 'Register on this server' : 'Sign in'}
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
