/**
 * "Scene baru" on a bible board: every scene of a bible board needs a story goal (the shot planner and
 * the compiler read it), so a new scene — added, or split after a shot — is created through this form:
 * title, required Tujuan, optional Lokasi from the bible. Legacy boards never see it.
 */
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Choice, inputClass, textareaClass } from '../../ui/controls.js';
import { locationChoices, type Board, type SceneGoal } from './model.js';

const NO_LOCATION = '__none__';

export function NewSceneDialog(props: {
  open: boolean; board: Board; defaultTitle: string; afterShot?: string;
  onOpenChange: (open: boolean) => void; onCreate: (title: string, extra: SceneGoal) => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [location, setLocation] = useState('');
  // Every opening starts empty.
  useEffect(() => { if (props.open) { setTitle(''); setGoal(''); setLocation(''); } }, [props.open]);
  const locations = locationChoices(props.board);
  const ready = !!goal.trim();
  const submit = () => {
    if (!ready) return;
    props.onCreate(title.trim(), { goal: goal.trim(), ...(location && location !== NO_LOCATION ? { location } : {}) });
    props.onOpenChange(false);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scene baru</DialogTitle>
          <DialogDescription>
            {props.afterShot ? `Shot setelah ${props.afterShot} pindah ke scene ini. ` : ''}Tiap scene punya satu tujuan cerita; shot di dalamnya disusun untuk mencapainya.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={e => { e.preventDefault(); submit(); }}>
          <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
            Judul scene
            <input aria-label="Judul scene" value={title} maxLength={80} placeholder={props.defaultTitle} onChange={e => setTitle(e.target.value)} className={inputClass} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted-foreground">
            <span>Tujuan <span aria-hidden="true">*</span></span>
            <textarea aria-label="Tujuan scene" required rows={2} value={goal} maxLength={300} placeholder="mis. Laras menyembunyikan Kapas dari pembeli"
              onChange={e => setGoal(e.target.value)} className={`${textareaClass} min-h-14 text-[12.5px]`} />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] text-muted-foreground">Lokasi <span className="text-muted-foreground/70">(opsional)</span></span>
            {locations.length ? (
              <Choice label="Lokasi" size="sm" value={location} className="w-fit min-w-40" placeholder="Pilih…" onChange={setLocation}
                options={[{ value: NO_LOCATION, label: 'Tanpa lokasi' }, ...locations.map(l => ({ value: l.key, label: l.name, hint: l.key }))]} />
            ) : <p className="text-[12px] text-muted-foreground">Belum ada lokasi — tambahkan di Breakdown bila scene ini butuh latar tetap.</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => props.onOpenChange(false)}>Batal</Button>
            <Button type="submit" size="sm" disabled={!ready}>Buat scene</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
