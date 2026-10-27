/**
 * One character of a bible board (spec goal 5, 7, §9.1): the only place characters are edited.
 * Name, TOKEN, anchors (short visible facts), want/need/arc, the sheet with its status and a free
 * "Buat sheet", and an uploaded reference (sent with OpenRouter sheet jobs; Flow uses its sheet).
 * An anchor edit rebuilds the look — the card says what that re-renders, with real counts, before saving.
 */
import { useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, Pencil, Plus, RefreshCw, Trash2, UserRound, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSession } from '../../lib/session.js';
import { UPLOAD_WIDTHS, sizedImg } from '../../lib/media.js';
import { inputClass } from '../../ui/controls.js';
import { describeError } from '../../ui/states.js';
import { FLOW, fmtUsd, isOpenRouter, type Engine, type EngineSet, clipCost, isAxcel } from '../providers/providersClient.js';
import { CREDITS_PER_SHOT, UPLOAD_TYPES, storiesApi, uploadProblem, type SheetAnswer, type Story } from '../stories/storiesClient.js';
import type { Board } from './model.js';
import { shotsUsing } from './mentions.js';
import { media, useProject } from './useProject.js';

/** A bible character card as stored (unknown fields are kept on save). */
export type Card = { token: string; name: string; anchors: string[]; want: string; need: string; arc: string; reference?: string; sheet?: string; [key: string]: unknown };

const THUMB = 96;
const REF_THUMB = 40;

export function cardsOf(board: Board): Card[] {
  const raw = (board.bible as { characters?: unknown } | undefined)?.characters;
  return (Array.isArray(raw) ? raw : []).filter((c): c is Card => !!c && typeof c === 'object' && typeof (c as Card).token === 'string').map(c => ({
    ...c, name: typeof c.name === 'string' && c.name ? c.name : c.token,
    anchors: Array.isArray(c.anchors) ? c.anchors.filter((a): a is string => typeof a === 'string') : [],
    want: typeof c.want === 'string' ? c.want : '', need: typeof c.need === 'string' ? c.need : '', arc: typeof c.arc === 'string' ? c.arc : ''
  }));
}

/** The board with one card replaced (or removed with `null`); the rest of the bible is untouched. */
export function withCard(board: Board, token: string, next: Card | null): Board {
  const bible = (board.bible ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(bible.characters) ? (bible.characters as Card[]) : [];
  const exists = raw.some(c => c?.token === token);
  const characters = next === null ? raw.filter(c => c?.token !== token)
    : exists ? raw.map(c => (c?.token === token ? next : c)) : [...raw, next];
  const out: Board = { ...board, bible: { ...bible, characters } };
  if (next === null && board.characters?.[token] !== undefined) {
    const cast = { ...board.characters };
    delete cast[token];
    out.characters = cast;
  }
  return out;
}

/** What an anchor change re-renders: shots whose cast includes the token, and their done clips. */
export function anchorImpact(board: Board, story: Story, token: string): { shots: number; clips: number } {
  const ids = shotsUsing(board, token).shots.map(s => s.id);
  return { shots: ids.length, clips: ids.filter(id => story.shots.find(s => s.id === id)?.status === 'done').length };
}

/** A rename changes the compiled video prompt (the name is spoken): every done clip of that character is made again. */
export function renameText(impact: { clips: number }, engine: EngineSet): string | undefined {
  if (!impact.clips) return undefined;
  const cost = isAxcel(engine.video) ? clipCost(engine.video, impact.clips) : isOpenRouter(engine.video) ? 'dibayar per klip di OpenRouter' : `±${impact.clips * CREDITS_PER_SHOT} kredit`;
  return `Nama dipakai di prompt video — klip ${impact.clips} shot (${cost}) perlu dibuat ulang`;
}

export function impactText(impact: { shots: number; clips: number }, engine: EngineSet, konsisten: boolean): string {
  const image = isAxcel(engine.image) ? `Axcel ${engine.image.model} · termasuk paket` : isOpenRouter(engine.image) ? 'dibayar di OpenRouter' : 'gratis di Flow';
  const clips = isAxcel(engine.video) ? `klip ${impact.clips} shot (${clipCost(engine.video, impact.clips)})` : isOpenRouter(engine.video) ? `klip ${impact.clips} shot (dibayar per klip di OpenRouter)` : `klip ${impact.clips} shot (±${impact.clips * CREDITS_PER_SHOT} kredit)`;
  if (!konsisten) return `Mengubah tampilan membuat ulang ${clips}`;
  return `Mengubah tampilan membuat ulang sheet + keyframe ${impact.shots} shot (${image})${impact.clips ? ` dan ${clips}` : ''}`;
}

const SHEET_LABEL: Record<string, string> = { pending: 'Belum dibuat', queued: 'Membuat…', done: 'Siap', failed: 'Gagal' };

/** Anchor chips: × removes one, the field adds one (Enter). */
function AnchorEditor(props: { owner: string; anchors: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !props.anchors.includes(v)) props.onChange([...props.anchors, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11.5px] text-muted-foreground">Anchor visual — fakta yang bisa dilihat</span>
      <ul aria-label={`Anchor ${props.owner}`} className="flex flex-wrap items-center gap-1">
        {props.anchors.map(a => (
          <li key={a} className="flex h-6 items-center gap-0.5 rounded-md bg-muted pr-0.5 pl-2 text-[12px]">
            <span className="max-w-56 truncate">{a}</span>
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Hapus anchor ${a}`} onClick={() => props.onChange(props.anchors.filter(x => x !== a))}><X /></Button>
          </li>
        ))}
        <li className="flex h-6 items-center gap-0.5">
          <input aria-label={`Anchor baru ${props.owner}`} value={draft} maxLength={80} onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder={props.anchors.length ? 'mis. kalung kulit merah pudar' : 'mis. tinggi 160 cm, rambut kepang'} className={cn(inputClass, 'h-6 w-52 px-1.5 text-[12px]')} />
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Tambah anchor ${props.owner}`} disabled={!draft.trim()} onClick={add}><Plus /></Button>
        </li>
      </ul>
    </div>
  );
}

function Line(props: { label: string; text: string }) {
  return (
    <p className="text-[12px] leading-snug">
      <span className="text-muted-foreground">{props.label}: </span>
      {props.text.trim() ? props.text : <span className="text-muted-foreground/70 italic">belum diisi</span>}
    </p>
  );
}

export function CharacterCard(props: { card: Card; engine: EngineSet; locked: boolean; deleteBlocked?: string; onDelete: () => void }) {
  const p = useProject();
  const { fetchImpl } = useSession();
  const api = useMemo(() => storiesApi(fetchImpl), [fetchImpl]);
  const board = p.board!;
  const story = p.story!;
  const { card } = props;
  const konsisten = story.mode === 'konsisten';
  const image: Engine = props.engine.image ?? FLOW;
  const flow = !isOpenRouter(image);
  const sheet = story.cast?.find(c => c.token === card.token);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Card>(card);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [quote, setQuote] = useState<SheetAnswer>();
  const [problem, setProblem] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const anchorsChanged = draft.anchors.join('\n') !== card.anchors.join('\n');
  const renamed = !!draft.name.trim() && draft.name.trim() !== card.name.trim();
  const changed = anchorsChanged || (['name', 'want', 'need', 'arc'] as const).some(k => draft[k].trim() !== card[k].trim());
  const impact = anchorImpact(board, story, card.token);
  const start = () => { setDraft(card); setEditing(true); };
  const save = async () => {
    const next: Card = { ...card, name: draft.name.trim() || card.name, anchors: draft.anchors, want: draft.want.trim(), need: draft.need.trim(), arc: draft.arc.trim() };
    if (await p.save(withCard(board, card.token, next))) setEditing(false);
  };

  const makeSheet = async (confirm: boolean) => {
    setSheetBusy(true);
    setProblem(undefined);
    try {
      const r = await api.makeSheet(p.id, card.token, confirm, story.rev ?? 1);
      if (r.needsConfirm) setQuote(r);
      else { setQuote(undefined); if (r.story) p.apply({ story: r.story }); }
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setSheetBusy(false);
    }
  };

  const upload = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    const bad = uploadProblem(f);
    setProblem(bad);
    if (bad) return;
    setUploading(true);
    try {
      const r = await api.upload(p.id, f);
      const name = r.url.split('/').pop()!;
      // The upload took a while: store the reference on the board as it is NOW (the assistant may have saved meanwhile).
      await p.save(latest => {
        const now = cardsOf(latest).find(c => c.token === card.token);
        return now ? withCard(latest, card.token, { ...now, reference: `uploads/${name}` }) : latest;
      });
    } catch (e) {
      setProblem(`Referensi gagal diunggah: ${describeError(e)}`);
    } finally {
      setUploading(false);
    }
  };
  const dropReference = () => {
    const next = { ...card };
    delete next.reference;
    void p.save(withCard(board, card.token, next));
  };

  const sheetStatus = sheetBusy ? 'Membuat…' : SHEET_LABEL[sheet?.status ?? 'pending'] ?? 'Belum dibuat';
  const thumb = sheet?.status === 'done' ? sizedImg(media.cast(p.id, card.token, sheet.mediaId ?? ''), THUMB) : undefined;
  const canSheet = konsisten && !!sheet && sheet.status !== 'queued';
  const estimate = quote?.estimate?.usd !== undefined ? `±${fmtUsd(quote.estimate.usd)}` : quote?.estimate?.credits !== undefined ? `±${quote.estimate.credits} kredit` : 'harga belum diketahui';

  return (
    <li aria-label={card.name} className="flex gap-3 border-b border-border/60 py-2.5 last:border-b-0">
      {konsisten && (
        <div className="flex w-16 shrink-0 flex-col items-center gap-1 sm:w-24">
          <div className="flex size-16 items-center justify-center sm:size-24 overflow-hidden rounded-md bg-muted text-muted-foreground [&_svg]:size-5">
            {thumb
              ? <img {...thumb} width={THUMB} height={THUMB} alt={`Sheet ${card.name}`} loading="lazy" decoding="async" className="size-full object-cover" />
              : sheet?.status === 'queued' || sheetBusy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <UserRound aria-hidden="true" />}
          </div>
          <span className={cn('text-[11px]', sheet?.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{sheetStatus}</span>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {editing ? (
          <>
            <input aria-label={`Nama ${card.name}`} placeholder="Nama yang tampil di naskah, mis. Bu Sari" className={inputClass} value={draft.name} maxLength={80}
              onChange={e => setDraft({ ...draft, name: e.target.value })} />
            <AnchorEditor owner={card.name} anchors={draft.anchors} onChange={anchors => setDraft({ ...draft, anchors })} />
            <div className="grid gap-1.5 sm:grid-cols-3">
              {(['want', 'need', 'arc'] as const).map(k => {
                const label = k === 'want' ? 'Want' : k === 'need' ? 'Need' : 'Arc';
                return (
                  <label key={k} className="flex min-w-0 flex-col gap-0.5 text-[11.5px] text-muted-foreground">
                    {label}
                    <input aria-label={label} value={draft[k]} maxLength={200} onChange={e => setDraft({ ...draft, [k]: e.target.value })}
                      placeholder={k === 'want' ? 'yang ia kejar' : k === 'need' ? 'yang ia butuhkan' : 'dari … jadi …'} className={cn(inputClass, 'h-7 text-[12.5px]')} />
                  </label>
                );
              })}
            </div>
            {anchorsChanged && <p role="status" className="rounded-md bg-(--brand-muted) px-2.5 py-1.5 text-[12px]">{impactText(impact, props.engine, konsisten)}</p>}
            {renamed && !anchorsChanged && renameText(impact, props.engine) && <p role="status" className="rounded-md bg-(--brand-muted) px-2.5 py-1.5 text-[12px]">{renameText(impact, props.engine)}</p>}
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void save()} disabled={!changed || !draft.name.trim() || !!p.busy}>Simpan</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Batal</Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13px] font-medium">{card.name}</span>
              <Badge variant="secondary" className="h-4.5 px-1.5 font-mono text-[10.5px]">{card.token}</Badge>
            </div>
            {card.anchors.length ? (
              <ul aria-label={`Anchor ${card.name}`} className="flex flex-wrap gap-1">
                {card.anchors.map(a => <li key={a} className="flex min-h-5.5 items-center rounded-md bg-muted px-1.5 py-0.5 text-[11.5px] leading-snug">{a}</li>)}
              </ul>
            ) : <p className="text-[12px] text-muted-foreground italic">Belum ada anchor — tambahkan satu ciri yang bisa dilihat (mis. kalung kulit merah pudar).</p>}
            <div className="flex flex-col gap-0.5">
              <Line label="Want" text={card.want} /><Line label="Need" text={card.need} /><Line label="Arc" text={card.arc} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {canSheet && !quote && (
                <Button type="button" size="sm" variant="glass" disabled={props.locked || sheetBusy} onClick={() => void makeSheet(flow)}>
                  <RefreshCw /> {sheet?.status === 'done' ? 'Buat ulang sheet' : 'Buat sheet'}{flow ? ' · gratis' : ''}
                </Button>
              )}
              {quote && (
                <span className="flex items-center gap-1.5 rounded-md bg-(--brand-muted) px-2 py-1 text-[12px]">
                  Buat sheet {card.name} · {estimate}
                  <Button type="button" size="xs" disabled={sheetBusy} onClick={() => void makeSheet(true)}>Jalankan</Button>
                  <Button type="button" size="xs" variant="ghost" onClick={() => setQuote(undefined)}>Batal</Button>
                </span>
              )}
              {/* References go with sheet jobs; Cepat boards make no sheets, so there is nothing to attach them to. */}
              {konsisten && (
                <>
                  <Button type="button" size="sm" variant="ghost" disabled={props.locked || uploading} onClick={() => file.current?.click()}>
                    {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />} {card.reference ? 'Ganti referensi' : 'Unggah referensi'}
                  </Button>
                  <input ref={file} type="file" accept={UPLOAD_TYPES.join(',')} aria-label={`Pilih gambar referensi ${card.name}`} hidden
                    onChange={e => void upload(e.target.files?.[0])} />
                </>
              )}
            </div>
            {konsisten && !sheet && (
              <p className="text-[11.5px] text-muted-foreground">Sheet bisa dibuat setelah {card.name} dipakai di shot (sebut {card.token} di subjek atau aksi).</p>
            )}
            {card.reference && (
              <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <img {...sizedImg(api.uploadUrl(p.id, card.reference), REF_THUMB, UPLOAD_WIDTHS)} width={REF_THUMB} height={REF_THUMB} alt={`Referensi ${card.name}`} loading="lazy" decoding="async"
                  className="size-10 rounded-md object-cover ring-1 ring-border" />
                <span>Referensi</span>
                <Button type="button" size="xs" variant="ghost" disabled={props.locked} onClick={dropReference}><X /> Hapus referensi</Button>
              </div>
            )}
            {problem && <p role="alert" className="text-[12px] text-destructive">{problem}</p>}
          </>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-start gap-0.5">
          <Button size="icon-sm" variant="ghost" aria-label={`Ubah ${card.name}`} disabled={props.locked} onClick={start}><Pencil /></Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Hapus ${card.name}`} title={props.deleteBlocked} disabled={props.locked || !!props.deleteBlocked} onClick={props.onDelete}><Trash2 /></Button>
        </div>
      )}
    </li>
  );
}
