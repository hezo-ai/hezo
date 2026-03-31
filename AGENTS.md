# Agent Guidelines

## Documentation

The `.dev/` folder contains project specifications, schema definitions, API design, and implementation plans. These docs must stay in sync with the codebase — when code changes, update the relevant docs to reflect the current state.

When updating docs:
- Describe what the system **does**, not what changed
- Don't reference what was removed, replaced, or decided against — only document what exists now
- No backwards compatibility concerns until v1.0.0 — when things change, just change them cleanly

## Testing

Tests must actually test functionality — not just assert that code runs without throwing. If something is too difficult to mock for a unit test, write an integration test instead. Prefer integration tests over heavily-mocked unit tests.

## Implementation Phases

When completing an implementation phase, update `.dev/implementation-phases.md` to mark the phase as done with a completion date. Keep the phase content intact — just add a status line at the top of the phase section.
