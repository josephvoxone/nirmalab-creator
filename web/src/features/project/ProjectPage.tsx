import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Check, Clapperboard, Film, Images, Pencil, RefreshCw, Send, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { describeError } from '../../ui/states.js';
import { ApiError } from '../../lib/api.js';
import { STATUS_LABEL, isActive } from '../stories/storiesClient.js';
import { stageOf } from './model.js';
import { nextStep, type NextStep } from './nextStep.js';
import { ProjectProvider, useProjectState, type Project } from './useProject.js';
import { SceneTab } from './SceneTab.js';
import { BibleTab } from './BibleTab.js';
import { BreakdownTab } from './BreakdownTab.js';
import { TimelineTab } from './TimelineTab.js';
import { ResultTab } from './ResultTab.js';
import { useSession } from '../../lib/session.js';
import { AssistantColumn, AssistantSheet, AssistantToggle, useAssistantDock } from '../assistant/AssistantDock.js';

const TABS = [
  { id: 'scene', label: 'Scene' },
  { id: 'bible', label: 'Bible' },
  { id: 'breakdown', label: 'Breakdown' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'hasil', label: 'Hasil' },
  { id: 'aktivitas', label: 'Aktivitas' }
] as const;
type TabId = (typeof TABS)[number]['id'];

function StageBar(props: { p: Project }) {
  const { story, board } = props.p;
  if (!story || !board) return null;
  const { stages, current } = stageOf(story, board);
  return (
    <ol aria-label="Tahap produksi" className="flex flex-wrap items-center gap-1">
      {stages.map((s, i) => (
        <li key={s.id} aria-label={s.label} aria-current={s.id === current ? 'step' : undefined} title={s.detail}
          className={cn('flex items-center gap-1.5 text-[12px] text-muted-foreground', s.id === current && 'text-foreground')}>
          {i > 0 && <span aria-hidden="true" className="h-px w-4 bg-border" />}
          <span className={cn('flex size-4.5 items-center justify-center rounded-full border text-[10px] tabular-nums',
            s.done && 'border-(--success)/60 text-(--success)', s.id === current && 'border-foreground bg-foreground text-background')}>
            {s.done ? <Check className="size-3" /> : i + 1}
          </span>
          <span>{s.label}</span>
          <span className="hidden text-[11px] text-muted-foreground lg:inline">· {s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

/** The one next step for the whole project, next to the title (tabs only name it). */
function PrimaryAction(props: { p: Project }) {
  const { story, board, busy } = props.p;
  if (!story || !board) return null;
  const step = nextStep(story, board);
  const run: Partial<Record<NextStep['kind'], [typeof Images, () => void]>> = {
    retry: [RefreshCw, () => void props.p.retry()],
    prepare: [Images, () => void props.p.prepare()],
    render: [Clapperboard, () => void props.p.render()],
    assemble: [Film, () => void props.p.assemble()]
  };
  if (step.kind === 'working') return <Button size="sm" variant="glass" disabled><RefreshCw className="animate-spin" /> {step.label}…</Button>;
  if (step.kind === 'publish') return <Link to="/publish" className={buttonVariants({ size: 'sm', variant: 'glass' })}><Send /> Publish</Link>;
  const action = run[step.kind];
  if (!action) return null;
  const [Icon, onClick] = action;
  return <Button size="sm" onClick={onClick} disabled={!!busy}><Icon /> {step.label}</Button>;
}

function Title(props: { p: Project }) {
  const { board } = props.p;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(board?.title ?? '');
  useEffect(() => { if (!editing) setText(board?.title ?? ''); }, [board?.title, editing]);
  if (!board) return null;
  const commit = async () => {
    setEditing(false);
    if (text.trim() && text.trim() !== board.title) await props.p.save({ ...board, title: text.trim() });
  };
  return editing ? (
    <input autoFocus aria-label="Judul proyek" placeholder="Judul proyek" value={text} onChange={e => setText(e.target.value)} onBlur={() => void commit()}
      onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
      className="h-8 min-w-0 flex-1 rounded-md border border-input bg-(--field) px-2 text-[17px] font-medium outline-none focus-visible:border-ring" />
  ) : (
    <div className="flex min-w-0 items-center gap-1">
      <h2 className="truncate text-[17px] font-medium">{board.title}</h2>
      <Button size="icon-xs" variant="ghost" aria-label="Ubah judul" onClick={() => setEditing(true)}><Pencil /></Button>
    </div>
  );
}

function Banners(props: { p: Project }) {
  const { error, budget, stale, story, notice } = props.p;
  return (
    <>
      {notice && (
        <p role="status" className="flex items-center gap-1.5 rounded-md bg-muted px-3 py-2 text-[12.5px]">
          <RefreshCw aria-hidden="true" className="size-3.5 text-muted-foreground" /> {notice}
        </p>
      )}
      {budget && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md bg-(--brand-muted) px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1">Kredit Flow tidak cukup: {budget.message}</span>
          <Button size="sm" variant="glass" onClick={() => void props.p.render(budget.scope, true)}>Render tetap</Button>
          <Button size="sm" variant="ghost" onClick={props.p.dismiss}>Batal</Button>
        </div>
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <Button size="sm" variant="ghost" onClick={props.p.dismiss}>Tutup</Button>
        </div>
      )}
      {story?.status === 'failed' && story.error && !error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">Gagal: {story.error}</p>
      )}
      {/* Audit gate (spec §4.4): the server refused to assemble and named the shots. */}
      {story?.gate && !error && (
        <p role="alert" className="rounded-md bg-(--brand-muted) px-3 py-2 text-[12.5px]">
          <span className="font-medium">Belum bisa dirakit.</span> {story.gate.message}
        </p>
      )}
      {stale && story && <p role="status" className="text-[12px] text-muted-foreground">Pembaruan status gagal dimuat — data di bawah mungkin belum terbaru. <button className="underline" onClick={props.p.reload}>Muat ulang</button></p>}
      {story?.videoStale && <p role="status" className="rounded-md bg-muted px-3 py-2 text-[12.5px]">Urutan atau isi berubah sejak video dirakit — rakit ulang (tombol kanan atas) agar video akhir mengikuti timeline.</p>}
    </>
  );
}

function Activity(props: { p: Project }) {
  const events = [...(props.p.story?.events ?? [])].reverse();
  if (!events.length) return <p className="text-[13px] text-muted-foreground">Belum ada aktivitas.</p>;
  return (
    <ol aria-label="Aktivitas" className="flex flex-col">
      {events.map((e, i) => (
        <li key={`${e.atMs}-${i}`} className="flex gap-3 border-b border-border/60 py-1.5 text-[12.5px] last:border-b-0">
          <time className="w-36 shrink-0 text-muted-foreground tabular-nums">{new Date(e.atMs).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
          <span>{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

export function ProjectPage(props: { pollMs?: number }) {
  const { id = '' } = useParams();
  const p = useProjectState(id, props.pollMs ?? 4000);
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(t => t.id === params.get('tab'))?.id ?? 'scene') as TabId;
  const choose = (t: TabId) => setParams(prev => { const n = new URLSearchParams(prev); n.set('tab', t); return n; }, { replace: true });
  const dock = useAssistantDock();
  // The assistant (chat, MCP, uploads) is admin-only on the server: members get no panel at all.
  const assistant = useSession().user.isAdmin;

  if (p.loadError && !p.story) {
    const missing = p.loadError instanceof ApiError && p.loadError.status === 404;
    return (
      <div className="glass-panel mx-auto mt-10 flex max-w-md flex-col items-center gap-2 rounded-lg px-6 py-8 text-center" role={missing ? undefined : 'alert'}>
        <h2 className="text-sm font-medium">{missing ? 'Proyek tidak ditemukan' : 'Proyek gagal dimuat'}</h2>
        <p className="text-[13px] text-muted-foreground">{missing ? 'Mungkin sudah dihapus.' : describeError(p.loadError)}</p>
        <div className="flex gap-2">
          {!missing && <Button size="sm" variant="glass" onClick={p.reload}><RefreshCw /> Coba lagi</Button>}
          <Link to="/cerita" className={buttonVariants({ size: 'sm', variant: 'ghost' })}>Kembali ke proyek</Link>
        </div>
      </div>
    );
  }
  if (!p.story || !p.board) {
    return (
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-3" aria-busy="true" aria-label="Memuat proyek">
        <Skeleton className="h-6 w-64" /><Skeleton className="h-4 w-96" /><Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-[220px_1fr] gap-3"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
      </div>
    );
  }

  const counts: Partial<Record<TabId, number>> = { scene: p.board.scenes?.length ?? 1 };
  const columnShown = assistant && dock.wide && dock.open;
  return (
    <ProjectProvider value={p}>
      {/* With the assistant column beside them the tabs keep about the same ~1100 px (the shell's
          .content widens to match through `data-assistant-column`, see app.css). */}
      <div data-assistant-column={columnShown || undefined} className={cn('mx-auto flex w-full items-start gap-4', columnShown ? 'max-w-[1520px]' : 'max-w-[1200px]')}>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex min-w-[min(100%,14rem)] flex-1 flex-col gap-0.5">
              <Title p={p} />
              {p.board.logline && <p className="text-[12.5px] text-muted-foreground">{p.board.logline}</p>}
            </div>
            <PrimaryAction p={p} />
            {assistant && <AssistantToggle dock={dock} />}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-b pb-2">
            <StageBar p={p} />
            <span className="ml-auto flex items-center gap-1 text-[11.5px] text-muted-foreground"><Sparkles className="size-3" /> {p.story.mode === 'konsisten' ? 'Mode konsisten' : 'Mode cepat'} · {p.board.aspect ?? '9:16'}</span>
          </div>
          <Banners p={p} />
          <div role="tablist" aria-label="Bagian proyek" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
            {TABS.map(t => (
              <button key={t.id} type="button" role="tab" id={`ptab-${t.id}`} aria-controls={`ppanel-${t.id}`} aria-selected={tab === t.id} onClick={() => choose(t.id)}
                className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60',
                  tab === t.id && 'glass-chosen text-foreground')}>
                {t.label}{counts[t.id] !== undefined && <span className="text-[11px] text-muted-foreground">{counts[t.id]}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`ppanel-${tab}`} aria-labelledby={`ptab-${tab}`} className="min-w-0">
            {tab === 'scene' && <SceneTab />}
            {tab === 'bible' && <BibleTab />}
            {tab === 'breakdown' && <BreakdownTab />}
            {tab === 'timeline' && <TimelineTab />}
            {tab === 'hasil' && <ResultTab />}
            {tab === 'aktivitas' && <Activity p={p} />}
          </div>
        </div>
        {assistant && <AssistantColumn dock={dock} story={p.story} board={p.board} onChanged={p.reload} />}
      </div>
      {assistant && <AssistantSheet dock={dock} story={p.story} board={p.board} onChanged={p.reload} />}
    </ProjectProvider>
  );
}
