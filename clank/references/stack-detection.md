# Stack Detection

How to detect the language and test runner for a project.

## Always Use clank-tools

Never infer the stack manually by inspecting files. Always run:

```bash
node ~/.claude/clank/bin/clank-tools.cjs detect-stack <path>
```

The tool handles all detection logic consistently. Manual inspection is error-prone and will diverge from tool behavior over time.

## Reading the JSON Output

`detect-stack` returns:

```json
{
  "language": "typescript | javascript | python | rust | go | elixir | unknown",
  "framework": "node | null",
  "test_runner": "vitest | jest | mocha | jasmine | pytest | cargo-test | go-test | exunit | null",
  "manifest_path": "/absolute/path/to/manifest"
}
```

Extract `language`, `test_runner`, and `manifest_path`. Use these to:

- Build the correct test run command
- Label the report's `stack` field — format: `{language}/{test_runner}`, e.g. `typescript/vitest`
- Determine file conventions for test discovery

## Monorepo Rule

For monorepos with multiple packages, run `detect-stack` on **each path in `scope.paths` separately**. Do not run it once on the project root — the root may have no manifest, or a manifest that does not represent any individual package.

Example with `scope.paths = ["packages/api/", "packages/web/"]`:

```bash
node ~/.claude/clank/bin/clank-tools.cjs detect-stack packages/api/
# → { "language": "typescript", "test_runner": "jest", ... }

node ~/.claude/clank/bin/clank-tools.cjs detect-stack packages/web/
# → { "language": "typescript", "test_runner": "vitest", ... }
```

If paths return different stacks, treat each stack independently in the report: separate findings sections, separate metrics, each labeled with its stack.

## Conflict Rule

If `detect-stack` returns `language: unknown` and the scope is non-trivial (more than a few files):

1. Do not proceed with unknown language.
2. Ask the user: "I couldn't detect the language/runner for `<path>`. What language and test runner should I use?"
3. Accept their answer and proceed with the specified stack.
4. Note in the report: `stack: user-specified/<runner>`

## Idiomatic Test Commands Per Runner

| test_runner  | Command          |
|--------------|------------------|
| vitest       | `npx vitest run` |
| jest         | `npx jest`       |
| mocha        | `npx mocha`      |
| pytest       | `pytest`         |
| cargo-test   | `cargo test`     |
| go-test      | `go test ./...`  |
| exunit       | `mix test`       |

If `test_run_command` is set in `.clank/config.json`, use that instead of the idiomatic command above.

## Technical Note

`detect-stack` reads `devDependencies` from `package.json`. A project with both `typescript` and `vitest` in devDeps reports `language: typescript, test_runner: vitest`. TypeScript detection takes priority over JavaScript when `typescript` is present in devDeps.
