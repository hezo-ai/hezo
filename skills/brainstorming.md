---
name: Brainstorming
description: Use before starting any creative or ambiguous work — a new feature, campaign, document, or design. Refines a rough idea into a validated design through questions, alternatives, and explicit approval before execution.
source_url: https://github.com/obra/superpowers/blob/d884ae04edebef577e82ff7c4e143debd0bbec99/skills/brainstorming/SKILL.md
---

# Brainstorming Ideas Into Designs

Turn a rough idea into a fully formed design through collaborative dialogue: understand the context, ask questions one at a time, explore alternatives, then present a design and get approval **before** any execution begins.

**Hard gate:** do not start building, writing final copy, or otherwise executing until a design has been presented and approved. This applies to every project regardless of perceived simplicity — "simple" projects are where unexamined assumptions waste the most work. The design can be three sentences; it still gets presented.

## The process

**1. Explore the context first.** Look at the current state — existing files, documents, prior tasks and their threads, recent changes. Understand what exists before proposing anything.

**2. Check the scope.** If the request describes multiple independent pieces ("build a platform with chat, billing, and analytics"), flag that immediately and help decompose it into sub-projects — don't spend questions refining details of something that needs splitting first. Each piece then gets its own design → plan → execution cycle.

**3. Ask clarifying questions — one at a time.** One question per message; if a topic needs more, break it into several. Prefer multiple-choice when possible (easier to answer), open-ended when needed. Focus on purpose, constraints, audience, and success criteria.

**4. Propose 2–3 approaches with trade-offs.** Lead with your recommendation and the reasoning. Never present only one option — the comparison is what surfaces hidden requirements.

**5. Present the design in sections.** Scale each section to its complexity — a few sentences when straightforward, a few paragraphs when nuanced. Ask after each section whether it looks right. Cover the essentials for the domain: for software — architecture, components, data flow, error handling, testing; for a campaign or document — audience, message, structure, channels, success measures.

**6. Write it down.** Once approved, record the validated design as a project document (or a comment on the task if small), so executors and reviewers work from the same spec.

**7. Self-review the written spec.** With fresh eyes: any placeholders or vague requirements? Sections that contradict each other? Requirements that could be read two ways? Scope creep? Fix inline.

**8. Get final sign-off.** Ask the requester to review the written spec before execution starts. Only proceed once approved — then move to planning (see the Writing Plans skill).

## Design principles

- **One question at a time** — don't overwhelm.
- **YAGNI ruthlessly** — remove unnecessary features from every design.
- **Small, well-bounded units** — break the system into pieces with one clear purpose each and well-defined interfaces. If you can't say what a unit does without reading its internals, the boundaries need work.
- **Follow existing patterns** in existing projects; include targeted improvements only where existing problems affect the work at hand.
- **Be ready to go back** — when an answer invalidates an assumption, revisit rather than patching over it.
