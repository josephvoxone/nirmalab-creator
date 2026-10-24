/**
 * The story pipeline as a node graph (ComfyUI-style): what feeds what, and where each
 * piece is right now. Pure — FlowCanvas only lays it out.
 */
import type { Story, Storyboard, TakeState } from './storiesClient.js';

export type NodeKind = 'storyboard' | 'look' | 'cast' | 'frame' | 'clip' | 'final';
export type NodeStatus = 'idle' | 'pending' | 'running' | 'done' | 'failed';
export type FlowNode = {
  id: string; kind: NodeKind; col: number; label: string; status: NodeStatus;
  note?: string; shotId?: string; token?: string; detail?: string;
};
export type FlowEdge = { from: string; to: string };

export const KIND_LABEL: Record<NodeKind, string> = {
  storyboard: 'Storyboard', look: 'Gaya', cast: 'Karakter', frame: 'Keyframe', clip: 'Klip', final: 'Video akhir'
};
export const STATUS_TEXT: Record<NodeStatus, string> = {
  idle: 'Belum mulai', pending: 'Menunggu', running: 'Berjalan', done: 'Selesai', failed: 'Gagal'
};

function takeStatus(t: Pick<TakeState, 'status'> | undefined): NodeStatus {
  if (!t) return 'idle';
  return t.status === 'queued' ? 'running' : t.status;
}

function takeNote(t: (Pick<TakeState, 'status' | 'attempts'> & { lastError?: string; error?: string }) | undefined): string | undefined {
  if (!t) return undefined;
  if (t.status === 'failed') return t.error ?? 'Gagal setelah 3 take';
  if (t.status === 'queued' && t.lastError) return `take ${t.attempts + 1} · ${t.lastError}`;
  return undefined;
}

function lookLabel(board: Storyboard): string {
  const style = typeof board.style === 'string' ? board.style.replace(/^Style:\s*/, '') : '';
  return style.split(/[,.]/)[0]?.trim().slice(0, 40) || 'Gaya visual';
}

const tokenIn = (token: string, text: string) => new RegExp(`\\b${token}\\b`).test(text);

export function buildGraph(story: Story, board: Storyboard): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const konsisten = story.mode === 'konsisten';
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const shots = board.shots;

  nodes.push({
    id: 'storyboard', kind: 'storyboard', col: 0, label: story.title, status: 'done',
    detail: `${shots.length} shot · ${konsisten ? 'konsisten' : 'cepat'}`
  });

  // The one Style line every keyframe/clip shares: an honest input to all of them.
  nodes.push({ id: 'look', kind: 'look', col: 1, label: lookLabel(board), status: 'done', detail: 'dipakai semua shot' });
  edges.push({ from: 'storyboard', to: 'look' });

  const castTokens: string[] = [];
  if (konsisten) {
    for (const [token, spec] of Object.entries((board.characters ?? {}) as Record<string, unknown>)) {
      if (!shots.some(s => tokenIn(token, s.prompt))) continue;
      const state = story.cast?.find(c => c.token === token);
      const name = state?.name ?? (spec && typeof spec === 'object' && 'name' in spec ? String((spec as { name: string }).name) : token.charAt(0) + token.slice(1).toLowerCase());
      nodes.push({ id: `cast:${token}`, kind: 'cast', col: 1, label: name, token, status: takeStatus(state), note: takeNote(state), detail: 'lembar referensi' });
      edges.push({ from: 'storyboard', to: `cast:${token}` });
      castTokens.push(token);
    }
  }

  for (const shot of shots) {
    const state = story.shots.find(s => s.id === shot.id);
    let source = 'storyboard';
    if (konsisten && state?.frame) {
      const id = `frame:${shot.id}`;
      nodes.push({ id, kind: 'frame', col: 2, label: shot.id, shotId: shot.id, status: takeStatus(state.frame), note: takeNote(state.frame), detail: shot.narration ?? 'tanpa narasi' });
      edges.push({ from: 'look', to: id });
      for (const t of castTokens.filter(t => tokenIn(t, shot.prompt))) edges.push({ from: `cast:${t}`, to: id });
      source = id;
    }
    const clipId = `clip:${shot.id}`;
    nodes.push({
      id: clipId, kind: 'clip', col: konsisten ? 3 : 1, label: shot.id, shotId: shot.id,
      status: shot.reuse ? 'done' : takeStatus(state ? { status: state.status } : undefined),
      note: takeNote(state), detail: shot.reuse ? 'pakai ulang klip' : '6 detik · narasi Veo'
    });
    edges.push({ from: source === 'storyboard' ? 'look' : source, to: clipId });
    edges.push({ from: clipId, to: 'final' });
  }

  nodes.push({
    id: 'final', kind: 'final', col: konsisten ? 4 : 2, label: 'Rakit video',
    status: story.status === 'done' ? 'done' : story.status === 'assembling' ? 'running'
      : story.status === 'failed' && !story.shots.some(s => s.status === 'failed' || s.frame?.status === 'failed') ? 'failed' : 'idle',
    detail: 'judul · crossfade · −14 LUFS'
  });
  return { nodes, edges };
}
