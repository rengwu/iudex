# Skill: tdd

**Purpose:** Build features or fix bugs using test-driven development with a red-green-refactor loop.

## Philosophy

**Core principle**: Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests should not.

**Good tests** are integration-style: they exercise real code paths through exported Go interfaces. They describe *what* the system does, not *how*. A good test reads like a specification: `TestOrchestratorClaimsQueuedTicket` tells you exactly what capability exists. These tests survive refactors.

**Bad tests** are coupled to implementation: they mock internal collaborators, test unexported functions, or verify through external means (e.g. reading `events.jsonl` directly instead of using `events.GetTicketState`).

## Anti-pattern: horizontal slices

**DO NOT** write all tests first, then all implementation.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  ...
```

Each test responds to what you learned from the previous cycle.

## Workflow

### 1. Plan

Before writing any code:
- [ ] Confirm which behaviors to test (prioritize critical paths)
- [ ] Identify the public interface to test through (exported functions, package-level API)
- [ ] Check `docs/glossary.md` so test names use project vocabulary
- [ ] Respect any relevant ADRs in `docs/adr/`
- [ ] Get user approval on the plan

Ask: "Which behaviors are most important to test? What should the public interface look like?"

### 2. Tracer bullet

Write ONE test that confirms ONE thing. Run `go test ./...` — it must fail (RED). Write minimal code to pass (GREEN).

### 3. Incremental loop

For each remaining behavior:
```
RED:   Write next test → go test ./... fails
GREEN: Minimal Go code to pass → go test ./... passes
```
Rules:
- One test at a time
- Only enough code to pass the current test
- Don't anticipate future tests
- Keep tests on observable behavior

### 4. Refactor

After all tests pass:
- [ ] Extract duplication into helpers
- [ ] Deepen modules (move complexity behind small interfaces)
- [ ] Consider what the new code reveals about existing code
- [ ] Run `go test ./...` after each refactor step

**Never refactor while RED.**

## Checklist per cycle
```
[ ] Test describes behavior, not implementation
[ ] Test uses exported interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```

---

## Reference: Good and bad tests (Go)

```go
// GOOD: Tests observable behavior through exported interface
func TestOrchestratorClaimsTicket(t *testing.T) {
    ws := setupTestWorkspace(t)
    writeQueueTicket(ws, "ticket-00001", "Add login page")

    orch := orchestrator.New(ws, cfg)
    orch.Tick()

    state, _ := events.GetTicketState(ws, "ticket-00001")
    if state != "in-progress" {
        t.Errorf("want in-progress, got %s", state)
    }
}

// BAD: Tests internal implementation detail
func TestOrchestratorCallsClaimInternal(t *testing.T) {
    o := &Orchestrator{}
    called := false
    o.claimFn = func(id string) { called = true }  // reaching into internals
    o.Tick()
    if !called { t.Error("claimFn not called") }
}
```

## Reference: When to mock (Go)

Mock at **system boundaries** only via interfaces:
- External processes (e.g. stubbing `exec.Command` for git ops in tests)
- Time (inject a clock interface instead of `time.Now()`)
- File system (use a temp dir, not an in-memory mock — Go makes this easy with `t.TempDir()`)

Don't mock:
- Your own packages
- Internal collaborators
- `events.jsonl` reads/writes — use a real temp workspace

## Reference: Deep modules in Go

```
Deep module (good):
┌────────────────────┐
│  Small interface   │  e.g. events.Append(ws, id, from, to, note)
├────────────────────┤
│                    │
│ Deep implementation│  handles file locking, UUID gen, timestamp, JSON marshaling
│                    │
└────────────────────┘

Shallow module (avoid):
┌──────────────────────────────────┐
│  Large interface                 │  many params, callers must know internals
├──────────────────────────────────┤
│  Thin implementation             │  just passes through
└──────────────────────────────────┘
```

Design interfaces that accept dependencies rather than creating them internally — enables testing without mocking your own code.
