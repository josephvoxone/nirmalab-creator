# Third-party notice

`web/src/components/ui/*`, `web/src/hooks/use-mobile.ts`, `web/src/lib/utils.ts` and
`web/src/styles/vendor/solid-glass.css` are vendored from **Solid Glass**
(https://github.com/deeplethe/solid-glass), MIT License, Copyright (c) 2026 DeepLethe.
Solid Glass is built on **shadcn/ui** (https://github.com/shadcn-ui/ui), MIT License,
Copyright (c) 2023 shadcn; `web/src/styles/vendor/shadcn-tailwind.css` is shadcn@4.21.4's
`dist/tailwind.css`.

Changes: import of `cn` points at `@/lib/utils`; `sonner.tsx` reads the theme from our own
shim instead of `next-themes`.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
