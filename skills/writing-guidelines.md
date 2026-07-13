---
name: Writing Guidelines
description: Use when writing or reviewing any prose — docs, reports, announcements, marketing copy, task descriptions. Rules for clear, direct writing and a review workflow with per-line findings.
---

# Writing Guidelines

Rules for prose that respects the reader's time. Apply them when writing; when reviewing, report violations as `file:line — rule — suggested rewrite`.

## Lead with the point

- The first sentence answers the reader's actual question — what happened, what to do, what this is. Context and reasoning come after, for those who want them.
- One idea per paragraph; the first sentence of each paragraph carries it.
- Long documents get a summary up top that stands alone. Headings say what the section concludes, not just its topic ("Caching cut latency 40%", not "Performance").

## Write directly

- Active voice, doer first: "The team shipped the feature", not "The feature was shipped."
- Strong verbs over noun constructions: "decide", not "make a decision"; "use", not "utilize."
- Cut filler: "in order to" → "to"; "at this point in time" → "now"; "it is important to note that" → (delete).
- Cut hedges that carry no information: "basically", "essentially", "quite", "very", "somewhat". Keep hedges that do: "likely", "in our tests" are claims about certainty.
- Delete throat-clearing openers ("It's worth mentioning that…", "As you may know…") — start with the content.

## Be concrete

- Specific beats general: "reduces build time from 90s to 12s", not "significantly improves performance."
- Numbers get context: "3,000 requests/day (about 2/minute)" — a bare number makes the reader do the math.
- Claims get evidence or a source; opinions are labeled as such.
- Examples over abstractions: one worked example teaches more than a paragraph of theory.

## Match the audience

- Define terms the audience may not know on first use — or better, use the plainer word.
- No unexplained internal shorthand, codenames, or acronyms in anything leaving the team.
- Match register to purpose: an incident report is factual and unadorned; an announcement can carry energy; neither gets marketing superlatives in place of facts.
- Say "you" to the reader when giving instructions; imperative mood for steps ("Run the installer", not "The installer should be run").

## Structure and mechanics

- Sentence case for headings and UI text.
- Lists for parallel items — and keep them grammatically parallel; prose for reasoning. Don't fragment an argument into bullets that each need the others to make sense.
- Steps are numbered only when order matters; each step is one action with its expected result.
- Consistent terminology: one name per concept, used everywhere. Synonyms for variety confuse readers into seeing distinctions that don't exist.
- Links say where they go ("see the deployment guide"), never "click here."
- Read it aloud once: anywhere you stumble, the reader will too.

## Editing pass

Writing is rewriting. After drafting: delete the first paragraph if the second works as the opener (it often does), cut 10–20% by tightening, check every claim is either evidenced or clearly opinion, and verify names, numbers, and links against the source of truth.

## Review output format

```
docs/launch-post.md:3 — passive voice hides the actor — "We're launching X" not "X is being launched"
docs/launch-post.md:12 — unexplained acronym "CQRS" — define or remove
```

Group findings by severity (**blocks understanding / weakens the piece / polish**) and end with the single highest-leverage rewrite.
