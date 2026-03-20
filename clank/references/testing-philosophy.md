# Testing Philosophy Reference

This document is read by every Clank agent that writes or evaluates tests. All rules are binding.

---

## Test Layers Model

Every test belongs to exactly one layer. **Mocking advice depends on layer classification. Never evaluate mocking without first classifying the test layer.**

| Layer | Definition | Mocking Rule |
|-------|------------|--------------|
| **Unit test** | Tests one function or class in isolation; all dependencies are mocked or stubbed | Mock only at architectural boundaries: external services, filesystem, time, randomness. Do not mock collaborators that are part of the same module or package. |
| **Integration test** | Crosses process, service, or database boundaries; tests that components work together | Mock nothing within the system boundary. You may stub external third-party services (payment processors, SMS gateways, external APIs) that you do not control. |
| **End-to-end test** | Tests a full user workflow from entry point to observable outcome | No mocking of any kind. |

Misclassifying a test layer is a blocking error when the misclassification changes what mocking is appropriate.

---

## Philosophy Rules

| Rule | Severity | Source |
|------|----------|--------|
| One concept per test | Blocking | Osherove — *The Art of Unit Testing* |
| Test behavior not implementation | Blocking | Freeman & Pryce — *Growing Object-Oriented Software, Guided by Tests* |
| Tests must be readable as documentation | Blocking | Beck — *Test-Driven Development: By Example* |
| No logic in tests (loops, conditionals) | Blocking | Osherove — *The Art of Unit Testing* |
| Arrange-Act-Assert structure, always | Blocking | Meszaros — *xUnit Test Patterns* |
| Mock only at architectural boundaries (unit tests) | Blocking | Freeman & Pryce — *Growing Object-Oriented Software, Guided by Tests* |
| A test that can't fail is worse than no test | Blocking | Beck — *Test-Driven Development: By Example* |
| Characterization tests before refactoring legacy | Blocking | Feathers — *Working Effectively with Legacy Code* |
| Test names describe behavior in plain language | Blocking | Osherove — *The Art of Unit Testing* |
| Tests are first-class code — same quality standards | Blocking | Martin — *Clean Code* |
| Test helpers expose one entry point, not a multi-object assembly | Advisory | Ousterhout — *A Philosophy of Software Design* (adapted) |
| No assertion roulette — multiple bare asserts without failure context | Blocking | Meszaros — *xUnit Test Patterns* |

---

## Detection: "A Test That Can't Fail"

A test that can't fail provides false confidence and is actively harmful. Agents must flag any of the following signals:

1. **Swallowed exception in assertion** — assertion is inside a bare `catch`/`except` block and the block does not rethrow. The test passes whether the exception occurs or not.
   ```python
   # Bad
   try:
       result = do_thing()
       assert result == expected
   except Exception:
       pass  # test always passes
   ```

2. **Tautological assertion** — the assertion compares a value to itself.
   ```js
   expect(x).toBe(x)          // always true
   assert result == result     // always true
   ```

3. **No assertion** — the test body executes code but asserts nothing. It only fails if an exception is thrown.

4. **Asserting on a mock's own return value** — the mock returns what it was configured to return; asserting on that value tests the mock configuration, not the system under test.
   ```js
   const mock = jest.fn().mockReturnValue(42);
   callSystemWith(mock);
   expect(mock()).toBe(42);  // tests jest, not the system
   ```

---

## Blocking Violation Behavior

- A report with **any blocking violation** MUST NOT be marked `status: complete`.
- Blocking violations are listed in the Findings section with `severity: blocking`.
- When blocking violations are found but the run otherwise completed, the report status is set to `partial`.

---

## Advisory Violation Behavior

- Advisory violations are listed in Findings with `severity: advisory`.
- Advisory violations do **not** block report completion.
- `status: complete` is valid when only advisory violations are present.

---

## Citation Block

| Author(s) | Title |
|-----------|-------|
| Kent Beck | *Test-Driven Development: By Example* |
| Roy Osherove | *The Art of Unit Testing* |
| Steve Freeman & Nat Pryce | *Growing Object-Oriented Software, Guided by Tests* |
| Gerard Meszaros | *xUnit Test Patterns: Refactoring Test Code* |
| Michael Feathers | *Working Effectively with Legacy Code* |
| Robert C. Martin | *Clean Code: A Handbook of Agile Software Craftsmanship* |
| John Ousterhout | *A Philosophy of Software Design* |
