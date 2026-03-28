# TypeScript Migration Design

**Date:** 2026-03-23
**Status:** Approved

## Context

Clank is currently written in CommonJS JavaScript (`.cjs` files). The memory-graph PR (#1) adds `src/db.cjs` and `bin/clank.cjs`. Once that PR is merged, the full codebase will be migrated to TypeScript following the same pattern used by codegraph.

## Scope

Migrate all source and test files to TypeScript after merging the memory-graph PR. No new features — pure migration.

## Source Layout

```
src/
  db.ts                  (was src/db.cjs — no internal deps)
  install.ts             (was bin/install.js — standalone, spawned as subprocess)
  clank.ts               (was bin/clank.cjs — MCP server + installer runner, depends on db.ts)
  clank-tools.ts         (was bin/clank-tools.cjs — depends on db.ts)
  db.test.ts             (was tests/db.test.cjs, colocated)
  clank-tools.test.ts    (was tests/clank-tools.test.cjs, colocated)
dist/                    (compiled output, gitignored)
bin/                     (deleted — all source moves to src/)
tests/                   (deleted — tests colocate with source)
```

## Dependency Graph

```
db.ts          ← no internal deps
install.ts     ← no internal deps (no compile-time link to clank.ts)
clank.ts       ← db.ts
clank-tools.ts ← db.ts (dynamic import in cmdMemorySummary)
```

`clank.ts` spawns `install.js` at runtime via `execSync` using `import.meta.url` to resolve the path — no TypeScript import relationship. Both compile to `dist/`, so the relative path `./install.js` is preserved.

## package.json Changes

- `"type": "module"` (ESM)
- Scripts:
  - `"build": "tsc -p tsconfig.json"`
  - `"lint": "oxlint src"`
  - `"test": "vitest run"`
- `bin` entries updated (only these two — `install.ts` is not a bin entry):
  - `"clank-tools"` → `"./dist/clank-tools.js"`
  - `"clank"` → `"./dist/clank.js"`
- devDependencies added: `typescript`, `@types/node`, `tsx`, `vitest`, `oxlint`
- devDependencies removed: none (project had no devDeps before this migration)

## tsconfig.json

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

No `declaration`, `declarationMap`, or `sourceMap` — clank is a CLI, not a library.

## oxlint Configuration

`.oxlintrc.json` at repo root:

```json
{
  "plugins": ["typescript", "import", "unicorn"],
  "rules": {}
}
```

## vitest.config.ts

Lives at repo root (outside `tsconfig.json`'s `include: ["src"]` — intentional, vitest loads it via its own esbuild transform, not tsc):

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Vitest strips types via esbuild at test runtime — it does **not** type-check. Type correctness is verified separately via `tsc --noEmit -p tsconfig.json`. Both must pass.

## ESM Migration Notes

- Replace `require()` with `import`
- Replace `module.exports` with `export`
- Replace `__dirname` with `fileURLToPath(new URL('.', import.meta.url))`
- Replace `__filename` with `fileURLToPath(import.meta.url)`
- All internal imports must include `.js` extension (NodeNext resolution)
- Dynamic `require()` (e.g., in `cmdMemorySummary`) becomes `await import(...)` — call site must be async
- `clank.ts` locates `install.js` via `fileURLToPath(new URL('./install.js', import.meta.url))` — both compile to `dist/`, path is preserved. Node runs `dist/install.js` as ESM because `"type": "module"` is set in package.json.

## Pre-commit Hooks

Update `prek` hooks to run:

```
tsc --noEmit -p tsconfig.json
oxlint src
vitest run
```

## Migration Order

1. `src/db.ts`
2. `src/install.ts`
3. `src/clank.ts`
4. `src/clank-tools.ts`
5. `src/db.test.ts`
6. `src/clank-tools.test.ts`

Rules:
- No `any` — all types must be explicit or inferred
- No `// @ts-ignore` or `// @ts-expect-error` without a justification comment

## Test Coverage

`db.ts` and `clank-tools.ts` have unit tests. `clank.ts` (MCP server entry point) and `install.ts` (installer script) are intentionally untested — they are integration-level entry points with no unit test files.

## .gitignore

Add `dist/` to `.gitignore`.

## Success Criteria

- `npm run build` completes with zero errors
- `npm test` passes all existing tests
- `tsc --noEmit -p tsconfig.json` reports zero errors
- `oxlint src` reports zero warnings
- `bin/` and `tests/` directories are deleted
- `dist/` is listed in `.gitignore`
