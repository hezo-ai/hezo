---
name: Skill Creator
description: Use when creating a new skill, improving an existing one, or reviewing one for quality - capturing a procedure, integration or team know-how others can load. Also use when agents keep using a service, API or codebase the wrong way.
source_url: https://github.com/anthropics/skills/blob/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/skill-creator/SKILL.md
---

# Skill Creator

A skill is reusable know-how: a procedure written once and reached for whenever it is relevant. Good skills compound a team's ability; bad ones clutter the manifest and mislead.

Write for a new hire who cannot ask you a single question. A skill is not a reference for someone who will check back. It is a specification someone acts on immediately.

## When to capture a skill

- You just got a tricky integration or workflow working and teammates will need it.
- You made the same correction or explained the same procedure twice. The third time is a skill.
- A retrospective surfaced a reusable technique.

Never capture one-off trivia, project state that belongs in a project document, or anything an existing skill already covers. Check the manifest first, and update a near-duplicate rather than creating one.

## Anatomy of a skill

Each skill is a single self-contained markdown document with a name, a short description, and the body. Nothing is bundled alongside it, so everything the reader needs lives in the document or at a stable URL it cites.

**The description is the triggering mechanism.** Every agent sees only the name and description, then decides from that whether to load the body. Say both what the skill does and when to reach for it: "Use when connecting to X / asked to Y / encountering Z."

**Make the description pushy about its triggers.** Skills are under-used far more often than over-used. Name the artifacts, the tasks and the symptoms that should pull the skill in, and put the main case first.

**Keep the body focused.** Aim for a few hundred lines at most.

## Structure and order

**Page order is priority order.** An agent that stops reading after the first section still lands on the right default. Position is a strong signal; a label like "recommended" is a weak one.

**Put the happy path first.** Open with the one command or call that covers most cases. Manual flows, advanced configuration and edge cases go below it.

**Carry the quickstart to a finished result.** A three-step flow that hides an authentication challenge at step three is worse than no quickstart. The reader commits to the path before meeting the step you left out.

**Make every human-gated prerequisite step 1, with the URL inline.** Terms acceptance, account funding, an owner granting access. An agent that meets one at the end has already acted on the human's behalf.

## Writing the rules

**Give every rule its consequence.** A rule with no reason gets argued with or quietly bypassed. "Fees are 10% of the price, minimum $0.005" is a fact. "So a $0.01 call pays 50%" is a rule an agent can reason with.

**Name each anti-pattern with the way it fails.** Agents reach for the most generic primitive they recognise. "Use the SDK" loses to that instinct. "The generic client issues one call, and this endpoint needs two" beats it.

**Pair every prohibition with its replacement, in the same sentence.** A bare prohibition leaves a gap the agent fills with something. Write "never hand the user raw CLI commands; give them the dashboard URL instead".

**Name the path you are rejecting.** Agents arrive with priors from training data. An agent told to use your client still reaches for the library it has seen ten thousand times. Name that library, reject it, and give the reason.

**State each rule exactly once, as precisely as you can.** Two near-identical sentences read as two different rules, and the agent stops to work out the difference.

## Precision

**Mark each field required, recommended or optional.** A binary split throws away the most useful signal you have: the optional field that almost every real use needs.

**End every error row with a verb.** Not "402: payment required" but "402: complete the payment challenge, then retry with the Authorization header". Say what to do when that action also fails.

**State escalation points as thresholds.** "Use judgement" and "if appropriate" instruct nobody. "Wait for a repeated pattern; a single transient error is not grounds for dropping one" does.

**Write down the rejections the server already enforces.** Reserved names, rate limits, immutable fields, format rules. State the rule and the rejection together, so nobody spends a cycle discovering it.

**Keep every identifier consistent everywhere it appears.** Rename a slug format or a parameter in the request path, the update path, the examples and the prose together. A half-finished rename leaves the document contradicting itself.

**Reserve blockquotes for hazards.** Use them only for facts that cause silent failure when skipped. Blockquote everything and you have blockquoted nothing.

## When the skill tells agents to write code

**Treat every code block as a contract.** An agent runs what you wrote and fails confidently when it does not work. A function that does not exist, or a renamed parameter, produces hours of plausible wrong output.

**Show persistence as code, not prose.** "Persist this" survives one read; a copy-pasteable block survives the project. Follow the block with the failure it prevents.

**Paste exact strings verbatim.** Format strings, header names, full enum values. Correct in spirit and wrong in the exact string is the failure an agent cannot debug from first principles.

## Creating it

1. **Extract from the working session.** The best source is the conversation where the procedure worked: the tools used, the order, the corrections, the dead ends worth warning about.
2. **Draft the body first, then the description.** Writing the description last keeps it honest about what the body delivers.
3. **Choose scope.** Global when any project could use it; project-scoped when it encodes one project's conventions. When a global skill needs project-specific additions, layer a separate project skill that references it.
4. **Steer toward better patterns where mandating them would be wrong.** Framing alone improves average output, and nothing is enforced.
5. **Note the date you verified any command, endpoint or field name**, so the next reader knows how stale it may be.

## Testing it

**Hand the skill to a fresh agent and watch what it does.** Give it a clean context, a real task, and this skill alone. Watch where it stalls, backtracks or invents. What it reports about the skill always sounds fine.

**Try more than one model.** Models differ in their priors and their instruction-following. Where you can afford one run, pick the model with the strongest competing prior about a neighbouring library.

**Hunt for confident-wrong output.** An agent that errors or asks a question is the easy case. The dangerous one proceeds down a wrong path and reports success. Check three causes first: a missing consequence, an unnamed anti-pattern, a stale example.

## Improving skills

Skills are living documents. When you follow one and find a step outdated, an example broken, or a gap, update it then and there.

**Turn every agent failure into a change.** Either the skill changes or the code does. An agent inventing a function that does not exist is a skill edit pointing at the real one.

**Prefer the skill fix to a new guardrail.** Rejecting harder at the API layer is tempting. Do that where safety demands it. Otherwise the skill fix is cheaper, and it reaches every agent that loads the skill.

## Quality bar

Before saving, check:

- Would someone with no context on today's task be able to follow this?
- Does the description alone tell an agent when to load it?
- Does the first section hold the preferred option, and the quickstart reach a finished result?
- Is every human-gated prerequisite step 1?
- Does every rule state its consequence?
- Is each anti-pattern named with the way it fails?
- Does every prohibition carry its replacement?
- Are the tempting wrong paths named and rejected?
- Is each rule stated exactly once?
- Does every error row end in a verb, and every field say whether it is recommended?
- Does every code block run against the current API, with exact strings verbatim?
- Does every identifier match everywhere it appears?
- Is everything self-contained, with nothing referencing files or state that only existed in your session?
- Is it distinct from every existing skill in the manifest?
- Has a fresh agent been watched attempting a real task with this skill alone?
- No secrets or credentials in the body - reference credentials by their placeholder or the tool that requests them, never by value.
