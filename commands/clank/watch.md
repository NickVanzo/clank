# /clank:watch

Detect drift between your production code and test suite.

Compares current state against the most recent audit report as baseline.
If no prior audit exists, runs a lightweight inline audit first.

Reports: new files without tests, changed function signatures, dead test references.
Never makes changes — surfaces what needs attention.

Follow the workflow at: ~/.claude/clank/workflows/watch.md
