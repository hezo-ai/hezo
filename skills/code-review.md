---
name: Code Review
description: Use when requesting a review of finished work, reviewing someone else's changes, or responding to review feedback. Covers all three sides — asking well, reviewing rigorously, and receiving feedback with technical honesty.
source_url: https://github.com/obra/superpowers/tree/d884ae04edebef577e82ff7c4e143debd0bbec99/skills
---

# Code Review

Review early, review often — issues caught at review time are the cheapest they will ever be. This skill covers requesting a review, performing one, and receiving one.

## Requesting review

Give the reviewer precisely the context they need to evaluate the work product — not your whole thought process.

1. **State what you built and against what requirement.** A brief description plus a link to the spec, plan, or task that defines "correct".
2. **Point at the exact change.** The branch, commit range, or PR — reviewers should never guess what's in scope.
3. **Say what you're least sure about.** Directing attention to the risky part is honesty, not weakness.

Request review when a task's implementation is complete (@-mentioning the reviewer is the request), after completing a major piece mid-task, and any time you're stuck and need fresh eyes.

**Act on the result:** fix critical issues immediately, fix important ones before proceeding, note minor ones. If the reviewer is wrong, push back with technical reasoning — don't silently comply, don't silently ignore.

## Performing review

Order your attention by severity — a beautifully named variable in a function that corrupts data is not a good review outcome:

1. **Correctness** — does it actually solve the stated problem? Walk the requirement line by line against the change. Verify claims against the code itself, not the description of it.
2. **Security** — input validation, injection, secrets in code or logs, authorization on every path.
3. **Tests** — does new behavior have tests that would fail if the behavior broke? Were they observed failing?
4. **Performance** — obvious bottlenecks, N+1 queries, unbounded growth.
5. **Readability** — clear naming, focused functions, minimal complexity. Last, not first.

Write actionable comments: state the problem, why it matters, and what better looks like. Distinguish "must fix" from "consider" from "nit" explicitly. Review the code in front of you, not the code you would have written.

## Receiving review

Code review requires technical evaluation, not emotional performance.

**The pattern:** read all feedback without reacting → restate anything unclear (or ask) → verify each point against the actual code → evaluate whether it's right *for this project* → respond technically → implement one item at a time, testing each.

**Never respond with performative agreement** — "You're absolutely right!", "Great point!" — and never implement before verifying. Instead: restate the requirement, ask the clarifying question, push back with reasoning, or just fix it and say what changed.

- **Unclear feedback?** Stop. Ask about *all* unclear items before implementing any of them — items are often related, and partial understanding produces wrong implementations.
- **Feedback seems wrong?** Check whether it breaks existing behavior, whether the reviewer has the full context, whether the "proper" version is needed at all. Push back with specifics: "Checked — this endpoint has no callers; remove it instead?"
- **Feedback is right?** "Fixed — [what changed]." The code shows you heard it; gratitude theater doesn't.
- **You pushed back and were wrong?** "You were right — verified X does Y. Fixing." State it factually and move on; no extended apology.

**Implementation order for multi-item feedback:** clarify everything first, then blocking issues → simple fixes → complex fixes, testing each individually.

## Red flags

- Skipping review because the change is "simple"
- Approving without having read the diff against the requirement
- "You're absolutely right!" followed by unverified implementation
- Arguing tone instead of technical substance — in either direction
- Marking a task Done while an agreed-upon approval is still missing
