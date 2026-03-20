# Clank

Test suite lifecycle management for Claude Code. Clank audits your test suite for coverage gaps and anti-patterns, generates characterization tests for untested code, refactors test structure without changing what is tested, and watches for drift between production code and tests.

## Installation

```bash
node bin/install.js
```

Or, after publishing: `npx clank install`

## Commands

| Command | Description |
|---------|-------------|
| `/clank:audit` | Analyze test coverage, find anti-patterns, produce a findings report |
| `/clank:bootstrap` | Generate characterization tests for untested code |
| `/clank:refactor` | Restructure your test suite without changing what is tested |
| `/clank:watch` | Detect drift between production code and the test suite |

## Report History

Reports are stored in `clank_reports/` in your project. Each report is a Markdown file with a YAML frontmatter header containing `id`, `mode`, `status`, `scope`, and `created_at`. Use `clank-tools recent 5` to list the most recent reports.

## CodeGraph Integration

Clank uses [CodeGraph](https://github.com/anthropics/codegraph) to navigate your codebase more accurately and use fewer tokens. If CodeGraph is not initialized, Clank falls back to Grep/Glob and tags results with `confidence: low`.

To initialize CodeGraph: `codegraph init -i`

## Testing Philosophy

Clank enforces rules drawn from foundational testing literature:
- Kent Beck — *Test-Driven Development: By Example*
- Roy Osherove — *The Art of Unit Testing*
- Steve Freeman & Nat Pryce — *Growing Object-Oriented Software, Guided by Tests*
- Gerard Meszaros — *xUnit Test Patterns*
- Michael Feathers — *Working Effectively with Legacy Code*

Violations at **blocking** severity prevent a report from being marked complete. Violations at **advisory** severity are reported but do not block completion.

## Behavior-Preservation Guarantee

For `/clank:refactor` and `/clank:bootstrap`:
- The full test suite runs before any changes
- Each change is a separate unit tracked in a journal
- If any change causes a regression, it is immediately reverted
- The report records what was changed, what was reverted, and why

## Contributing

See the design spec at `docs/superpowers/specs/2026-03-20-clank-design.md`.
