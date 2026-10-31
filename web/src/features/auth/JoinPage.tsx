/**
 * /join/:token — the public side of a workspace invite (contract PIN). It says which workspace
 * and role the link is for before asking for anything; an account is only created when the
 * invitee does not have one yet (the invite is the credential, not open sign-up).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { describeError } from '../../ui/states.js';
import { Field, inputClass } from '../../ui/controls.js';
import { RoleBadge } from '../../ui/RoleBadge.js';
import { ROLE_HINT, joinApi, type Role } from '../../lib/workspaces.js';
import type { FetchLike, User } from '../../lib/api.js';

type Peek = { workspace: { name: string }; role: Role; email: string; needsAccount: boolean };

export function JoinPage(props: { token: string; fetchImpl: FetchLike; onSignedIn: (user: User) => void }) {
  const [invite, setInvite] = useState<Peek>();
  const [invalid, setInvalid] = useState<unknown>();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    let alive = true;
    joinApi(props.fetchImpl).peek(props.token).then(
      r => { if (alive) setInvite(r); },
      e => { if (alive) setInvalid(e); }
    );
    return () => { alive = false; };
  }, [props.fetchImpl, props.token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!invite) return;
    setBusy(true);
    setError('');
    try {
      const { user } = await joinApi(props.fetchImpl).accept(props.token, invite.needsAccount ? password : undefined);
      setDone(`Kamu bergabung ke ${invite.workspace.name} sebagai ${invite.role === 'owner' ? 'Pemilik' : invite.role === 'editor' ? 'Editor' : 'Penonton'}.`);
      props.onSignedIn(user);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    const status = (invalid as { status?: number }).status;
    const expired = status === 404 || status === 410 || status === 401 || /kedaluwarsa|dipakai|expired|tidak berlaku/i.test(String((invalid as { message?: string }).message ?? ''));
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10 text-foreground">
        <div role="alert" className="glass-panel flex w-full max-w-sm flex-col items-start gap-2 rounded-lg px-5 py-6">
          <TriangleAlert aria-hidden="true" className="size-5 text-destructive" />
          <h1 className="text-[17px] font-medium text-balance">Undangan tidak berlaku</h1>
          <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
            {expired
              ? 'Tautan ini sudah kedaluwarsa atau sudah dipakai. Minta Pemilik workspace mengirim undangan baru.'
              : `Undangan gagal dimuat. ${describeError(invalid)}`}
          </p>
          <Link to="/" className="text-[13px] underline underline-offset-2 hover:text-foreground">Kembali ke beranda</Link>
        </div>
      </main>
    );
  }

  if (!invite) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10">
        <div className="glass-panel flex w-full max-w-sm flex-col gap-3 rounded-lg px-5 py-6" role="status" aria-busy="true" aria-label="Memeriksa undangan">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10 text-foreground">
      <form onSubmit={submit} className="glass-panel flex w-full max-w-sm flex-col gap-3 rounded-lg px-5 py-6" aria-label="Gabung ke workspace">
        <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-[8px] bg-(--brand) text-[12px] font-bold text-(--brand-foreground)">N</span>
        <div className="flex flex-col gap-1">
          <h1 className="text-[17px] font-medium text-balance">Gabung ke {invite.workspace.name}</h1>
          <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            Kamu akan bergabung sebagai <RoleBadge role={invite.role} className="h-4.5 px-1.5 text-[10.5px] font-normal" />
          </span>
          <p className="text-[12px] leading-relaxed text-pretty text-muted-foreground">{ROLE_HINT[invite.role]}.</p>
        </div>
        <Field label="Email" hint={invite.needsAccount ? 'Email ini menjadi akunmu. Tidak bisa diganti.' : 'Undangan ini untuk akun yang sudah masuk dengan email ini.'}>
          <input className={inputClass} type="email" value={invite.email} readOnly aria-label="Email undangan" placeholder="nama@email.com" />
        </Field>
        {invite.needsAccount && (
          <Field label="Kata sandi" hint="Minimal 8 karakter.">
            <input className={inputClass} type="password" autoComplete="new-password" minLength={8} required value={password}
              onChange={e => setPassword(e.target.value)} placeholder="Minimal 8 karakter" aria-label="Kata sandi" />
          </Field>
        )}
        {error && <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">{error}</p>}
        {done && <p role="status" className="text-[12.5px] text-(--success)"><Check aria-hidden="true" className="mr-1 inline size-3.5" />{done}</p>}
        <Button type="submit" size="lg" disabled={busy} className="w-full">
          {busy ? 'Memproses…' : invite.needsAccount ? 'Buat akun & gabung' : 'Gabung ke workspace'}
          <ArrowRight />
        </Button>
        <p className="text-[11.5px] text-muted-foreground">Tautan berlaku sekali pakai. Setelah bergabung kamu bisa membuka workspace ini dari pengalih di sidebar.</p>
      </form>
    </main>
  );
}
