/** Small cast chips (name + tiny sheet avatar when it exists), shared by the scene board and the shot sheet. */
import { cn } from '@/lib/utils';
import type { Story } from '../stories/storiesClient.js';
import type { CastChip } from './SceneHelpers.js';
import { media } from './useProject.js';
import { sized } from '../../lib/media.js';

export function SceneCastChips(props: { projectId: string; story: Story; cast: CastChip[]; label: string; className?: string }) {
  if (!props.cast.length) return <p className={cn('text-[12px] text-muted-foreground', props.className)}>Belum ada pemeran terdeteksi di prompt.</p>;
  return (
    <ul aria-label={props.label} className={cn('flex flex-wrap items-center gap-1', props.className)}>
      {props.cast.map(c => {
        const sheet = props.story.cast?.find(x => x.token === c.token);
        return (
          <li key={c.token} title={c.token} className="flex h-6 items-center gap-1 rounded-full border bg-(--field) pr-2 pl-0.5 text-[12px]">
            {sheet?.status === 'done'
              ? <img src={sized(media.cast(props.projectId, c.token, sheet.mediaId ?? ''), 20)} width={20} height={20} alt="" loading="lazy" decoding="async" className="size-5 rounded-full object-cover" />
              : <span aria-hidden="true" className="size-5 rounded-full bg-muted" />}
            {c.name}
          </li>
        );
      })}
    </ul>
  );
}
