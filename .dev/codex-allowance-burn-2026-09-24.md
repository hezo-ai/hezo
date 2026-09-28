# Why production ran out of its Codex allowance again on 24 September

A point-in-time investigation of the production instance, run on 2026-09-25 by six investigators and four adversarial reviewers. The ten evidence reports (A to F, R1 to R4, cited below by letter) are not in the repository. Code references are at the deployed release, tag `0.68.2`. All times are UTC. The previous burn (20-21 September) was diagnosed on 2026-09-22 and led to #1136.

## Short answer

The limits shipped on 23 September all worked as coded. None of them limits the thing that runs out, which is the weekly allowance. On 24 September the operator had reset the provider's week by hand, then pressed Retry on a refused run, the run was served, and its success lifted the hold for the whole credential. Over the next 15 hours about 61 tasks spent the new allowance, 287.4M input tokens in total, and no single run, task or agent came near its own limit except one. The allowance also bought far fewer tokens than before. The Codex version shipped on 23 September silently switched most runs to a costlier model, and the allowance itself has been shrinking for three weeks. Fleet demand now runs at 5 to 14 times what one week's allowance can supply spread over seven days. Until Hezo paces spending against the allowance itself, every week will run out within about a day of running.

## What happened

- The earlier hold worked. No run started from 21 Sept 15:12 to 24 Sept 02:42, across both upgrade restarts.
- 02:36-02:41: the admin posted six replies. Their wake-ups were held.
- 02:42:07: the admin pressed Retry on run 5c71da7a (HM-358), which the provider had refused on 21 Sept. A person's Retry or Run now skips the hold (`agent-runner.ts:1652`). The provider served it, four days before its own stated reset, because the operator had just reset the week by hand. The next refusal gives "try again at Oct 1st, 2026 2:42 AM", exactly seven days after this request. The resets on 12, 13 and 21 Sept were manual too.
- 02:45:24: the run succeeded, and success lifts the hold for the whole credential (`agent-runner.ts:3493-3499`, `provider-credential-health.ts:163-167`). The 23 held wake-ups were released 30 s apart, as the 23 Sept change intended.
- Burst 1, 02:42-04:07: the backlog, the admin's first comments and a second Retry (HM-793). 105 runs, 120.7M.
- 04:07-04:31: no run started, because all remaining work was waiting on the admin.
- Burst 2, 04:31-06:45: the admin answered 10 inbox items in 12 minutes. Two were token-ceiling holds and three were agents flagging cost. 90 runs, 94.6M, all on the new model.
- 06:45-15:02: no agent was due. Every agent had run within its 12-hour heartbeat interval.
- Burst 3, 15:02-17:50: the 12-hour heartbeat echo of the morning. The equity analyst's heartbeat resumed INV-331, 12 hours after the per-run limit had stopped it, and three runs spent 71.7M.
- 17:48:47: first refusal. 17:50:03-17:50:12: the new hold to 1 Oct 02:43 was written.

Totals: 201 runs, 175 with tokens, 287.4M input (93.7% cache reads), 0.91M output, 61 tasks. 80-81% of tokens ran on work that agents started for each other. 38% moved between tasks.

## Why the 23 September limits did not stop it

| Limit | What happened on 24 Sept |
|---|---|
| 30M tokens per run (`agent-runner.ts:265`) | Fired once (INV-331, killed at 31.5M). Nothing held the task, so the heartbeat resumed it 12 h later for 71.7M more. |
| 100M tokens per task since a person spoke (`no-work-backoff.ts:829`) | Fired on 4 tasks. HM-102's 157.8M was all spent before the update, because the count has no time floor. The admin's replies ("what's status?", "@marketing-lead continue", "one consolidated correction and then no more") each granted a fresh 100M. INV-331 was held at 103.6M, 76 s before the provider refused. Only one task passed 100M. The other 60 spent 64%. |
| 8 agent-to-agent rounds per task | Never fired. Longest chain was 7. Work moved across tasks through assignments, tasks agents created for themselves, Coach reviews and follow-up timers, which the count does not see. |
| Token budgets | 12 agents (11 active) are unlimited, and they spent 89.8%. The budgets that exist are monthly, and each is 43-64% of this week's whole allowance. Budget weeks are UTC calendar weeks, not the provider's week. |
| Spaced release of held work | Worked as designed. It only paces the backlog. |
| Anything instance-wide | Only container memory (3 concurrent runs). Nothing reads the allowance or the instance's spending rate. |

Codex writes the percent of the weekly allowance used and the reset time into every token-count record (`rate_limits.primary/secondary.used_percent`, `resets_at`, confirmed in Codex 0.156.0 source, `protocol.rs:2337-2395`; persisted to the session file). Hezo reads that file every 60 s during a run and keeps only the token totals (`agent-stream-parser.ts:2230-2260`).

## Why the allowance bought so few tokens

1. The Codex version changed the model. Release 0.68.2 raised Codex from 0.149.0 to 0.156.0 (`docker/Dockerfile.agent-base:58`). Codex 0.153.4 release note: Astra became "the bundled default when no model is explicitly configured". Hezo configures none (no `--model`, no `model =` in config, credential default empty). The container pool never recycles on image change (`sandbox/pool.ts:145`), so old containers kept gpt-5.6-sol and every new one ran gpt-6-astra: 132 of 175 runs. On the published Codex rate card (read from third-party copies, unverified) Astra costs 2x per input token and 1.67x per output token, and it missed the cache about twice as often. It was 45% of tokens and about 68% of the allowance used. Estimated extra cost: about 21% of a week's allowance. The same update mapped "max" reasoning to "xhigh" for captains and the CEO; no extra tokens were measurable.
2. The allowance itself keeps shrinking. Windows in early September served 1.7-2.1B input tokens, mid-September 663-842M, this one 287M. In old-model pricing that is roughly a 4.5x fall since early September, most of it before any change of ours. Any fixed token threshold goes stale within a release.
3. Demand far exceeds supply. The median full running day since 27 Aug used 568M input tokens. This week's allowance spread over seven days is 41M a day, so demand is about 14 times supply (about 5 times against mid-September windows).
4. Nothing outside Hezo used the account (confirmed by the operator), so every token the provider counted was Hezo's. The gap between this week and the earlier ones is the model price plus the shrinking allowance, not a hidden consumer.
5. Possible under-count, unverified: an open Codex issue (openai/codex#47003) says automatic context-compaction requests are left out of the token totals. If so, every Hezo count and limit under-states use.

## The pattern behind three rounds of fixes

- Each fix limited the shape of the last incident: attempts and tool calls (12 Sept), a hold after a refusal (17 Sept), rounds, comment size, run and task tokens (23 Sept). None limited the resource that ran out. The allowance reaches Hezo only as a refusal, at 100%.
- Thresholds were sized against the last window, while the allowance kept shrinking and a version bump changed the price per token.
- Fixes were scored by tokens removed from the burn day. With demand at 5-14 times supply, removing one shape moves exhaustion by hours.
- The agents generate their own work. Bounding one path moved the work to another: rounds on one task became chains across tasks, and comments became project files.
- A person's action restarts everything, and the product invites it. The usage-limit notice says "To try sooner ... press Run now on a waiting task" (`orphan-detector.ts:634`). Retry skips the hold and its success lifts it for everyone. Every reply to a ceiling notice grants a fresh 100M. No view anywhere shows what the week has already spent.

## Fixes, ranked by whether they would have saved the week

1. Pace each credential's spending inside the provider's week, using Codex's own percent-used and reset time. For example: allow k/7 of the week by day k, with headroom for runs in flight (3 concurrent runs at the 30M run limit can overshoot by 90M). Replayed on 24 Sept, the first hold comes at 03:24 with about 43-52M spent, 18% of the week. It is the only fix in any report that would have prevented exhaustion. First step: read and log the field for one run to confirm it is in the session file on the box.
2. Pin the model explicitly, recycle containers when the image changes, record the CLI version per run, and treat a CLI bump as a cost change. About 21% of a week. The pin can be set today in the AI provider settings (default model field) with no code change.
3. Show the week's spend and burn rate wherever a person can release work: Retry, Run now, inbox replies, ceiling notices. Remove the notice text that invites Run now. Offer no Retry button on a usage-limit failure (the Retry pressed on 24 Sept existed only because that refusal was marked failed, `agent-runner.ts:3361-3369`). Bursts 1 and 2, 215M, were each released by a person who could not see the spend.
4. Cut demand. None of these saves a week alone; together they decide how much useful work a paced week buys.
   - Hold a task after the per-run limit stops it, until a person replies, and keep heartbeats out of it: 71.7M (25%). A held task gives way to the agent's next task, so this is an upper bound.
   - Stagger heartbeats after a burst. The 12-hour echo produced burst 3.
   - Give large text files as a download link rather than paging them into context, and add a name filter to the file list: 614 reads of files over 256 KB in 8 runs holding 86M; estimated 40-80M.
   - Investments "refresh everything" work took 21-25% of all September input and 40% of 24 Sept. Refresh on material events only.
   - Enforce the Coach's 20-rule cap in code and prune the Investments roles now. The equity analyst's prompt is 62 KB, 74% learned rules, 77 rules, unchanged since 21 Sept, because the Coach runs only when a task finishes and Investments tasks do not finish.
   - Remove the rules that drive re-verification (risk verifier: "a price that has moved 10%+ must be flagged", "append newly discovered checks without replacing earlier ones").
   - Bound helper sub-agents: 36-38M in 10-12 runs. Shared instructions tell agents to fan out.
   - Task ceiling: add a time floor, stop any admin comment resetting it, look ahead by one run.
   - Stop filing coherence reviews when the Coach edits only learned rules: 13.5M.
5. Correctness fixes, near zero tokens on 24 Sept: record the hold on every usage-limit refusal, never lift the hold on a refused run, fix the "never got a turn" text when tokens were used, record the creating run on follow-up timers and coherence tasks and keep the first creator on merge. Side finding: the completeness judge never runs for subscription Codex runs, because it needs an API key that a subscription never sets.

Not recommended: letting a Retry answer only for its own run (it only delays the same burn four days inside the same week); a wider handoff rule (0.6M); one run at a time per credential (saves nothing, the day's 10.2 h of run time still fits); a 10M run limit (the killed 31.5M run was redone for 71.7M).

## Before 1 October 02:43

The hold then lapses, one probe run goes out, and 9 held wake-ups are released onto 37 in-progress tasks. Nothing paces after that, so the next week will go the same way within about a day unless code changes first or the operator steps in. Levers that need no code: pin the model in the provider settings; set weekly budgets on the unlimited agents (a stopgap, and on UTC weeks); pause or close the Investments refresh tasks; avoid Retry and Run now on held work unless a full restart is intended.

## Claims overturned during the review

- The lead's own premise: the new hold did not start at 06:11, and the afternoon runs did not bypass a hold. 06:11 was a routine sign-in token refresh. The hold was written at 17:50.
- "Each Retry opens a new week": wrong. The operator reset each week by hand; the Retry was simply the first request after the reset.
- "About 37% of the allowance is missing from Hezo's count, hinting at another consumer": wrong. The operator confirmed no other client used the account.
- "Hidden sub-agent tokens 55.2M (19%)": 36-38M in 10-12 runs. One report read a line quoted inside a tool result as the run's own.
- "Held work was only 7% of the burn": true for the runs it started directly, but all non-person work after 02:42 depended on the lift.
- "Without INV-331 the week would have survived 24 Sept": not supported. Seven more wake-ups with work came due between 17:47 and 18:45.
- "Retry answering only for its own run would save 286.6M": it only delays the burn.
- "The no-hold-on-refusal-with-tokens gap delayed the hold 12 m 54 s": 46 s on 21 Sept and 85 s on 24 Sept; saves about nothing.
- "Only 4 wake-ups carried the old hold": 23 did. Claiming a wake-up wipes the fields.
- "The 06:45-15:02 idle gap is unexplained": the 12-hour heartbeat schedule explains it.
- "First refusal 17:47:46": that was the run's start. The refusal came at 17:48:47, after one served reply.
- "The Codex version check could not have seen the model change": it could; each request carries the model name. Nobody compared it.
- Smaller number corrections (admin comments 20, not 22; release claims took 22.5 min, not 11; allowance ratio 34%/38% with everything served) are in R1.

## Operator answers (2026-09-25)

1. The early resets on 12, 13, 21 and 24 Sept were applied by hand on the ChatGPT account.
2. No other Codex client, ChatGPT Work or Deep Research session used the account.
