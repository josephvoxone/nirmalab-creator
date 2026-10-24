import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minus, Plus, X } from 'lucide-react';
import { KIND_LABEL, STATUS_TEXT, type FlowEdge, type FlowNode, type NodeKind } from './flowGraph.js';

const W = 208;
const GAP_X = 64;
const GAP_Y = 14;
const PAD = 24;
const HEIGHT: Record<NodeKind, number> = { storyboard: 104, look: 92, cast: 176, frame: 128, clip: 128, final: 104 };

type Placed = FlowNode & { x: number; y: number; h: number };

function layout(nodes: FlowNode[]): { placed: Placed[]; width: number; height: number } {
  const cols = new Map<number, FlowNode[]>();
  for (const n of nodes) cols.set(n.col, [...(cols.get(n.col) ?? []), n]);
  const colHeight = (list: FlowNode[]) => list.reduce((t, n) => t + HEIGHT[n.kind], 0) + GAP_Y * (list.length - 1);
  const tallest = Math.max(...[...cols.values()].map(colHeight));
  const placed: Placed[] = [];
  for (const [col, list] of cols) {
    let y = PAD + (tallest - colHeight(list)) / 2;
    for (const n of list) {
      placed.push({ ...n, x: PAD + col * (W + GAP_X), y, h: HEIGHT[n.kind] });
      y += HEIGHT[n.kind] + GAP_Y;
    }
  }
  const lastCol = Math.max(...cols.keys());
  return { placed, width: PAD * 2 + (lastCol + 1) * W + lastCol * GAP_X, height: tallest + PAD * 2 };
}

function edgePath(a: Placed, b: Placed) {
  const x1 = a.x + W, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
  const bend = Math.max(36, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function FlowCanvas(props: {
  nodes: FlowNode[]; edges: FlowEdge[];
  thumb: (node: FlowNode) => ReactNode;
  inspector: (node: FlowNode) => ReactNode;
}) {
  const { placed, width, height } = useMemo(() => layout(props.nodes), [props.nodes]);
  const byId = useMemo(() => new Map(placed.map(n => [n.id, n])), [placed]);
  const [selected, setSelected] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  const fit = () => {
    const w = viewport.current?.clientWidth ?? 0;
    // Floor so the whole graph fits; never upscale past 100%.
    setZoom(w > 0 ? Math.min(1, Math.max(0.5, Math.floor(((w - 4) / width) * 20) / 20)) : 1);
  };
  useLayoutEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    fit();
  });

  const current = selected ? props.nodes.find(n => n.id === selected) : undefined;
  const step = (d: number) => setZoom(z => Math.min(1.5, Math.max(0.5, Math.round((z + d) * 10) / 10)));

  return (
    <section className="flow" aria-label="Alur produksi">
      <div className="flow-toolbar">
        <div className="flow-legend" aria-hidden="true">
          {(['done', 'running', 'pending', 'failed'] as const).map(s => <span key={s} className={`legend ${s}`}><i />{STATUS_TEXT[s]}</span>)}
        </div>
        <div className="flow-zoom">
          <button type="button" className="icon-btn" aria-label="Perkecil" onClick={() => step(-0.1)}><Minus size={15} /></button>
          <span data-testid="flow-zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-btn" aria-label="Perbesar" onClick={() => step(0.1)}><Plus size={15} /></button>
          <button type="button" className="icon-btn" aria-label="Pas layar" onClick={fit}><Maximize2 size={15} /></button>
        </div>
      </div>
      <div className={`flow-body${current ? ' with-inspector' : ''}`}>
        <div className="flow-viewport" ref={viewport}>
          <div className="flow-canvas" style={{ width: width * zoom, height: height * zoom }}>
            <div style={{ width, height, transform: `scale(${zoom})`, transformOrigin: '0 0', position: 'relative' }}>
              <svg className="flow-wires" width={width} height={height} aria-hidden="true">
                {props.edges.map(e => {
                  const a = byId.get(e.from), b = byId.get(e.to);
                  if (!a || !b) return null;
                  const tone = b.status === 'running' ? 'running' : a.status === 'done' && b.status !== 'idle' ? 'done' : a.status === 'failed' ? 'failed' : 'idle';
                  const hot = selected && (e.from === selected || e.to === selected);
                  return <path key={`${e.from}>${e.to}`} className={`flow-edge ${tone}${hot ? ' hot' : ''}`} d={edgePath(a, b)} />;
                })}
              </svg>
              {placed.map(n => (
                <button
                  key={n.id}
                  type="button"
                  className={`flow-node ${n.kind} ${n.status}${selected === n.id ? ' selected' : ''}`}
                  style={{ left: n.x, top: n.y, width: W, height: n.h }}
                  aria-label={`${KIND_LABEL[n.kind]} ${n.label} · ${STATUS_TEXT[n.status]}`}
                  aria-pressed={selected === n.id}
                  onClick={() => setSelected(s => (s === n.id ? undefined : n.id))}
                >
                  <span className="flow-node-head"><b>{KIND_LABEL[n.kind]}</b><span className="flow-status"><i />{STATUS_TEXT[n.status]}</span></span>
                  <span className="flow-node-body">
                    <span className="flow-thumb">{props.thumb(n)}</span>
                    <span className="flow-node-text">
                      <strong>{n.label}</strong>
                      {n.detail && <small>{n.detail}</small>}
                      {n.note && <em>{n.note}</em>}
                    </span>
                  </span>
                  <span className="port in" aria-hidden="true" /><span className="port out" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </div>
        {current && (
          <aside className="flow-inspector" aria-label="Inspector">
            <header>
              <div><small>{KIND_LABEL[current.kind]}</small><b>{current.label}</b></div>
              <button type="button" className="icon-btn" aria-label="Tutup inspector" onClick={() => setSelected(undefined)}><X size={16} /></button>
            </header>
            <div className="flow-inspector-body">{props.inspector(current)}</div>
          </aside>
        )}
      </div>
    </section>
  );
}
