// Vendored from Solid Glass (MIT, (c) 2026 DeepLethe; built on shadcn/ui, MIT, (c) 2023 shadcn).
// https://github.com/deeplethe/solid-glass/blob/main/src/components/ui/skeleton.tsx — see web/src/components/ui/NOTICE.md
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
