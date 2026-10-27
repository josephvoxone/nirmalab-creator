/** An icon button with the app's tooltip; the label is also its accessible name. */
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function IconTip(props: { label: string; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="icon-sm" variant="ghost" aria-label={props.label} onClick={props.onClick} className={props.className ?? 'text-muted-foreground'} />}>
        {props.children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{props.label}</TooltipContent>
    </Tooltip>
  );
}

