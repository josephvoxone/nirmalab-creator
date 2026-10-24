import { useState, type FormEvent } from 'react';
import { authApi, type FetchLike, type User } from '../../lib/api.js';

export function LoginPage(props: { fetchImpl: FetchLike; onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await authApi(props.fetchImpl).login(email.trim(), password);
      props.onSignedIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal masuk');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark" aria-hidden>N</div>
        <h1>Masuk</h1>
        <p className="muted">Nirmalab Creator · khusus undangan</p>
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" placeholder="nama@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" placeholder="Password akunmu" value={password} onChange={e => setPassword(e.target.value)} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Masuk…' : 'Masuk'}</button>
      </form>
    </main>
  );
}
