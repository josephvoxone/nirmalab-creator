import { useState } from 'react';
import { Check, Clapperboard, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PRESET_GROUPS, presetPreview, type PresetGroup, type StylePreset } from './presets.js';
import type { Technique } from './compose.js';
import type { FlowJob } from './flowClient.js';

/** Step 2: pick a ready-made look, or start without one. */
export function StyleGallery(props: {
  presets: StylePreset[];
  techniques: Technique[];
  presetId: string | undefined;
  ownRenders: Map<string, FlowJob>;
  fileUrl: (jobId: string) => string;
  busy: boolean;
  onUse: (preset: StylePreset) => void;
  onNone: () => void;
  onRenderSample: (preset: StylePreset) => void;
}) {
  const [group, setGroup] = useState<PresetGroup>(() => props.presets.find(p => p.id === props.presetId)?.group ?? 'drama');
  const visible = props.presets.filter(p => p.group === group);

  return (
    <section aria-labelledby="studio-style-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="studio-style-title" className="text-[14px] font-medium">Pilih gaya</h2>
        <p className="text-[12.5px] text-muted-foreground">{props.presets.length} preset. Gaya mengisi teknik kamera, cahaya dan grade; subjeknya tetap kamu tulis di langkah berikut.</p>
      </div>

      <div role="tablist" aria-label="Grup preset" className="flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]">
        {PRESET_GROUPS.map(g => (
          <button key={g.key} type="button" role="tab" aria-selected={group === g.key} onClick={() => setGroup(g.key)}
            className={cn('flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent',
              group === g.key && 'glass-chosen text-foreground')}>
            {g.label} <span className="text-[11px] text-muted-foreground">{props.presets.filter(p => p.group === g.key).length}</span>
          </button>
        ))}
      </div>

      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        <li>
          <button type="button" aria-pressed={props.presetId === undefined} onClick={props.onNone}
            className={cn('glass-panel flex h-full min-h-48 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center outline-none transition-colors hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring/60',
              props.presetId === undefined && 'glass-chosen')}>
            <Sparkles aria-hidden="true" className="size-5 text-muted-foreground" />
            <b className="text-[13px] font-medium">Tanpa preset</b>
            <span className="text-[12px] text-muted-foreground">Mulai kosong, pilih teknik sendiri.</span>
          </button>
        </li>
        {visible.map(preset => {
          const own = props.ownRenders.get(preset.id);
          const media = own ? { video: props.fileUrl(own.id), image: undefined } : presetPreview(preset, props.techniques);
          const active = props.presetId === preset.id;
          return (
            <li key={preset.id}>
              <article aria-label={preset.name} className={cn('glass-panel flex h-full flex-col overflow-hidden rounded-lg', active && 'ring-1 ring-foreground/50')}>
                <div className="relative aspect-video bg-muted">
                  {media.video ? (
                    <video src={media.video} poster={media.image} muted loop playsInline preload="none" className="size-full object-cover"
                      onMouseEnter={event => void event.currentTarget.play?.().catch(() => {})}
                      onMouseLeave={event => event.currentTarget.pause?.()}
                      onFocus={event => void event.currentTarget.play?.().catch(() => {})} />
                  ) : media.image ? <img src={media.image} alt="" loading="lazy" className="size-full object-cover" /> : null}
                  <span className={cn('absolute bottom-1.5 left-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[10.5px] text-muted-foreground', own && 'text-foreground')}>
                    {own ? 'Render Flow' : 'Contoh teknik · Melies'}
                  </span>
                  {active && <Badge className="absolute top-1.5 right-1.5 h-4.5 px-1.5 text-[10.5px]"><Check aria-hidden="true" /> Dipakai</Badge>}
                </div>
                <div className="flex flex-1 flex-col gap-1 p-2.5">
                  <b className="text-[13px] font-medium">{preset.name}</b>
                  <p className="line-clamp-3 text-[12px] leading-snug text-muted-foreground">{preset.description}</p>
                  <div className="mt-auto flex items-center gap-1 pt-1.5">
                    <Button size="sm" variant="glass" data-strong="" aria-label={`Pakai gaya ${preset.name}`} onClick={() => props.onUse(preset)}>Pakai gaya ini</Button>
                    <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`Render contoh ${preset.name}`}
                      title="Antrekan render contoh preset ini ke Flow (pakai kredit akun)" disabled={props.busy} onClick={() => props.onRenderSample(preset)}>
                      <Clapperboard />
                    </Button>
                  </div>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
