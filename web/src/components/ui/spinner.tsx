// Vendored from Solid Glass (MIT, (c) 2026 DeepLethe; built on shadcn/ui, MIT, (c) 2023 shadcn).
// https://github.com/deeplethe/solid-glass/blob/main/src/components/ui/spinner.tsx — see web/src/components/ui/NOTICE.md
import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon data-slot="spinner" role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />
  )
}

export { Spinner }
