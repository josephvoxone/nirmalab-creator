import { useEffect, useState, type FormEvent } from 'react';
import { authApi, type FetchLike, type User } from '../../lib/api.js';

export function JoinPage(props: { token: string; fetchImpl: FetchLike; onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [valid, setValid] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    authApi(props.fetchImpl).peekInvite(props.token).then(
      r => { if (!alive) return; setValid(r.valid); if (r.email) setEmail(r.email); },
      () => alive && setValid(false)
    );
    return () => { alive = false; };
  }, [props.fetchImpl, props.token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await authApi(props.fetchImpl).acceptInvite(props.token, email.trim(), password);
      props.onSignedIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gagal membuat akun');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark" aria-hidden>N</div>
        <h1>Gabung</h1>
        {valid === false ? (
          <p className="form-error" role="alert">Undangan tidak berlaku atau sudah dipakai. Minta undangan baru ke admin.</p>
        ) : (
          <>
            <p className="muted">Buat akun Nirmalab Creator dari undangan ini.</p>
            <label className="field">
              <span>Email</span>
              <input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              <span>Password</span>
              <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary" type="submit" disabled={busy || valid === undefined}>{busy ? 'Membuat…' : 'Buat akun'}</button>
          </>
        )}
      </form>
    </main>
  );
}
