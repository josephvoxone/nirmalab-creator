// Vendored from Solid Glass (MIT, (c) 2026 DeepLethe; built on shadcn/ui, MIT, (c) 2023 shadcn).
// https://github.com/deeplethe/solid-glass/blob/main/src/components/ui/separator.tsx — see web/src/components/ui/NOTICE.md
"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"
import { cn } from "@/lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: SeparatorPrimitive.Props) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
