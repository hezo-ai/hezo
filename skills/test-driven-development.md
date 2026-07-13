---
name: Test-Driven Development
description: Use when implementing any feature or bugfix, before writing implementation code. Write the failing test first, watch it fail, then write minimal code to pass.
source_url: https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/test-driven-development/SKILL.md
---

# Test-Driven Development (TDD)

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** if you didn't watch the test fail, you don't know whether it tests the right thing.

**The iron law: no production code without a failing test first.** Wrote code before the test? Delete it and start over — don't keep it as "reference", don't "adapt" it while writing tests. Code kept around biases the tests toward what you built instead of what's required.

Applies to new features, bug fixes, refactoring, and behavior changes. Exceptions (throwaway prototypes, generated code, pure configuration) should be agreed in the task thread, not self-granted.

## Red — write a failing test

Write one minimal test showing what *should* happen:

- One behavior per test.
- A name that describes the behavior (`retries failed operations 3 times`, not `test1`).
- Real code paths — mock only what's genuinely unavoidable (network, clock). A test that exercises a mock proves the mock works.

## Verify red — watch it fail

Mandatory; never skip. Run the test and confirm:

- it **fails** (doesn't error out on a typo);
- the failure message is the one you expected;
- it fails because the behavior is missing — not because of a broken import.

Test passes immediately? You're testing existing behavior — fix the test. Test errors? Fix the error and re-run until it fails *correctly*.

## Green — minimal code

Write the simplest code that passes the test. Don't add options, generality, or "improvements" beyond what the test demands — that's untested code wearing a tested test's badge.

## Verify green — watch it pass

Run it again. Confirm: this test passes, every other test still passes, and the output is pristine (no new warnings or stray errors). Test fails? Fix the code, not the test.

## Refactor — clean up

Only after green: remove duplication, improve names, extract helpers. Keep tests green throughout. Don't add behavior — that's the next red.

Then repeat: next failing test for the next behavior.

## Why order matters

Tests written after code pass immediately — and passing immediately proves nothing. They test what you built, not what was required; they verify the edge cases you remembered, not the ones you'd have discovered. Test-first forces the edge-case discovery *before* implementation, and the red step proves the test can actually catch a failure.

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to test" | Simple code breaks; the test takes a minute. |
| "I'll test after" | A test that never failed proves nothing. |
| "I already manually tested it" | Ad-hoc and unrepeatable; no record, can't re-run. |
| "Deleting X hours of work is wasteful" | Sunk cost. Keeping unverified code is the real debt. |
| "The test is hard to write" | Listen to it — hard to test usually means hard to use. Simplify the design. |
| "TDD will slow me down" | Slower than debugging in production? |

## Bug fixes

A bug is a missing test. Write the failing test that reproduces it, then fix. The test proves the fix and prevents the regression. Never fix a bug without one.

## Checklist before marking work complete

- Every new function/behavior has a test.
- You watched each test fail, for the expected reason.
- Minimal code; all tests pass; output pristine.
- Edge cases and error paths covered.

Can't check every box? Then it wasn't TDD — be honest about that in the task thread and close the gaps.
