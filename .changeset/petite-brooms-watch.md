---
'@repo/eslint-config': patch
---

chore: improve eslint configs

- remove unused dependencies (eslint-plugin-unused-imports, jiti)
- switch from deprecated project: true to projectService: true for TypeScript parser
- fix TypeScript ESLint v8 compatibility with proper type casting
- improve file pattern consistency across configurations (added .mts support)
- fix import plugin's TypeScript resolver file patterns
- don't disable rules-of-hooks on tsx/jsx files
- add clarifying comments for disabled rules

resolves #17
