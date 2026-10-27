/**
 * "Mesin": Google Flow (free, account pool) or OpenRouter (paid per use, the configured model).
 * Two shapes of one control: `EngineChoice` for forms, `EngineMenu` for the home composer footer.
 */
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Choice } from '../../ui/controls.js';
import type { Engine, MediaKind } from './providersClient.js';
import { axcelOption, engineFor, openRouterOption, type EngineCatalog } from './useEngines.js';

export const FLOW_LABEL = 'Google Flow · gratis';

type Props = {
  label?: string;
  kind: MediaKind;
  catalog: EngineCatalog;
  value: Engine;
  onChange: (engine: Engine) => void;
  disabled?: boolean;
  showLabel?: boolean;
  className?: string;
};

function useOptions(props: Props) {
  const option = openRouterOption(props.catalog, props.kind, props.value);
  const axcel = axcelOption(props.catalog, props.kind, props.value);
  const options = [
    { value: 'flow' as const, label: FLOW_LABEL },
    { value: 'openrouter' as const, label: option.label, hint: option.hint, disabled: !option.available },
    { value: 'axcel' as const, label: axcel.label, hint: axcel.hint, disabled: !axcel.available }
  ];
  return { option, axcel, options };
}

export function EngineChoice(props: Props) {
  const { option, axcel, options } = useOptions(props);
  return (
    <Choice label={props.label ?? 'Mesin'} showLabel={props.showLabel} size="sm" disabled={props.disabled} className={cn('max-w-full min-w-44', props.className)}
      value={props.value.provider} options={options} onChange={p => props.onChange(engineFor(p, option, axcel))} />
  );
}

/** Composer-footer pick (same look as ComposerPick), with a disabled OpenRouter row + its hint. */
export function EngineMenu(props: Props) {
  const { option, axcel, options } = useOptions(props);
  const label = props.label ?? 'Mesin';
  const shown = options.find(o => o.value === props.value.provider)?.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={`${label}: ${shown}`} disabled={props.disabled}
        className="glass-held flex h-6 items-center gap-1 rounded-sm px-1.5 text-[12px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground aria-expanded:text-foreground">
        <span className="max-w-56 truncate">{shown}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuRadioGroup value={props.value.provider} onValueChange={next => props.onChange(engineFor(next as Engine['provider'], option, axcel))}>
          <DropdownMenuLabel className="text-[11px]">{label}</DropdownMenuLabel>
          {options.map(o => (
            <DropdownMenuRadioItem key={o.value} value={o.value} disabled={o.disabled} closeOnClick className={cn('text-[13px]', o.hint && 'items-start py-1.5')}>
              {o.hint ? (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{o.label}</span>
                  <span className="text-[12px] leading-snug whitespace-normal text-muted-foreground">{o.hint}</span>
                </span>
              ) : o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
