---
name: Skill Creator
description: Use when creating a new skill or improving an existing one — capturing a working procedure, a service integration, or team know-how as a reusable skill others can load.
source_url: https://github.com/anthropics/skills/blob/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/skill-creator/SKILL.md
---

# Skill Creator

A skill is reusable know-how: a procedure written once and reached for whenever it's relevant. Good skills compound a team's ability; bad ones clutter the manifest and mislead. This skill is how to write good ones.

## When to capture a skill

- You just got a tricky integration or workflow working and teammates will need it.
- You made the same correction or explained the same procedure twice — the third time should be a skill.
- A retrospective surfaced a reusable technique.

Don't capture one-off trivia, project-internal state that belongs in a project document, or anything already covered by an existing skill — check the manifest first, and prefer updating an existing skill over creating a near-duplicate.

## Anatomy of a skill

Each skill is a **single self-contained markdown document** with a name, a short description, and the body. There are no bundled files — everything the reader needs must be in the document itself (or explicitly fetchable from a stable URL it cites).

**The description is the triggering mechanism.** Every agent sees only the name + description in its manifest and decides from that whether to load the full body. So the description must say both *what the skill does* and *when to reach for it* — concretely: "Use when connecting to X / asked to Y / encountering Z." Skills tend to be under-used rather than over-used, so make descriptions a little pushy about their triggers. Keep them to one or two sentences; they're loaded into every run.

**The body** is the full procedure. Aim for focused — a few hundred lines at most:

- Prefer imperative form ("Run X, then check Y").
- Explain *why* a step matters instead of stacking heavy-handed MUSTs — a reader who understands the reason applies the rule correctly in cases you didn't anticipate.
- Include concrete examples (input → output) for anything format-shaped.
- Include exact commands, endpoints, and field names for anything integration-shaped — and note the version/date they were verified.
- Make it general: capture the pattern, not just the one case you solved today.

## Creating it

1. **Extract from the working session.** The best source is the conversation where the procedure actually worked: the tools used, the order, the corrections along the way, the dead ends worth warning about.
2. **Draft the body first, then the description.** Writing the description last keeps it honest about what the body delivers.
3. **Choose scope.** Global if any project could use it (a general technique, a widely-used service); project-scoped if it encodes one project's conventions or infrastructure. When a global skill needs project-specific additions, layer a separate project skill that references it rather than forking the global one.
4. **Create it** with the `create_skill` tool — or `propose_skill` when human review is warranted before it goes live (a skill encoding a security-relevant or costly procedure deserves review).
5. **Test it by using it.** Next time the situation comes up, load the skill and follow it literally. Every place you had to deviate is an edit the skill needs.

## Improving skills

Skills are living documents. When you follow one and find a step outdated, an example broken, or a gap — update it then and there (edits are versioned and reversible). If you learned something significant about a connected service, fold it into that service's skill so the next teammate doesn't rediscover it.

## Quality bar

Before saving, check:

- Would someone with no context on today's task be able to follow this?
- Does the description alone tell an agent when to load it?
- Is everything self-contained — no references to files or state that only existed in your session?
- Is it distinct from every existing skill in the manifest?
- No secrets or credentials in the body — reference credentials by their placeholder or the tool that requests them, never by value.
