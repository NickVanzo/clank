---
id: {{ID}}
mode: refactor
scope: {{SCOPE_JSON}}
stack: {{STACK}}
codegraph_confidence: {{CODEGRAPH_CONFIDENCE}}
created_at: {{CREATED_AT}}
status: awaiting_approval
based_on: null
journal: .clank/journals/refactor-{{ID}}.json
---

# Clank Refactor Report

## Scope
{{SCOPE_DESCRIPTION}}

## Baseline Results
- Test count before changes: {{BASELINE_TEST_COUNT}}
- Passing: {{BASELINE_PASS}}
- Failing: {{BASELINE_FAIL}}

## Planned Changes

| Unit Index | File | Description | Type of Change |
|------------|------|-------------|----------------|

## Execution Log
<!-- Filled in during run -->

| Unit | Status | Reason |
|------|--------|--------|

## Metrics
- Files analyzed: {{FILES_ANALYZED}}
- Units planned: {{UNITS_PLANNED}}
- Units completed: {{UNITS_COMPLETED}}
- Units reverted: {{UNITS_REVERTED}}

## Raw Data
```json
{
  "findings": []
}
```
