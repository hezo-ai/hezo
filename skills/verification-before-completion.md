---
name: Verification Before Completion
description: Use before claiming any work is complete, fixed, or passing — requires running the verification and reading the result before making any success claim. Evidence before assertions, always.
source_url: https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/verification-before-completion/SKILL.md
---

# Verification Before Completion

Claiming work is complete without verifying it is dishonesty, not efficiency.

**Core principle: evidence before claims, always.** If you haven't run the verification just now, you cannot claim it passes.

## The gate

Before claiming any status, expressing satisfaction, or handing work off:

1. **Identify** — what concrete check proves this claim? A command, a rendered page, a re-read of the deliverable against the original request.
2. **Run it** — fresh and complete, not a stale result from earlier.
3. **Read the output** — the full output. Check exit codes, count failures, look at the actual rendered result.
4. **Compare** — does the evidence confirm the claim? If no, state the actual status with the evidence. If yes, state the claim *with* the evidence.

Skipping any step is asserting, not verifying.

## What counts as evidence

| Claim | Requires | Not sufficient |
|-------|----------|----------------|
| Tests pass | Test run output: 0 failures | An earlier run, "should pass" |
| Bug fixed | Re-running the original symptom: gone | Code changed, fix assumed |
| Build succeeds | Build output: success | Linter passing, logs "look fine" |
| Document/report done | Line-by-line check against the request | "I covered everything" |
| Design/copy ready | Viewing the actual rendered result | The source "looks right" |
| Delegated work done | Inspecting the actual output/diff | The delegate's "success" report |
| Requirements met | A checklist walked item by item | Tests passing |

The same rule applies outside code: a research report is verified by re-checking its claims against sources; a marketing asset by viewing it at final size; a plan by walking each requirement of the brief.

## Red flags — stop and verify

- Using "should", "probably", "seems to"
- Expressing satisfaction ("Great!", "Done!") before verification
- About to move a task to Review or Done without fresh evidence in hand
- Trusting a sub-task's or collaborator's success report without inspecting the result
- Relying on a partial check ("the first half looked fine")
- Being tired and wanting the work to be over

## Common rationalizations

| Excuse | Reality |
|--------|---------|
| "It should work now" | Run the verification. |
| "I'm confident" | Confidence is not evidence. |
| "Just this once" | No exceptions. |
| "A partial check is enough" | Partial proves nothing about the rest. |
| "They said it succeeded" | Verify independently. |

## When to apply

Always, before:

- any success or completion claim, in any wording;
- moving a task to Review or Done;
- posting a handoff or final summary to the task thread;
- starting the next piece of work.

When you report completion on a task, include the evidence — the command you ran and its result, or what you checked and what you saw. A completion claim without evidence in the thread is unverified by definition.

**Bottom line:** run the check, read the output, then claim the result. Non-negotiable.
