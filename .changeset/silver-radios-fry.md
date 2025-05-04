---
'@repo/workspace-dependencies': patch
---

fix: only export z from zod

There seem to be intermittent issues with `turbo generate` when exporting `*`, so only exporting `z` for now.
