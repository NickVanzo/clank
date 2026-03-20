# Test Anti-Patterns

Catalog of test smells detected by the clank-auditor agent. Each entry includes a detection signal
concrete enough to apply directly to source code.

---

## Severity levels

- **blocking** — the test provides false confidence or actively misleads; must be fixed before merge
- **advisory** — degrades maintainability or readability; fix preferred but not required to merge

---

## 1. Testing Implementation Details

**Severity:** blocking

**Description:** Assertions target private state, internal data structures, or the mechanics of how
code achieves a result rather than what observable outcome it produces. When the implementation
changes without the behavior changing, these tests break.

**Detection signal:**
- Accessing private/protected/internal properties in assertions (`obj._state`, `obj.__dict__`,
  `instance.#field`)
- Mocking non-public methods (methods prefixed with `_` in Python; `#` private fields in JS/TS;
  `pub(crate)` internals in Rust)
- Assertions on internal data structures (e.g., asserting the shape of a cache, internal queue
  length, or intermediate computed values never exposed by the public API)

---

## 2. Logic in Tests

**Severity:** blocking

**Description:** Conditionals, loops, or complex expressions in test bodies make the test's expected
outcome depend on the test's own logic being correct — meaning bugs in tests can silently produce
passing tests.

**Detection signal:**
- `if`/`else` or `switch` statements inside a test body
- `for`, `while`, or comprehension loops inside a test body
- Ternary expressions (`condition ? a : b` / `a if condition else b`) used inside an assertion
- Computed expected values (`expected = input.map(fn)` where `fn` is the function under test)

---

## 3. Multiple Concepts per Test

**Severity:** blocking

**Description:** A single test verifies multiple independent behaviors. When the test fails, the
failure message does not identify which behavior broke without reading the full test. Independent
behaviors should have independent tests.

**Detection signal:**
- Multiple `assert`/`expect` calls that target different subjects (different return values,
  different side effects, different error types)
- Test name contains "and" joining two distinct behaviors (e.g., `"saves record and sends email"`)
- Test name contains "also" or "then also"

---

## 4. Tests That Always Pass

**Severity:** blocking

**Description:** A test with no reachable assertion, or with assertions inside a `catch`/`except`
block that is never entered, provides zero signal. The test suite grows in apparent coverage while
actual coverage is unchanged.

**Detection signal:**
- No `assert`/`expect`/`should` call anywhere in the test body
- Assertion exists only inside a `try` block with an empty or swallowing `catch`/`except` — if the
  code under test does not throw, the assertion is never reached
  ```js
  try {
    result = doThing();
    expect(result).toBe(true); // never reached if doThing() throws
  } catch (_) {}
  ```
- `pytest.raises(SomeError)` block with no assertion on the exception object inside the `with` body
- `assertThrows`/`expect(...).toThrow()` call with no verification of the thrown value when the
  error type matters

---

## 5. Tautological Assertions

**Severity:** blocking

**Description:** An assertion whose condition is always true regardless of the code under test. The
test passes whether the code is correct or completely broken.

**Detection signal:**
- `expect(x).toBe(x)` — asserting a value equals itself
- `assert result == result` — same variable on both sides
- `assert True` / `assertTrue(true)` with no subject
- `expect(mock.returnValue).toBe(mock.returnValue)` — asserting mock configuration equals itself
- `assert len(items) >= 0` — trivially true for any collection
- `expect(typeof x).toBe(typeof x)`

---

## 6. Assertion Roulette

**Severity:** blocking

**Description:** Multiple bare assertions with no per-assertion message. When one fails, the test
runner reports a line number but not which behavior failed or what the values meant. Diagnosing
the failure requires reading and re-running the test manually.

**Detection signal:**
- 3 or more `assert`/`expect` calls in a single test with no descriptive failure message attached
- Raw `assert` in Python without a message string:
  ```python
  assert result == expected          # no message — assertion roulette
  assert result == expected, "..."   # acceptable
  ```
- Multiple `assertEquals`/`assertEqual` calls in a JUnit-style test without message parameters

**Note:** A single test with 3+ assertions on the *same* subject (e.g., checking multiple
properties of one returned object) is less severe than 3+ assertions on completely unrelated
subjects — the latter is also Multiple Concepts per Test (anti-pattern 3).

---

## 7. Unclear Test Names

**Severity:** advisory

**Description:** A test name that does not describe the behavior under test. When the test fails in
CI, a developer should be able to identify what broke from the name alone without reading the body.

**Detection signal:**
- Names matching patterns: `test1`, `test2`, `testFoo`, `test_it`, `test_thing`, `works correctly`,
  `handles error`, `does stuff`
- Names with no verb describing the outcome (e.g., `"user login"` vs. `"returns 401 when password
  is wrong"`)
- Names that describe the method called rather than the behavior expected
  (`"test_calculate"` vs. `"returns_zero_for_empty_input"`)

**Preferred format:** `<subject> <verb> <condition>` — e.g.,
- `"checkout rejects expired coupons"`
- `"returns empty list when no results match"`
- `"throws InvalidArgument when amount is negative"`

---

## 8. Excessive Mocking

**Severity:** advisory

**Description:** So many collaborators are mocked that the test only verifies that mock objects
return configured values — not that production code behaves correctly. The test would pass even if
the real dependencies were completely broken.

**Detection signal:**
- Mock count in the test is greater than or equal to the number of assertions
- Mocking methods on the system under test itself (the class/function being tested, not its
  dependencies)
- Mocking simple value objects or data classes that have no I/O or side effects
- Every call into the code under test is intercepted by a mock, leaving no real code path exercised

**Note:** Evaluate per test layer. Unit tests mock all I/O boundaries; integration tests mock only
external services; end-to-end tests mock nothing. See `testing-philosophy.md` for layer-specific
mocking rules.

---

## 9. Flaky Tests

**Severity:** blocking

**Description:** Tests that produce non-deterministic results across runs. Flaky tests erode trust
in the test suite — developers begin ignoring red builds, which eliminates the value of CI.

**Detection signals (all of the following are flakiness indicators):**

- **Unconditional sleeps:** `time.sleep(...)` or `asyncio.sleep(...)` in the test body (use
  deterministic polling or dependency injection of a fake clock instead)
- **Unordered collection ordering:** asserting on iteration order of `dict`, `set`, `Set`,
  `HashMap`, or any collection with undefined order
- **Unseeded randomness:** calling `Date.now()`, `Math.random()`, `random.random()`,
  `uuid.uuid4()`, `Uuid::new_v4()` without a fixed seed in test context
- **Live network calls:** raw HTTP requests, DNS lookups, or socket connections in tests without
  mocking (production endpoints change, have rate limits, or go offline)
- **Async race patterns:**
  - `setTimeout(fn, delay)` in test body without deterministic control
  - Missing `await` on async calls whose side effects are asserted
  - Fire-and-forget async operations whose completion is not awaited before assertions run

---

## 10. Fixture Data Without Seeding

**Severity:** advisory

**Description:** Test fixtures that generate data at fixture-creation time (timestamps, random IDs,
UUIDs) without a fixed seed or deterministic factory. Each test run uses different fixture values,
making snapshot tests break and making failures hard to reproduce.

**Detection signal:**
- `new Date()`, `Date.now()`, or `new Date(Date.now())` in fixture setup or factory functions
- `uuid()`, `uuid4()`, `uuidv4()`, `Uuid::new_v4()` in fixture setup without a seeded generator
- `random()`, `randint()`, `Math.random()` in fixture setup without a fixed seed
- `crypto.randomUUID()` called in test factories at module load time

---

## 11. Order-Dependent Tests

**Severity:** blocking

**Description:** Tests that only pass when run in a specific order, or that corrupt shared state so
that later tests fail. Order-dependent tests break when the test runner parallelizes, randomizes
order, or when a single test is run in isolation for debugging.

**Detection signal:**
- Test class with instance variables that are mutated across multiple test methods (state set in
  one test, read in another)
- Global or module-level variables modified inside a test body without teardown/cleanup
- `beforeAll`/`setUpClass` that populates shared mutable state that individual tests modify
- Tests that pass when run as a suite but fail when run individually with
  `pytest path/to/test_file.py::test_name` or `vitest run --reporter=verbose test_name`

---

## 12. Dead Tests

**Severity:** advisory

**Description:** Tests that are never executed. Dead tests accumulate tech debt — they consume
maintenance effort when the code around them changes but provide no signal about correctness.

**Detection signal:**
- `@pytest.mark.skip` without a `reason` parameter
- `@pytest.mark.skip(reason="")` with an empty string reason
- `xit(...)` or `xdescribe(...)` in Jest/Vitest with no explanatory comment
- Block-commented test functions (entire function body commented out)
- `@Disabled` (JUnit) or `#[ignore]` (Rust) without an explanatory message
- Test files that exist but are not included in any test runner configuration or import

---

## 13. Giant Setup Blocks

**Severity:** advisory

**Description:** A `beforeEach`/`setUp`/`before` block so large that the reader cannot understand
what a test is doing without reading dozens of lines of setup. Large setup blocks also tend to
prepare objects that only some tests in the suite actually use, creating noise and coupling.

**Detection signal:**
- Setup block (`beforeEach`, `setUp`, `Before`) exceeds 20 lines
- Setup creates objects or stubs that fewer than half the tests in the suite use
- Reading the setup block plus the test body together requires reading 50+ lines to understand
  the scenario being tested
- Setup block calls the system under test (performs behavior, not just construction)

**Preferred fix:** Use focused factory functions or builders that each test calls with only the
parameters relevant to that test's scenario.

---

## 14. Characterization Tests Without Naming Convention

**Severity:** advisory

**Description:** A characterization test captures the *current* behavior of existing (often legacy)
code without asserting that the behavior is *correct*. Without a naming convention, these tests are
indistinguishable from regression tests, misleading reviewers into thinking the captured behavior
has been intentionally verified.

**Detection signal:**
- Test body contains a comment like `# captures current behavior`, `// existing behavior`,
  `// TODO: verify this is correct`, or similar
- Test was added alongside a refactor with no corresponding behavior change
- Test name does not start with `characterizes_` (Python/Rust) or `"characterizes "` (Jest/Vitest
  `it`/`test` string)

**Required naming:**
```python
def characterizes_legacy_discount_calculation(): ...  # Python/Rust
```
```ts
it("characterizes legacy discount calculation when items exceed threshold", () => { ... }); // JS/TS
```
