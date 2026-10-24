// Vendored from Solid Glass (MIT, (c) 2026 DeepLethe; built on shadcn/ui, MIT, (c) 2023 shadcn).
// https://github.com/deeplethe/solid-glass/blob/main/src/components/ui/label.tsx — see web/src/components/ui/NOTICE.md
"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
