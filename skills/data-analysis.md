---
name: Data Analysis
description: Use when analyzing a dataset, reporting metrics, or drawing conclusions from numbers — spreadsheet, database, analytics export, or survey. Guards against the standard ways numbers mislead.
---

# Data Analysis

Numbers persuade, which is exactly why sloppy analysis is dangerous: a wrong number presented confidently travels further than a right one presented carefully. This is the method for not fooling others — or yourself.

## 1. Understand the data before computing anything

- **Shape**: how many rows, what does one row represent, what's the time range? Wrong row-grain (events vs. users vs. sessions) invalidates everything downstream.
- **Quality**: count nulls, duplicates, and obviously impossible values (negative ages, dates in the future) *first*. Decide explicitly how each is handled and say so in the write-up.
- **Provenance**: who collected this, how, and what's *missing* from it? Data absent from the set (churned users, failed requests that never logged) biases every aggregate over it — survivorship bias lives here.
- **Definitions**: pin down what each field actually measures. "Revenue" (booked? recognized?), "active user" (daily? monthly? ever?) — most cross-team disagreement about numbers is undetected definition mismatch.

## 2. Sanity-check every aggregate

- Reconcile totals against a known reference before trusting breakdowns.
- Check a few raw rows behind any surprising number — surprises are usually bugs in the query, not discoveries.
- Recompute one number a second, independent way. Two paths agreeing is cheap insurance; disagreeing is a finding.
- Watch units and time zones; grouped-by-day data spanning time zones is a classic silent error.

## 3. Choose honest statistics

- **Mean vs. median**: skewed distributions (income, latency, deal size — most business data) need the median or percentiles; the mean of a skewed distribution describes nobody. Report the spread, not just the center.
- **Rates need denominators**: "40 conversions" means nothing without visitors; "up 50%" means nothing without the base ("from 2 to 3" is also up 50%).
- **Small samples prove little**: differences between small groups are usually noise. Before comparing, ask whether the sample could plausibly produce the difference by chance.
- **Correlation is not causation**: two lines moving together have at least four explanations — A causes B, B causes A, C causes both, or coincidence. Say which you can support, and how (experiment, natural experiment, mechanism) — otherwise report the correlation as a correlation.
- **Beware selection in comparisons**: cohorts that self-selected (upgraded users vs. free) differ in more ways than the one you're measuring.

## 4. Present without distortion

- Bar charts start at zero; a truncated axis manufactures drama. Line charts may zoom, but say so.
- Don't cherry-pick the date range that flatters the story — show the fuller range or justify the window.
- Label axes and units; annotate anomalies (the outage, the pricing change) directly on the chart rather than leaving readers to invent explanations.
- One chart, one message. If it needs a paragraph to decode, split it.
- Show uncertainty where it matters: ranges or confidence bands, not false-precision point estimates ("about 12k", not "12,047" when the measurement can't support it).

## 5. Report findings honestly

Structure: **answer first** (with confidence), then evidence, then caveats — data limitations, assumptions, and what would change the conclusion. Keep the computation reproducible: state the source, the filters, and the queries or steps, so someone can re-derive the number. A metric nobody can reproduce is a rumor.

The two failure modes to actively resist: **narrative fitting** (choosing the cut of the data that supports the story you already had) and **silent cleaning** (dropping inconvenient rows without disclosure). If the data doesn't support a clean conclusion, the honest finding is "inconclusive, and here's what data would settle it."
