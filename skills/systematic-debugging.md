---
name: Systematic Debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes. Find the root cause first — symptom patches waste time and create new bugs.
source_url: https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/systematic-debugging/SKILL.md
---

# Systematic Debugging

Random fixes waste time and create new bugs. Quick patches mask underlying issues.

**Core principle: always find the root cause before attempting fixes.** A symptom fix is a failure even when the symptom disappears.

Use this for any technical issue — test failures, production bugs, unexpected behavior, performance problems, build failures, integration issues. Use it *especially* when under time pressure, when "one quick fix" seems obvious, or when previous fixes haven't worked: systematic debugging is faster than guess-and-check thrashing.

## Phase 1: Root-cause investigation

Before attempting any fix:

1. **Read the error message carefully.** Don't skip past errors or warnings — they often contain the exact answer. Read stack traces completely; note line numbers, file paths, error codes.
2. **Reproduce consistently.** Can you trigger it reliably? What are the exact steps? If it isn't reproducible, gather more data — don't guess.
3. **Check recent changes.** What changed that could cause this? Diffs, recent commits, new dependencies, config or environment differences.
4. **Gather evidence at component boundaries.** In a multi-component system (pipeline → service → database, workflow → build → deploy), log what enters and exits each component and run once to see *where* it breaks. Then investigate that component — not the whole system at once.
5. **Trace backward to the source.** When the error appears deep in a flow, find where the bad value originates. Keep tracing up the chain until you reach the source; fix there, not at the point of the crash.

## Phase 2: Pattern analysis

1. **Find a working example** — similar code or a similar process in the same project that works.
2. **Compare against references completely.** If you're implementing a documented pattern, read the reference fully — don't skim.
3. **List every difference** between working and broken, however small. Don't assume "that can't matter."

## Phase 3: Hypothesis and test

1. **Form a single, specific hypothesis:** "I think X is the root cause because Y." Write it down.
2. **Test it with the smallest possible change.** One variable at a time — never several fixes at once.
3. **Didn't work?** Form a new hypothesis. Do **not** stack more changes on top.
4. **Don't know?** Say "I don't understand X" in the task thread and ask — pretending to know wastes everyone's time.

## Phase 4: Implement the fix

1. **Create a failing reproduction first** — an automated test if possible, a minimal script otherwise. You must be able to demonstrate the bug before you fix it.
2. **Make one change** addressing the identified root cause. No "while I'm here" improvements, no bundled refactoring.
3. **Verify:** reproduction now passes, nothing else broke, the original symptom is actually gone.
4. **If the fix doesn't work: stop and count.** Fewer than three attempts → return to Phase 1 with the new information. **Three or more failed fixes → stop treating it as a bug.** Each fix revealing a new problem elsewhere is the signature of an architectural problem. Question the design in the task thread before attempting fix #4.

## Red flags — stop and return to Phase 1

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- Proposing solutions before tracing the data flow
- "I don't fully understand it, but this might work"
- Changing several things and re-running to "see if it's fixed"
- "One more fix attempt" when two or more have already failed

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "The issue is simple, I don't need process" | Simple bugs have root causes too, and the process is fast for them. |
| "It's an emergency, no time" | Systematic is faster than thrashing. |
| "I'll write the test after confirming the fix" | The failing test *is* the confirmation. |
| "Multiple fixes at once saves time" | You can't isolate what worked, and you cause new bugs. |
| "I see the problem, let me fix it" | Seeing a symptom is not understanding a cause. |

## When there is genuinely no root cause

If investigation shows the issue is truly environmental or timing-dependent: document what you investigated, implement appropriate handling (retry, timeout, clear error), and add logging for the future. But be honest — most "no root cause" conclusions are incomplete investigations.
