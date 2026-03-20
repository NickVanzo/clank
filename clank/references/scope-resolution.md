# Scope Resolution

How agents ask for, receive, and resolve scope across all modes.

---

## 1. Scope Questions Per Mode

### Audit

> "What would you like to audit? (full project, a directory, specific files, or a single function?)"

### Bootstrap

> "What code would you like me to generate tests for? (full project, a directory, specific files, or a single function?)"

Follow-up if not full project:

> "Do you want to cover the full public API, happy paths only, or include edge cases?"

### Refactor

> "What part of your test suite would you like to refactor? (full project, a directory, specific files?)"

Follow-up:

> "What kind of improvements are you looking for? (e.g., deduplication, naming, fixture extraction, parameterization)"

### Watch

> "What would you like to monitor for drift? (default: full project — press Enter to accept)"

---

## 2. Scope Object JSON Schema

```json
{
  "type": "...",
  "paths": ["string"],
  "symbols": ["string"]
}
```

The four valid scope kinds: `project` · `directory` · `file` · `function`

- `type` determines how agents interpret the scope
- `paths` is always an array (never a bare string)
- `symbols` is populated only for function-level scope; empty array otherwise

---

## 3. Resolution Rules

### "full project"

```json
{ "type": "project", "paths": ["."], "symbols": [] }
```

### directory

```json
{ "type": "directory", "paths": ["src/api/"], "symbols": [] }
```

- Normalize trailing slash: `src/api` → `src/api/`
- Relative to project root

### file

```json
{ "type": "file", "paths": ["src/utils/parser.ts"], "symbols": [] }
```

- Use relative path from project root

### function

```json
{ "type": "function", "paths": ["src/utils/parser.ts"], "symbols": ["parseDate"] }
```

- `paths` contains the file containing the function
- `symbols` contains the function/method name

### multiple paths

When the user specifies more than one path, use the most specific scope kind that applies across all paths.
Two directories → kind `directory`; two files → kind `file`. Example (same structure as the single-directory case above, with multiple entries in `paths`):

```json
{ "paths": ["src/api/", "src/auth/"], "symbols": [] }
```

---

## 4. Stack Detection Per Path

After resolving scope, run:

```bash
node ~/.claude/clank/bin/clank-tools.cjs detect-stack {path}
```

For EACH path in `scope.paths`. If paths resolve to different stacks, treat each independently in the report.

---

## 5. Scope in Report Frontmatter

Scope is stored as an inline JSON string on ONE line in YAML frontmatter:

```yaml
scope: '{"type":"...","paths":["..."],"symbols":[]}'
```

Replace `"type":"..."` with the resolved type. This avoids multi-line YAML parsing complexity.
Agents write it with `JSON.stringify(scope)`.

---

## 6. Ambiguity Handling

- If user says "the utils directory" without a path: ask "Can you give me the path? (e.g., `src/utils/`)"
- If user says "just the parser" without specifying file or function: ask "Is that a file (`src/utils/parser.ts`) or a function within a file?"
- If the answer is still ambiguous after one follow-up: default to the broader interpretation and confirm with the user
- **Never assume a scope — always confirm before proceeding**
