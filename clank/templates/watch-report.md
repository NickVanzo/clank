---
id: {{ID}}
mode: watch
scope: {{SCOPE_JSON}}
stack: {{STACK}}
codegraph_confidence: {{CODEGRAPH_CONFIDENCE}}
created_at: {{CREATED_AT}}
status: complete
based_on: {{BASELINE_AUDIT_ID}}
---

# Clank Watch Report

## Scope
{{SCOPE_DESCRIPTION}}

## Baseline
- Baseline report ID: {{BASELINE_AUDIT_ID}}
- Baseline date: {{BASELINE_DATE}}

## Drift Detected

### New Files Without Tests
<!-- Files added since baseline that have no corresponding test coverage -->

### Signature Changes
<!-- Functions whose signatures changed since baseline, potentially breaking existing tests -->

### Dead References
<!-- Tests that reference functions or symbols that no longer exist -->

## Priority Actions
<!-- Numbered list of recommended actions, ordered by severity -->

## Metrics
- Files drifted: {{FILES_DRIFTED}}
- Functions drifted: {{FUNCTIONS_DRIFTED}}

## Raw Data
```json
{
  "findings": []
}
```
