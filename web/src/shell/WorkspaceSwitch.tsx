/**
 * The workspace switcher: only when you belong to more than one (the personal workspace alone
 * is not a choice). Name + your role, never a native select.
 */
import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { Choice } from '../ui/controls.js';
import { RoleBadge } from '../ui/RoleBadge.js';
import { useWorkspaceState } from '../lib/workspace.js';
import { ROLE_LABEL, type Role } from '../lib/workspaces.js';

export function WorkspaceSwitch() {
  const { workspaces, current, select, loading } = useWorkspaceState();
  if (loading && workspaces.length === 0) {
    return (
      <div className="mx-1.5 mb-1 px-1" aria-busy="true" aria-label="Memuat workspace">
        <Skeleton className="h-6 w-full rounded-md" />
      </div>
    );
  }
  if (workspaces.length < 2 || !current) return null;
  return (
    <div className="mx-1.5 mb-1 flex flex-col gap-1 rounded-md border border-border/60 p-1.5">
      <Choice label="Workspace" value={current.id} size="sm" className="w-full"
        options={workspaces.map(w => ({ value: w.id, label: w.name, hint: ROLE_LABEL[w.role as Role] }))}
        onChange={select} />
      <div className="flex items-center gap-1.5 px-0.5">
        <RoleBadge role={current.role} className="h-4.5 px-1.5 text-[10.5px] font-normal" />
        <Link to="/pengaturan/anggota-workspace" className="ml-auto text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">Kelola anggota</Link>
      </div>
    </div>
  );
}
