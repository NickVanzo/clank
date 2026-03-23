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
  db.ts                  (was src/db.cjs)
  clank.ts               (was bin/clank.cjs — MCP server)
  clank-tools.ts         (was bin/clank-tools.cjs)
  install.ts             (was bin/install.js)
  db.test.ts             (was tests/db.test.cjs, colocated)
  clank-tools.test.ts    (was tests/clank-tools.test.cjs, colocated)
dist/                    (compiled output, gitignored)
```

Old files (`bin/*.cjs`, `src/db.cjs`, `tests/*.cjs`) are deleted — no parallel existence.

## package.json Changes

- `"type": "module"` (ESM)
- Scripts:
  - `"build": "tsc -p tsconfig.json"`
  - `"test": "vitest run"`
  - `"dev": "tsx src/clank-tools.ts"` (for interactive use)
- `bin` entries point to `dist/` compiled outputs
- devDependencies added: `typescript`, `@types/node`, `@types/better-sqlite3`, `tsx`, `vitest`
- Remove: no tooling removed beyond what's replaced

## tsconfig.json

Target `ES2022`, module `NodeNext`, strict mode with all CLAUDE.md-required flags:

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
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

## Migration Approach

Files are migrated one at a time in dependency order:

1. `src/db.ts` — no internal deps
2. `src/clank.ts` — depends on db
3. `src/clank-tools.ts` — standalone
4. `src/install.ts` — standalone
5. `src/db.test.ts` — depends on db
6. `src/clank-tools.test.ts` — depends on clank-tools

Rules:
- No `any` — all types must be explicit or inferred
- No `// @ts-ignore` or `// @ts-expect-error` without a justification comment
- All 65 existing tests must pass before migration is considered complete
- `tsc --noEmit` must report zero errors

## Key ESM Migration Notes

- Replace `require()` with `import`
- Replace `module.exports` with `export`
- Replace `__dirname`/`__filename` with `import.meta.url` + `fileURLToPath`
- All internal imports must include `.js` extension (NodeNext resolution)

## Success Criteria

- `npm run build` completes with zero errors
- `npm test` passes all 65 tests
- `tsc --noEmit` reports zero errors
- No `.cjs` or `.js` source files remain in `src/` or `bin/`
- `dist/` is gitignored
