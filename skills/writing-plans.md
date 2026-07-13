---
name: Writing Plans
description: Use when you have a spec or requirements for a multi-step piece of work, before starting execution. Produces a plan a colleague with zero context could execute correctly.
source_url: https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/writing-plans/SKILL.md
---

# Writing Plans

Write implementation plans assuming the executor is skilled but has **zero context** for this project. Document everything they need: what to change and where, how to verify each step, what "done" looks like. Post the plan where the work is tracked — as a comment on the task, or as a project document linked from it — so reviewers and future runs can see it.

## Scope check

If the work spans multiple independent pieces, split it into separate plans — one per piece, each producing a working, verifiable result on its own. Use sub-tasks to track them.

## Structure first

Before defining steps, map out what will be created or changed and what each piece is responsible for. Give each unit one clear responsibility and a well-defined boundary. In an existing project, follow its established patterns — don't restructure unilaterally.

## Right-sizing tasks

A task is the smallest unit that carries its own verification and is worth a fresh reviewer's attention. Fold setup and scaffolding into the task whose deliverable needs them; split only where a reviewer could meaningfully reject one part while approving its neighbor. Each task ends with an independently checkable deliverable.

Within a task, keep steps bite-sized — one action each: "write the failing test", "run it and confirm it fails", "implement the minimal change", "run it and confirm it passes", "commit".

## Plan header

Start every plan with:

- **Goal** — one sentence describing what this builds or changes.
- **Approach** — two or three sentences on the architecture or method.
- **Constraints** — the spec's project-wide requirements (versions, naming rules, platform requirements), one line each, copied exactly from the source. Every task implicitly inherits these.

## Task structure

For each task, specify:

- **Files/artifacts** — exact paths to create or modify (`src/exact/path.py:123-145`, `campaign/email-2.md`), and where its verification lives.
- **Interfaces** — what this task consumes from earlier tasks and what later tasks rely on (exact names, signatures, formats). The executor of one task may never read the others; this block is how the names line up.
- **Steps** — each with the actual content: real code or copy in the step, the exact command to run, and its expected output.

## No placeholders

These are plan failures — never write them:

- "TBD", "TODO", "fill in details", "implement later"
- "Add appropriate error handling" / "handle edge cases" (show the handling)
- "Write tests for the above" without the actual test
- "Similar to Task 2" (repeat the content — tasks may be read out of order)
- Steps that describe *what* without showing *how*
- References to names or types not defined in any task

## Self-review

After writing the plan, check it against the spec with fresh eyes:

1. **Coverage** — for each requirement in the spec, point to the task that implements it. List gaps.
2. **Placeholder scan** — search for the patterns above; fix them.
3. **Consistency** — do names, signatures, and formats used in later tasks match the ones defined earlier? A function named `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a plan bug.

Fix issues inline and move on. If a requirement has no task, add the task.

## Remember

- Exact paths, always.
- Complete content in every step — if a step changes something, show the change.
- Exact commands with expected output.
- Don't gold-plate: build only what the spec requires.
