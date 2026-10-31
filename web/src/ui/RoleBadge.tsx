import { Badge } from '@/components/ui/badge';
import { ROLE_LABEL, type Role } from '../lib/workspaces.js';

/** One look for a role everywhere: sidebar, members list, project header, invite page. */
export function RoleBadge(props: { role: Role; className?: string }) {
  return (
    <Badge variant="secondary" className={props.className} data-role={props.role}>
      {ROLE_LABEL[props.role]}
    </Badge>
  );
}
