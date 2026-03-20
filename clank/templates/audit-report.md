---
id: {{ID}}
mode: audit
scope: {{SCOPE_JSON}}
stack: {{STACK}}
codegraph_confidence: {{CODEGRAPH_CONFIDENCE}}
created_at: {{CREATED_AT}}
status: complete
based_on: null
---

# Clank Audit Report

## Scope
{{SCOPE_DESCRIPTION}}

## Findings

### Coverage Gaps
<!-- List of untested files/functions with severity -->

### Anti-Patterns
<!-- List of detected test smells with file:line and severity -->

### Redundancy
<!-- Duplicate coverage or dead tests -->

## Metrics
- Files analyzed: {{FILES_ANALYZED}}
- Functions covered: {{COVERED}}/{{TOTAL}} ({{PCT}}%)
- Blocking violations: {{BLOCKING_COUNT}}
- Advisory violations: {{ADVISORY_COUNT}}

## Recommended Actions
<!-- Numbered, prioritized list -->

## Raw Data
```json
{
  "findings": []
}
```
