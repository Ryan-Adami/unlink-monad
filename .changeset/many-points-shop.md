---
'@repo/tools': patch
---

chore: use exec in shell wrappers to improve performance

using exec replaces the shell process instead of creating a child, which avoids an unnecessary wrapper process and improves signal handling.

also moved away from #!/usr/bin/env to improve security (no injecting custom shells into env)
