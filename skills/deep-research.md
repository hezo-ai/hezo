---
name: Deep Research
description: Use for any non-trivial research question — market or competitive analysis, technology evaluation, due diligence, background investigation. A method for multi-source research with adversarial verification and cited synthesis.
---

# Deep Research

A method for answering questions where being wrong is expensive: multiple independent sources, claims verified before they're repeated, and a synthesis that separates what's established from what's inferred.

## 1. Decompose the question

Break the question into the sub-questions that actually decide it. "Should we adopt X?" decomposes into maturity, cost, alternatives, failure stories, trajectory. Write the sub-questions down first — they are the checklist for knowing when you're done, and each becomes a search angle.

If the question is underspecified (missing budget, region, use case, time horizon), resolve that with the requester *before* researching — an answer to the wrong question is waste.

## 2. Search from multiple angles

For each sub-question, search several distinct ways, not one query paraphrased:

- **Direct** — the obvious query.
- **Adversarial** — search for the counter-claim ("X problems", "X alternatives", "why we left X"). If you only search for support, you'll find it.
- **Primary-source** — official docs, filings, changelogs, papers, source code, the actual announcement.
- **Practitioner** — postmortems, issue trackers, forum threads from people who've actually used or done the thing.
- **Recent** — constrain by date to catch changes; note *when* each source was written.

Track what each angle surfaced. A conclusion supported by only one angle is a lead, not a finding.

## 3. Grade sources

- **Primary** (the artifact itself: spec, filing, code, announcement) — strongest.
- **Secondary reporting** — useful, but find what it cites; report the underlying fact from the primary source where possible.
- **Aggregators, SEO content, forums** — leads to verify elsewhere, never citations on their own.
- Note each source's incentive: a vendor's comparison page and an independent benchmark are different classes of evidence for the same claim.

## 4. Verify claims adversarially

For every claim that will carry weight in the conclusion:

- Find **at least two independent sources** — independent meaning not citing each other or a common origin. Ten articles echoing one press release count as one source.
- **Try to refute it.** Search for the strongest counter-evidence and see if the claim survives. A claim you couldn't attack is unverified, not confirmed.
- Check freshness: is this still true, or true as of three years ago?
- Numbers deserve special suspicion — trace them to origin and check the definition (revenue vs. bookings, users vs. accounts).

Kill claims that fail verification — including the interesting ones. Especially the interesting ones.

## 5. Synthesize honestly

Structure the write-up as:

1. **Answer** — the conclusion up front, with its confidence level.
2. **Key findings** — each with its evidence and citations, ordered by importance to the conclusion.
3. **Uncertainties** — what's unknown, contested, or resting on a single source; what evidence would settle it.
4. **Sources** — every load-bearing claim cited so a reader can check it. State access dates for anything volatile.

Rules of honesty: distinguish **fact** (verified, cited) from **inference** (yours — say so) from **speculation** (label it or cut it). Report the confidence you actually have — "likely, based on two independent reports" beats false certainty. If the research changed your view partway through, the write-up reflects the end state, not the journey. If the honest answer is "it depends" or "unknown", say that and say what it depends on.

## When to stop

Stop when new sources are only repeating what you already have (saturation), when every sub-question from step 1 has either an answer or a documented dead end — not when you run out of patience. If forced to stop early, mark which sub-questions remain open rather than papering over them.
