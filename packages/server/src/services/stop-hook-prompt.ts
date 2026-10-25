/**
 * Quality-gate Stop hook injected into every agent run.
 *
 * Claude Code's Stop hook fires when the assistant decides to end its turn; a
 * block keeps the run looping (even in headless `-p` mode) so the gate forces
 * the agent to keep working until its own judgment agrees the task is genuinely
 * complete. Codex's and Kimi Code's `Stop` hooks share this block-and-loop
 * shape. Every runtime's judge is a small Node script Hezo writes beside the
 * hook config (`buildJudgeScriptForRuntime`), sending the fixed rules first and
 * then the agent's final message alone, so the rules are a prefix every check
 * shares and a provider's cache can serve. Claude Code's own `type: "prompt"`
 * hook is not used: it sends a slice of the conversation that starts somewhere
 * different on every check, so almost none of a long session's checks reads
 * from cache. The Claude Code and Codex scripts ask the CLI itself, in a
 * session of its own, so the judge works on whatever credential the run signed
 * in with, a subscription included.
 *
 * The judge runs inside the container against the team's existing
 * provider credential. No server-side LLM client. The hook is on for every
 * runtime whose turn-end hook can block-and-continue in headless mode. OpenCode
 * and Grok cannot (their hooks do not fire, or only warn, in headless mode), and
 * Antigravity's can from agy 1.2 but is not wired, so those three runtimes run
 * with no completeness judge.
 * The judge model is chosen per provider so the call resolves against the
 * team's own upstream: CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER for the Claude Code
 * runtimes, the run's own model for Codex. If a judge is genuinely unreachable
 * (no key for its API, or an upstream outage) the script fails open - exits 0
 * with no output, which the runtimes treat as "allow" - and the agent stops
 * normally.
 */

import {
	AgentRuntime,
	AiProvider,
	claudeCodeModelArg,
	claudeCodeProviderUsesCustomEndpoint,
	KIMI_DEFAULT_MODEL,
} from '@hezo/shared';
import { DOC_WRITE_GUARD_MATCHER } from './doc-write-guard';
import { CODEX_FEATURES_OFF } from './runtime-adapters/codex-features';

export const STOP_HOOK_JUDGE_MODEL_ANTHROPIC = 'claude-sonnet-4-6';
export const STOP_HOOK_JUDGE_MODEL_DEEPSEEK = 'deepseek-v4-pro';
export const STOP_HOOK_JUDGE_MODEL_ZAI = 'GLM-4.7';
// Shared by both ways of running Kimi. On the Claude Code runtime (against
// Moonshot's Anthropic-compatible endpoint) the Claude Code judge falls back to
// it; on Moonshot's own CLI the judge script calls their OpenAI-compatible
// endpoint with it.
export const STOP_HOOK_JUDGE_MODEL_KIMI = KIMI_DEFAULT_MODEL;

/**
 * Judge model for a Claude Code run, keyed by provider. The judge's own Claude
 * Code session makes the call against the run's own upstream,
 * so the model MUST be one that provider's endpoint actually serves. Using the
 * Anthropic id on DeepSeek/Z.ai 404s, so the hook fails open and never blocks —
 * the bug this map fixes. Values mirror each provider's
 * ANTHROPIC_DEFAULT_SONNET_MODEL in PROVIDER_RUNTIME_ADAPTERS; only Claude
 * Code-runtime providers ever reach here.
 */
export const CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER: Partial<Record<AiProvider, string>> = {
	[AiProvider.Anthropic]: STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
	[AiProvider.DeepSeek]: STOP_HOOK_JUDGE_MODEL_DEEPSEEK,
	[AiProvider.ZAi]: STOP_HOOK_JUDGE_MODEL_ZAI,
	[AiProvider.Kimi]: STOP_HOOK_JUDGE_MODEL_KIMI,
};

/**
 * Resolve the Stop-hook judge model for a Claude Code run.
 *
 * For the third-party Anthropic-compatible providers (DeepSeek/Z.ai/Kimi) the
 * judge call hits the provider's own upstream, so the model MUST be one that
 * endpoint serves — and the run's own selected model is guaranteed to be. So
 * when the run pins an explicit model we judge with THAT model: a provider
 * upgrade (e.g. Kimi `kimi-k2.7-code` → `k3`) or a retired pinned id then needs
 * no code change, whereas the hardcoded constant would 404 and fail the hook
 * open. The constant (mirrored from each provider's `ANTHROPIC_DEFAULT_*_MODEL`)
 * remains the fallback for a run with no explicit model — Claude Code uses the
 * staticEnv tier default there, and that same id is the safe judge.
 *
 * Anthropic is intentionally NOT derived: its judge is a stable, cheaper Sonnet
 * that must not scale with the run's model (an Opus run should not judge with
 * Opus), so it always uses the constant. `claudeCodeProviderUsesCustomEndpoint`
 * encodes exactly that split.
 *
 * The locally-hosted providers (Ollama, LM Studio) also derive from the run's
 * model, and for them it is the ONLY workable choice: the models an operator has
 * pulled are unknowable here, so there is no constant to fall back to. A local
 * run with no pinned model therefore falls through to the Anthropic id, which
 * the local server does not serve — the judge call fails and the hook fails
 * open, the same posture already accepted for OpenCode and Grok. Deriving from
 * the run model (the normal case, since agents are assigned one) keeps the judge
 * working without pinning ids we cannot know.
 */
export function judgeModelForProvider(
	provider: AiProvider,
	runModel?: string | null,
	/**
	 * The CLI the run actually uses. Only Claude Code reaches this helper, but a
	 * provider whose *default* is another CLI can be configured onto it, and its
	 * judge must then track the run model like any other custom-endpoint provider.
	 */
	runtime?: AgentRuntime | null,
): string {
	const fallback = CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER[provider] ?? STOP_HOOK_JUDGE_MODEL_ANTHROPIC;
	const trimmed = runModel?.trim();
	if (trimmed && claudeCodeProviderUsesCustomEndpoint(provider, runtime)) {
		return claudeCodeModelArg(provider, trimmed);
	}
	return fallback;
}

/**
 * The rule body the judge LLM evaluates against. The judge scripts send it,
 * with {@link STOP_HOOK_DECISION_FORMAT}, as the fixed part of every check, and
 * the assistant's final message after it.
 */
export const STOP_HOOK_RULES = `You are a quality gate. The agent is about to stop working on a Hezo task. Review its final message and decide whether the work is truly complete.

Block the stop if ANY of the following are true:
1. There are still failing tests that haven't been fixed.
2. The agent is claiming an issue is "out of scope" / "pre-existing" / "unrelated" to avoid fixing it.
3. The agent says it will "leave that for later" / "the user can fix that manually" / "as a follow-up" without either (a) doing the work in this turn, (b) creating a SUB-TASK via the create_task MCP tool with parent_task_id set to the current task, (c) posting a comment on the current task that describes the deferred work concretely AND leaving the task in a non-terminal status (no set_task_status call to done/cancelled in this turn — the heartbeat will re-pick the task up and the agent will see its own comment), or (d) filing the deferred work as a SEPARATE task whose blocked_by_task_ids points at the specific unfinished task it is gated on — valid only when the remaining work genuinely cannot proceed until that other task lands AND is not part of THIS task's own deliverable (e.g. this task's plan/content is finished, but launch execution needs another task's not-yet-built feature). In case (d) marking the current task terminal is fine: the dependency edge keeps the work tracked and the cascade auto-wakes the follow-up's assignee when the blocker resolves. A new TOP-LEVEL task with NO such blocker edge, OR closing the current task while deferring work that has no gating dependency, is still NOT an acceptable deferral — that would let the deferred work disappear from this task's lifecycle. CRITICAL: options (b) and (d) are NOT available for work that is part of THIS task's own deliverable — a defect, gap, omission, or rework discovered in the very thing this task is producing (a bug in code this task wrote, a failing check on this task's work, a review finding on it, an adjacent issue noticed while editing it). That is this task's own remaining work, not separable follow-up: it must be resolved by (a) doing it this turn or (c) a concrete self-comment with the task left non-terminal. Spinning it into a sub-task or a separate task is itself a block-worthy deferral — sub-tasks and peer tasks are only for genuinely separable work (a parallelisable slice, or an independent deliverable that can ship on its own), never for fixing this task's own in-flight output.
4. Code changes were made but tests were not run after them.
5. The agent acknowledges a problem but stops without resolving it.
6. The agent stopped because it needed a credential or secret but did not call the request_credential MCP tool.
7. The agent marked a task as done while leaving unresolved review comments or unanswered questions from another participant in the thread, OR while its OWN outbound question is still awaiting an answer — an active @admin or @<agent-slug> mention the agent posted asking for a decision, approval, review, or information that has not arrived yet. The order does not matter: closing the task and then posting the question is the same failure as closing with the question already open. A task waiting on an answer must stay in a non-terminal status (in_progress) until the reply arrives.
8. The agent is stopping because THIS task cannot make further progress until another, separate task finishes (it says it is "waiting on" / "blocked on" / "pending" that task, or references it as a prerequisite), but it did NOT call the add_task_blocker MCP tool to declare this task blocked on that task. A prose "waiting on <task>" note — even one posted as a comment or progress summary — creates NO dependency edge: nothing re-engages this task when the other one closes, so the work strands silently. The only acceptable way to pause on another task's completion is to call add_task_blocker(task_id=<this task>, blocked_by_task_id=<the gating task>), which flips this task to blocked and makes the system auto-wake the assignee when the blocker reaches a terminal status. (This is distinct from case 3(d): 3(d) is about deferring NEW work to a separate task; this rule 8 is about THIS task's own remaining work being gated on another task.)
9. The agent earlier announced a plan or next step on this task — a comment of its own stating what it WOULD do (an explicit first-person commitment such as "I will delegate fixes to the specialists", "once this decision lands I'll update X and Y" — visible in the "Your original comment" block of a reply handoff or in list_comments output it read) — the input that plan was waiting on has arrived, and the agent is now stopping (especially marking the task done) having neither (a) carried the announced plan out — directly, or through the structural routes rule 3 accepts (a sub-task per announced delegation, a blocked_by follow-up task, or a concrete self-comment with the task left non-terminal) — nor (b) posted a comment explicitly revising or retracting the plan with the reason. Doing only a smaller piece of what was announced and closing silently is a silent scope reduction and must be blocked: a thread reader cannot distinguish it from dropped work. This rule targets explicit self-commitments only — options merely enumerated, analyses floated, or approaches discussed without committing do NOT count. A wrap-up comment that explicitly reconciles the plan (what was done; what is no longer needed and why — e.g. "the decision collapsed the scope, so only X remained; the delegation fan-out is retracted") fully satisfies this rule: the block is for closing silently, never for legitimately revising scope in the thread.
10. The agent's final message is itself written as a handoff or direct address to a teammate or the admin — it contains an active @<agent-slug> or @admin mention, baton-passing language naming who acts next ("over to you", "ready for your review", "please review / merge / proceed"), or a stative assertion that the work awaits, needs, or is pending a specifically named approver's sign-off, approval, or review ("awaiting Captain sign-off", "needs the marketing-lead's approval", "pending the admin's review") — where that named approver (a teammate slug or the admin) is the party expected to act next — but that handoff was never posted to the task thread as a comment via the create_comment MCP tool this turn. A run's final message is delivered to NO ONE: it is not a comment, no mention inside it is parsed, and it wakes nobody — a handoff that exists only in the final message strands the work with both sides waiting, exactly the failure a posted comment exists to prevent. When you can see the full transcript, block unless a create_comment call this turn actually carries the mention/handoff the final message expresses. When you can see only the final message (the usual case), any active @<agent-slug> or @admin mention or baton-passing address ("over to you", "please review / merge / proceed") is an UNDELIVERED handoff — BLOCK by default. A purely STATIVE sign-off recap counts the same: naming a specific approver as the party still owed the work — "the task is awaiting Captain sign-off", "needs the marketing-lead's approval", "pending the admin's review" — with no active @-mention to that approver posted this turn is an undelivered handoff exactly as a baton-passing line is, and it strands the work whether the task is left non-terminal OR marked terminal (the non-terminal case is the one rule 11, which requires a terminal transition, does not reach). Treat the named approver as the next actor and block. Only two things exempt it: (a) the message EXPLICITLY states the same handoff was already posted as a comment this turn — a first-person claim of the create_comment itself ("posted the handoff comment @-mentioning the captain", "left the @admin approval ask as a comment on this task"); a passive or stative description of the work's readiness — "is presented for your final approval", "ready for your review", "the plan is ready" — is NOT such a claim and must still be blocked; or (b) the named teammate is genuinely NOT the next actor — you are crediting, quoting or summarising them and nobody is being asked for anything. The passive spelling @@<slug> is NOT itself an exemption: it notifies no one, so a @@<slug> who IS the next actor is a handoff delivered to nobody, exactly like a bare or bold name. Apply one test to every name however it is spelled (bare, **bold**, @@passive, or by role title) — "who is expected to act next on this task?" — and block when that party got no active @-mention this turn. Never infer a comment was posted from report-like grammar alone. The block reason must tell the agent to post the handoff as a create_comment on the current task (with the active @-mention) — for a sign-off recap that means the live @<approver-slug>/@admin sign-off ask, with the task left non-terminal so their reply wakes it — or, if it genuinely already posted it, to simply end the turn without reposting.
11. The agent is marking the task terminal (done/cancelled) but the task thread has established that the work still needs an approval or sign-off that has NOT been granted — a final approval from the admin, or a sign-off from a named approver (e.g. a lead or captain) — and the agent is closing on the strength of its OWN review or its own satisfaction with the work rather than that party's actual approval. This is DISTINCT from rule 7 (an unanswered question THE AGENT ITSELF posted this run): rule 11 fires on an approval requirement INHERITED from the thread — stated by ANY participant, in any prior run, and often before a rework/detour — that the agent, having read the thread (list_comments output, or the reply-handoff context it was given), can see is still outstanding. Signals of an established-but-ungranted approval: the thread says the work is "ready for admin approval", "needs Captain sign-off", "awaiting final approval", "pending the admin's review", or the flow named a specific approver whose granting comment never arrived. A reviewer's own pass ("my review is complete", "approved on my end", "no changes needed", "looks good to me") is ONE link in the chain, NOT the terminal approval when the flow requires a higher or final sign-off — closing on it silently short-circuits the approval chain and must be blocked. A rework or detour cycle (guidelines changed, assets redone, feedback incorporated) does NOT discharge a pending approval: the approval that was outstanding before the rework is still outstanding after it and must be re-requested — do not treat "I redid the work and re-reviewed it" as equivalent to "the required approval was granted". The block reason must tell the agent to post the outstanding approval as a live @-mention ask on the current task — @admin for the human's final approval, @<approver-slug> for a named approver such as the captain — leave the task in a non-terminal status (review or in_progress), and end the turn so that party's reply/approval wakes it; the task may become done only after the required approval actually lands.
12. The run was woken by someone ASKING this agent for something on this task — a review or sign-off request, a question, a request for a decision, a status or information request, from the admin or from a teammate — and the substance of the reply exists ONLY in the final message, with no create_comment call on this task this turn. This is distinct from rule 10, which turns on the final message being SHAPED like a handoff (an active mention, a baton-passing line, a named-approver recap). Rule 12 fires on a reply that names nobody and passes no baton but is still owed to whoever asked: a review verdict ("Verdict: PASS — all 14 reports are accurate and ready"), an answer to a question, a decision, a findings summary. The asker is waiting on the thread, and a final message reaches them exactly as little as it reaches anyone else — the task simply sits in_progress until a human notices nothing happened. Signals that the run was answering an ask: the final message reads as a verdict, an answer, a review result, or a report addressed to whoever raised the task or commented on it, and the context the agent was given (a mention handoff block, an "Your original comment" reply block, or list_comments output it read) shows a request it has now completed. Doing the work is NOT the deliverable on its own — reporting it back is. Block, and tell the agent to post its reply as a create_comment on the current task; it does not need an @-mention if it is simply answering the person who asked (the reply reaches them), but the substance must land in the thread.
13. The agent found that an integration the work depends on is BROKEN — an MCP connector or credential that is expired, revoked, unauthorised, or rejecting calls (a 401/403 from a connector, a test_connector failure, an OAuth grant that no longer refreshes, an MCP server whose tools error out) — and is stopping without escalating it to the human. Recording it as a "known gap", an "acknowledged limitation", a caveat in a report or document, a note in a progress summary, or an item in ANOTHER task's description is NOT escalation: none of those reach a person who can fix it, and the integration stays broken while every later run silently works around it or produces degraded output. This is distinct from rule 6, which covers an agent that NEEDED a credential it never had; rule 13 covers one that WAS working and has stopped working. The only acceptable resolutions are an active @admin comment on the current task naming the connector, what is failing, and what the human needs to do (typically reconnect or re-authorise it), or a request_credential call where a pasted value is what fixes it. Block unless one of those actually happened this turn. Working around the breakage for this task's own output is fine and often correct — but it does not discharge the escalation, and a run that both worked around it and stayed silent about it is exactly the failure this rule exists to catch.

Allow the stop only if the work appears genuinely complete, or every unfinished thread is captured either as a sub-task (parent_task_id = current task), as a concrete self-comment on the current task with the task left in a non-terminal status, or — when the remaining work is a separate deliverable gated on another unfinished task — as a separate task whose blocked_by_task_ids points at that gating task (in which case the current task may be marked terminal), or this task has been gated on the task it is waiting for via add_task_blocker (so it now shows blocked and the cascade will auto-wake it), or the agent is correctly waiting on input it cannot obtain by itself. "Waiting on input it cannot obtain by itself" means input from a human or an external system — posting a comment containing the literal mention "@admin" on the current task and stopping with the task left in a non-terminal status counts (the admin's reply wakes the agent automatically), as does calling request_credential for a needed secret. Waiting on an approval or sign-off the task's flow requires — whether the admin's final approval (@admin) or a named approver's sign-off (@<approver-slug>, e.g. a lead or captain) — is likewise a valid stop when the agent has posted that approval request as a live @-mention comment on the current task this run and left the task non-terminal; the approver's reply wakes the agent. What is NOT valid is closing the task while such a required approval is still ungranted (rule 11). Filing a proposal or opening an approval that now awaits an admin decision the agent cannot make itself — e.g. a hire proposal via create_hire_proposal — and leaving the task in a non-terminal status counts the same way: the admin's resolution auto-wakes the agent exactly as an @admin reply does, so re-evaluating such a task on a later turn and calling report_no_work while the approval is still pending is a valid stop, NOT an unresolved problem (rule 5) or an unanswered outbound question (rule 7). The same wait with the task set to done or cancelled is NOT a valid stop — that is rule 7. Waiting on ANOTHER TASK's completion does NOT count as waiting on input — it is only acceptable with the add_task_blocker edge described in rule 8.

Separately, if the agent has genuinely evaluated the current task, concluded there is no actionable work this turn, and called the report_no_work MCP tool (e.g. a planning task whose sub-tasks are still open, or a thread already fully handled), that is a valid stop — but ONLY when none of the block rules 1-13 above is triggered. report_no_work is not an escape hatch: failing tests, an unfixed acknowledged problem, deferred work, an unanswered thread, an unreported reply, or an unescalated broken integration still blocks the stop regardless of it.`;

/**
 * How the judge answers. The judge script reads `decision` off the reply and
 * appends this to the rules, which name no output format of their own.
 */
export const STOP_HOOK_DECISION_FORMAT = `Answer with only a JSON object: {"decision":"block","reason":"<what the agent must do next>"} to block the stop, or {"decision":"allow"} to allow it.`;

/**
 * A hook that shells out: the doc-write guard, a deterministic path match, and
 * the completeness judge's script.
 */
interface ClaudeCommandHookEntry {
	type: 'command';
	command: string;
	timeout: number;
}

interface ClaudeStopHookMatcherGroup {
	hooks: ClaudeCommandHookEntry[];
}

interface ClaudeCommandHookMatcherGroup {
	/** Tool-name pattern this group applies to, e.g. `Write|Edit`. */
	matcher: string;
	hooks: ClaudeCommandHookEntry[];
}

export interface ClaudeCodeSettings {
	hooks: {
		/**
		 * Present for every task run; omitted only when the caller asks for no
		 * completeness judge (the CEO chat - see `McpAdapterContext.stopJudge`).
		 */
		Stop?: ClaudeStopHookMatcherGroup[];
		/**
		 * Present only when the run has project docs to guard. Deterministic and
		 * blocking: it refuses a Write/Edit aimed at a path that shadows a project
		 * doc, which is the one moment the mistake is still cheap to undo.
		 */
		PreToolUse?: ClaudeCommandHookMatcherGroup[];
	};
	/**
	 * Tool-permission rules. Only ever carries `deny` entries for MCP tools a
	 * connector's method allowlist withholds (`mcp__<server>__<tool>`); omitted
	 * entirely when nothing is restricted, so an unrestricted run's settings file
	 * is byte-identical to what it was before method access existed.
	 */
	permissions?: {
		deny: string[];
	};
}

export function buildClaudeCodeSettings(
	/**
	 * MCP tools to withhold, as fully-qualified `mcp__<server>__<tool>` patterns.
	 * Claude Code's per-server config entry has no tool filter, so the allowlist
	 * has to be expressed here as a deny list of the *disabled* tools — which is
	 * why the caller resolves it against the connector's known method catalog
	 * rather than passing the allowlist through.
	 */
	deniedTools?: readonly string[],
	/**
	 * Container path of the per-run doc-write guard script. Omitted when the
	 * project has no docs to guard, in which case no PreToolUse hook is emitted
	 * and the settings file is byte-identical to what it was before the guard
	 * existed.
	 */
	docWriteGuardCommand?: string | null,
	/**
	 * The command that runs the completeness judge's script, or null for none:
	 * the CEO chat has no judge. See {@link McpAdapterContext.stopJudge} for why a
	 * chat turn is not a thing this judge can rule on.
	 */
	judgeCommand?: string | null,
): ClaudeCodeSettings {
	return {
		...(deniedTools && deniedTools.length > 0 ? { permissions: { deny: [...deniedTools] } } : {}),
		hooks: {
			...(docWriteGuardCommand
				? {
						PreToolUse: [
							{
								matcher: DOC_WRITE_GUARD_MATCHER,
								hooks: [
									{
										type: 'command' as const,
										command: docWriteGuardCommand,
										timeout: 10,
									},
								],
							},
						],
					}
				: {}),
			...(judgeCommand
				? {
						Stop: [
							{
								hooks: [
									{
										type: 'command' as const,
										command: judgeCommand,
										timeout: CLAUDE_CODE_JUDGE_HOOK_TIMEOUT_SEC,
									},
								],
							},
						],
					}
				: {}),
		},
	};
}

/**
 * Per-runtime parameters for the judge script that runs inside the agent
 * container. The script body follows the Codex shape — stdin
 * read, JSON parse, fetch, verdict extraction, fail-open — only the input
 * field, API call, and response extraction differ.
 */
interface JudgeRuntimeSpec {
	/**
	 * The `decision` value the hook must emit to make THIS runtime keep the
	 * agent working. Codex's `Stop` hook continues on `block` (the reason
	 * becomes the continuation prompt). This is the runtime's wire value, distinct from the judge LLM's
	 * own `block`/`allow` verdict.
	 */
	blockDecision: string;
	/**
	 * Process exit code to set when blocking, for runtimes whose hook runner reads
	 * the *exit code* rather than (or as well as) stdout JSON.
	 *
	 * Kimi Code documents exit 2 as "intentional block", 0 as allow, and any other
	 * non-zero as a script error that fails open — so returning 0 alongside a block
	 * verdict would silently discard it. Left unset for Codex, which reads
	 * the decision off stdout and treat a non-zero exit as a broken hook.
	 */
	blockExitCode?: number;
	/**
	 * Also write the block reason to stderr. Kimi Code documents stderr as the
	 * source of the reason shown to the model; emitting it there as well as on
	 * stdout costs nothing and means the reason survives whichever channel the
	 * installed version actually reads.
	 */
	blockReasonToStderr?: boolean;
	/**
	 * Field(s) on the parsed stdin JSON that may carry the agent's final
	 * message, probed in order (first non-empty string wins). A list lets a
	 * runtime whose Stop payload shape is undocumented degrade gracefully.
	 */
	inputFields: string[];
	/**
	 * Recover the final assistant message from the run's own session log when
	 * `inputFields` yields nothing.
	 *
	 * Kimi Code's Stop payload carries `hook_event_name` / `session_id` / `cwd` /
	 * `client_type` and a `stop_hook_active` that is always false — the agent's
	 * final message is not passed under any field name — so without this the
	 * judge would have nothing to evaluate and would always fail open. The script
	 * walks `$KIMI_CODE_HOME` (a per-run directory Hezo owns) for the session's
	 * JSONL and asks `finalMessageFn` for the last assistant message in it. Set
	 * only for runtimes whose payload genuinely lacks the message; every other
	 * runtime leaves it unset and keeps the cheaper stdin-only path.
	 */
	sessionLogLookup?: {
		/** Env var holding the runtime's data root. */
		homeEnvVar: string;
		/**
		 * Exact basename of the per-session JSONL to search for under that root
		 * (Kimi Code writes a fixed `wire.jsonl`).
		 */
		logBasename?: string;
		/**
		 * Match by extension instead, for a runtime that names the file after the
		 * session id and so has no fixed basename to look for. Set one of these,
		 * not both. No runtime uses it today; the emitted script handles both.
		 */
		logSuffix?: string;
		/**
		 * Source of `function finalMessage(records)`: given one log file's parsed
		 * records in order, return the last assistant message they hold, or
		 * undefined. The record shape is the runtime's own, so it lives here rather
		 * than in the shared script body - and it is exactly what a CLI bump must
		 * re-check, since a shape this does not recognise fails open silently.
		 */
		finalMessageFn: string;
	};
	/**
	 * Use a marker file rather than `stop_hook_active` as the "already continued
	 * once" signal.
	 *
	 * The judge is allowed to block a turn at most once per run — otherwise a
	 * persistent verdict loops the same exec indefinitely, re-waking the agent
	 * into redundant work. Most runtimes flag the second invocation on stdin with
	 * `stop_hook_active`; Kimi Code does not set it, leaving that ceiling inert.
	 * When set, the script treats the marker's existence as the flag and writes it
	 * immediately before emitting a block. The marker lives in the per-run home,
	 * so it cannot leak across runs.
	 */
	loopGuardFile?: {
		homeEnvVar: string;
		basename: string;
	};
	/**
	 * Source of `async function ask(message, input)`: put the rules and the
	 * agent's final `message` to the judge model and return its verdict as JSON
	 * text, or undefined to fail open. `input` is the parsed hook payload, and
	 * `SYSTEM_PROMPT` (the rules plus the decision format) is in scope. How the
	 * model is reached is the runtime's own affair: an API call with the key the
	 * CLI uses, or the CLI itself.
	 */
	askFn: string;
}

/** What every runtime's judge script is named in the per-run home. */
export const JUDGE_SCRIPT_BASENAME = 'stop-hook-judge.mjs';

/**
 * @param model the model to judge with, for a runtime whose Stop payload names
 *   none; in scope in the script as `JUDGE_MODEL`, empty when not given.
 */
function buildJudgeScript(spec: JudgeRuntimeSpec, model?: string | null): string {
	const guard = spec.loopGuardFile;
	const lookup = spec.sessionLogLookup;
	// Both extras are emitted as no-op constants when unset, so the script body
	// stays a single shared shape across every runtime rather than forking.
	const extrasDecl = `
const GUARD_HOME_ENV = ${JSON.stringify(guard?.homeEnvVar ?? '')};
const GUARD_BASENAME = ${JSON.stringify(guard?.basename ?? '')};
const LOG_HOME_ENV = ${JSON.stringify(lookup?.homeEnvVar ?? '')};
const LOG_BASENAME = ${JSON.stringify(lookup?.logBasename ?? '')};
const LOG_SUFFIX = ${JSON.stringify(lookup?.logSuffix ?? '')};
${lookup?.finalMessageFn ?? 'function finalMessage() { return undefined; }'}

function guardPath() {
	if (!GUARD_HOME_ENV || !GUARD_BASENAME) return null;
	const home = process.env[GUARD_HOME_ENV];
	return home ? path.join(home, GUARD_BASENAME) : null;
}

// True when this hook has already blocked once in this run. Stands in for
// \`stop_hook_active\` on runtimes that never set it.
function alreadyBlocked() {
	const p = guardPath();
	if (!p) return false;
	try { return fs.existsSync(p); } catch { return false; }
}

function markBlocked() {
	const p = guardPath();
	if (!p) return;
	try { fs.writeFileSync(p, '1'); } catch { /* best effort — see alreadyBlocked */ }
}

// Depth-bounded, symlink-free search; mirrors the runner's own session-log walk.
function findLogs(dir, depth) {
	if (depth > 8) return [];
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	const out = [];
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...findLogs(full, depth + 1));
		else if (e.isFile() && matchesLog(e.name)) out.push(full);
	}
	return out;
}

// Either an exact basename (Kimi Code's fixed wire.jsonl) or an extension, for
// runtimes that name the file after the session id.
function matchesLog(name) {
	if (LOG_BASENAME) return name === LOG_BASENAME;
	if (LOG_SUFFIX) return name.endsWith(LOG_SUFFIX);
	return false;
}

// Last assistant message from the run's own session log, for runtimes whose Stop
// payload omits it. Prefers the file whose path contains the session id when the
// run has more than one session dir. The record shape is read by the runtime's
// own \`finalMessage\`, declared above.
function messageFromSessionLog(sessionId) {
	if (!LOG_HOME_ENV || !(LOG_BASENAME || LOG_SUFFIX)) return undefined;
	const home = process.env[LOG_HOME_ENV];
	if (!home) return undefined;
	let files = findLogs(home, 0);
	if (files.length === 0) return undefined;
	if (sessionId) {
		const scoped = files.filter((f) => f.includes(sessionId));
		if (scoped.length > 0) files = scoped;
	}
	let latest;
	for (const f of files) {
		let contents;
		try { contents = fs.readFileSync(f, 'utf8'); } catch { continue; }
		const records = [];
		for (const line of contents.split('\\n')) {
			const t = line.trim();
			if (!t) continue;
			try { records.push(JSON.parse(t)); } catch { /* a torn last line */ }
		}
		const text = finalMessage(records);
		if (typeof text === 'string' && text.trim()) latest = text;
	}
	return latest;
}
`;
	// ESM imports, not `require`: the script is written as `.mjs`, so Node loads it
	// as a module where `require` is undefined. Getting this wrong throws at load,
	// which every runtime reads as a broken hook and fails open — the judge would
	// silently never fire.
	return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SYSTEM_PROMPT = ${JSON.stringify(`${STOP_HOOK_RULES}\n\n${STOP_HOOK_DECISION_FORMAT}`)};
const JUDGE_MODEL = ${JSON.stringify(model?.trim() ?? '')};
const MESSAGE_FIELDS = ${JSON.stringify(spec.inputFields)};
const JUDGE_ACTIVE_ENV = ${JSON.stringify(JUDGE_ACTIVE_ENV)};
${extrasDecl}
${spec.askFn}

async function readStdin() {
	let buf = '';
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

async function main() {
	// A session the judge itself started: never judge the judge.
	if (process.env[JUDGE_ACTIVE_ENV]) return;
	const raw = await readStdin();
	if (!raw.trim()) return;
	let input;
	try { input = JSON.parse(raw); } catch { return; }
	// The turn was already continued once by this hook — allow the stop now so a
	// persistent judge can't loop the agent indefinitely (re-waking it into
	// redundant reposts / repeated work). Most runtimes flag this on stdin; for
	// the ones that don't, the marker file carries the same signal.
	if (input && input.stop_hook_active) return;
	if (alreadyBlocked()) return;
	let message;
	for (const f of MESSAGE_FIELDS) {
		if (typeof input[f] === 'string' && input[f].trim()) { message = input[f]; break; }
	}
	if (!message) message = messageFromSessionLog(input && input.session_id);
	if (!message) return; // no final message available — fail open

	let verdict;
	try {
		const text = await ask(message, input);
		if (!text) return;
		verdict = JSON.parse(text);
	} catch { return; }

	if (verdict && verdict.decision === 'block' && typeof verdict.reason === 'string' && verdict.reason.length > 0) {
		// Mark BEFORE emitting, so a crash between the two still costs at most one
		// extra continuation rather than an unbounded loop.
		markBlocked();
		process.stdout.write(JSON.stringify({ decision: ${JSON.stringify(spec.blockDecision)}, reason: verdict.reason }));
		${spec.blockReasonToStderr ? 'process.stderr.write(verdict.reason);' : ''}
		${spec.blockExitCode === undefined ? '' : `process.exitCode = ${spec.blockExitCode};`}
	}
}

main().catch(() => {});
`;
}

/**
 * Set in the environment of a session the judge starts, so a hook firing inside
 * that session exits at once instead of judging the judge.
 */
const JUDGE_ACTIVE_ENV = 'HEZO_STOP_JUDGE_ACTIVE';

/**
 * Build a JudgeRuntimeSpec for an OpenAI-compatible Chat Completions upstream.
 * Only the base URL, key env, model, and stdin field names vary - the
 * request/response shape is identical.
 */
function openAiCompatJudgeSpec(opts: {
	baseUrl: string;
	/** API key env var(s), checked in order; first non-empty wins. */
	apiKeyEnvVars: string[];
	model: string;
	inputFields: string[];
}): JudgeRuntimeSpec {
	const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
	const apiKeyExpr = opts.apiKeyEnvVars.map((v) => `process.env.${v}`).join(' || ');
	return {
		blockDecision: 'block',
		inputFields: opts.inputFields,
		askFn: `async function ask(message) {
	const apiKey = ${apiKeyExpr};
	if (!apiKey) return undefined; // no api key - fail open
	const res = await fetch(${JSON.stringify(url)}, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
		body: JSON.stringify({
			model: ${JSON.stringify(opts.model)},
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: "Agent's final response:\\n" + message },
			],
			response_format: { type: 'json_object' },
			temperature: 0,
		}),
		signal: AbortSignal.timeout(25_000),
	});
	if (!res.ok) return undefined;
	const data = await res.json();
	return data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
}`,
	};
}

/** How long the Codex `Stop` hook may run: long enough for a `codex exec` turn. */
export const CODEX_JUDGE_HOOK_TIMEOUT_SEC = 120;

/**
 * How long the judge waits for its `codex exec`, a little under the hook's own
 * limit, so a slow judge fails open rather than being killed by the hook runner.
 */
const CODEX_JUDGE_EXEC_TIMEOUT_MS = (CODEX_JUDGE_HOOK_TIMEOUT_SEC - 20) * 1000;

/**
 * The flags the judge's own `codex exec` runs with, beside its model, working
 * folder and output files.
 *
 * - `--ignore-user-config` skips the run's `config.toml`, so the judge session
 *   has none of the run's MCP servers and none of its hooks, while its sign-in
 *   still comes from the run's `CODEX_HOME`. Codex keeps no auth setting there.
 * - Low reasoning, no web search, a read-only sandbox, and the features no Hezo
 *   session uses switched off: the judge reads one message and answers.
 */
const CODEX_JUDGE_EXEC_ARGS = [
	'--ignore-user-config',
	'--skip-git-repo-check',
	'--sandbox',
	'read-only',
	'-c',
	'model_reasoning_effort=low',
	'-c',
	'web_search=disabled',
	...CODEX_FEATURES_OFF.flatMap((f) => ['-c', `features.${f}=false`]),
];

/** The verdict shape the judge's `codex exec` must answer in, as a strict schema. */
const CODEX_JUDGE_VERDICT_SCHEMA = {
	type: 'object',
	properties: {
		decision: { type: 'string', enum: ['block', 'allow'] },
		reason: { type: 'string' },
	},
	required: ['decision', 'reason'],
	additionalProperties: false,
};

/**
 * Codex's judge asks the CLI, not an API. A ChatGPT subscription has no API key,
 * so an API call could never judge a subscription run; the CLI reaches the model
 * with whatever the run signed in with. The session runs under the run's own
 * `CODEX_HOME`, so its rollout sits beside the run's and its tokens count toward
 * the run like any other. It judges with the run's own model, which the payload
 * names and the credential can always run.
 */
const CODEX_EXEC_ASK_FN = `const CODEX_JUDGE_ARGS = ${JSON.stringify(CODEX_JUDGE_EXEC_ARGS)};
const CODEX_JUDGE_SCHEMA = ${JSON.stringify(CODEX_JUDGE_VERDICT_SCHEMA)};
const CODEX_JUDGE_TIMEOUT_MS = ${CODEX_JUDGE_EXEC_TIMEOUT_MS};

async function ask(message, input) {
	const model = input && typeof input.model === 'string' ? input.model.trim() : '';
	if (!model) return undefined; // no run model to judge with - fail open
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hezo-judge-'));
	try {
		const schemaPath = path.join(dir, 'verdict.schema.json');
		const outPath = path.join(dir, 'verdict.json');
		fs.writeFileSync(schemaPath, JSON.stringify(CODEX_JUDGE_SCHEMA));
		const args = ['exec', ...CODEX_JUDGE_ARGS, '-C', dir, '-m', model,
			'--output-schema', schemaPath, '-o', outPath, '-'];
		const code = await new Promise((resolve) => {
			// stdout and stderr are dropped: this hook's stdout is its verdict, and
			// anything else written there reads to Codex as a broken hook.
			const child = spawn('codex', args, {
				stdio: ['pipe', 'ignore', 'ignore'],
				env: { ...process.env, [JUDGE_ACTIVE_ENV]: '1' },
			});
			const timer = setTimeout(() => child.kill('SIGKILL'), CODEX_JUDGE_TIMEOUT_MS);
			child.on('error', () => { clearTimeout(timer); resolve(-1); });
			child.on('close', (c) => { clearTimeout(timer); resolve(c); });
			child.stdin.on('error', () => {});
			child.stdin.end(SYSTEM_PROMPT
				+ '\\n\\nJudge from the message alone: run no commands and change no files.'
				+ "\\n\\nAgent's final response:\\n" + message);
		});
		if (code !== 0) return undefined;
		return fs.readFileSync(outPath, 'utf8');
	} catch {
		return undefined;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}`;

/** How long the Claude Code `Stop` hook may run: long enough for a `claude -p` turn. */
export const CLAUDE_CODE_JUDGE_HOOK_TIMEOUT_SEC = 120;

/**
 * Where the Claude Code judge records each check's tokens, in the per-run home
 * beside the script: one `result` record per line, read back by the runtime's
 * adapter and added to the run's own usage, which its stream cannot see.
 */
export const CLAUDE_CODE_JUDGE_USAGE_BASENAME = 'stop-hook-usage.jsonl';

/**
 * The flags the judge's own `claude -p` runs with, beside its model and system
 * prompt. No tools, no MCP servers, no skills and no hooks, so the session reads
 * one message and answers; nothing saved, since nothing resumes it; low effort,
 * as for Codex's judge. Not `--bare`, which would also drop a subscription
 * sign-in, so a judge on one would never run. The rest of the run's environment
 * is inherited: the credential, the endpoint and any request headers, which
 * keep the judge on the run's own upstream and, for the managed provider, its
 * own host and cache.
 */
const CLAUDE_CODE_JUDGE_ARGS = [
	'-p',
	'--output-format',
	'json',
	'--tools',
	'',
	'--strict-mcp-config',
	'--disable-slash-commands',
	'--no-session-persistence',
	'--settings',
	JSON.stringify({ disableAllHooks: true }),
	'--effort',
	'low',
];

/**
 * Claude Code's judge asks the CLI, as Codex's does: an Anthropic subscription
 * has no API key, and the CLI reaches the run's endpoint with whatever the run
 * signed in with. The fixed rules are its system prompt and the final message
 * its one user turn, so every check of a run shares the rules as a prefix the
 * cache can serve. Its tokens go to the usage file whether or not the check
 * succeeded, since they were spent either way.
 */
const CLAUDE_CODE_ASK_FN = `const CLAUDE_JUDGE_ARGS = ${JSON.stringify(CLAUDE_CODE_JUDGE_ARGS)};
const CLAUDE_JUDGE_TIMEOUT_MS = ${(CLAUDE_CODE_JUDGE_HOOK_TIMEOUT_SEC - 20) * 1000};
const CLAUDE_JUDGE_USAGE_FILE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	${JSON.stringify(CLAUDE_CODE_JUDGE_USAGE_BASENAME)},
);

function recordJudgeUsage(result) {
	try {
		fs.appendFileSync(CLAUDE_JUDGE_USAGE_FILE, JSON.stringify({
			type: 'result',
			usage: result.usage || {},
			modelUsage: result.modelUsage || {},
		}) + '\\n');
	} catch { /* the run's count misses one check - never a reason to fail it */ }
}

async function ask(message) {
	if (!JUDGE_MODEL) return undefined; // no model to judge with - fail open
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hezo-judge-'));
	try {
		const out = await new Promise((resolve) => {
			// stderr is dropped and stdout kept: the CLI's JSON result is the answer,
			// and this hook's own stdout is its verdict, which nothing else may write.
			const child = spawn('claude', ['--model', JUDGE_MODEL, '--system-prompt', SYSTEM_PROMPT,
				...CLAUDE_JUDGE_ARGS], {
				cwd: dir,
				stdio: ['pipe', 'pipe', 'ignore'],
				env: { ...process.env, [JUDGE_ACTIVE_ENV]: '1' },
			});
			let stdout = '';
			child.stdout.on('data', (chunk) => { stdout += chunk; });
			const timer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_JUDGE_TIMEOUT_MS);
			child.on('error', () => { clearTimeout(timer); resolve(undefined); });
			child.on('close', () => { clearTimeout(timer); resolve(stdout); });
			child.stdin.on('error', () => {});
			child.stdin.end("Agent's final response:\\n" + message);
		});
		if (!out) return undefined;
		const result = JSON.parse(out);
		if (!result || typeof result !== 'object') return undefined;
		recordJudgeUsage(result);
		if (result.is_error || typeof result.result !== 'string') return undefined;
		// A model can wrap the object in a code fence; the verdict is the object.
		const object = result.result.match(/\\{[\\s\\S]*\\}/);
		return object ? object[0] : undefined;
	} catch {
		return undefined;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}`;

/**
 * Judge specs per runtime, each a Node command script the runtime's `Stop` hook
 * runs. Adding another runtime's judge is one entry here, not a new build
 * function.
 */

const JUDGE_SPECS: Partial<Record<AgentRuntime, JudgeRuntimeSpec>> = {
	// Claude Code `Stop` hook → a `claude -p` of its own, judging
	// `last_assistant_message` with the judge model the script was built with,
	// since the payload names none. Claude Code continues the turn on `block`.
	[AgentRuntime.ClaudeCode]: {
		blockDecision: 'block',
		inputFields: ['last_assistant_message'],
		askFn: CLAUDE_CODE_ASK_FN,
	},
	// Codex `Stop` hook → a `codex exec` of its own, judging `last_assistant_message`
	// with the run's model. Codex continues the turn on `block`.
	[AgentRuntime.Codex]: {
		blockDecision: 'block',
		inputFields: ['last_assistant_message'],
		askFn: CODEX_EXEC_ASK_FN,
	},
	// No Antigravity (Google) entry: from agy 1.2 its Stop hook fires headless, but
	// the payload carries no final message (only a `transcriptPath`) and no judge
	// is wired, so the runtime ships fail-open like Grok and OpenCode. JUDGE_SPECS is
	// Partial, so a missing entry is the disabled state, not a compile error.
	// Kimi Code `Stop` hook → Moonshot's OpenAI-compatible Chat Completions.
	//
	// Kimi's Stop hook is genuinely blockable (one of only three such events, with
	// UserPromptSubmit and PreToolUse), and a blocked stop feeds the reason back as
	// a new user message — the same continue-the-turn semantics as Codex. But its
	// payload is thinner than any other runtime's: past `hook_event_name`,
	// `session_id`, `cwd` and `client_type` it carries a `stop_hook_active` that is
	// always false. Hence the two extras:
	//
	//  - `inputFields` is still probed first (cheap, and future-proof if upstream
	//    starts passing the message), but realistically `sessionLogLookup` is what
	//    supplies the final message;
	//  - `loopGuardFile` stands in for `stop_hook_active`. The CLI allows one Stop
	//    continuation per turn by itself; the marker makes it one per run.
	//
	// Both read `$KIMI_CODE_HOME`, which the runner points at a per-run directory
	// (see RUNTIME_HOME_LAYOUTS), so neither can leak across runs. The API key is
	// `KIMI_MODEL_API_KEY` — the same shell-read var the CLI itself authenticates
	// with — so no extra credential is injected for the judge.
	[AgentRuntime.Kimi]: {
		...openAiCompatJudgeSpec({
			baseUrl: 'https://api.moonshot.ai/v1',
			apiKeyEnvVars: ['KIMI_MODEL_API_KEY'],
			model: STOP_HOOK_JUDGE_MODEL_KIMI,
			inputFields: ['last_assistant_message', 'last_message', 'assistant_message'],
		}),
		// Kimi reads the block off the exit code (2 = intentional block; any other
		// non-zero is treated as a broken script and fails open) and the reason off
		// stderr. Emit all three channels so the verdict survives regardless of
		// which one the installed version honours.
		blockExitCode: 2,
		blockReasonToStderr: true,
		sessionLogLookup: {
			homeEnvVar: 'KIMI_CODE_HOME',
			logBasename: 'wire.jsonl',
			// Kimi Code writes no assistant-message record while a turn is still open:
			// the text arrives as `content.part` loop events, one per part, each tagged
			// with the step it belongs to. The final message is the text of the last
			// step that had any. A subagent logs under its own `agentId`, and those
			// records are skipped; 0.30.0 wrote no `agentId` at all. Recorded shape:
			// `test/fixtures/kimi/kimi-2.0.2.wire.jsonl`.
			finalMessageFn: `function finalMessage(records) {
	let latest;
	let step;
	let stepText = '';
	for (const rec of records) {
		if (!rec || rec.type !== 'context.append_loop_event') continue;
		if (rec.agentId !== undefined && rec.agentId !== 'main') continue;
		const ev = rec.event;
		if (!ev || ev.type !== 'content.part' || !ev.part) continue;
		if (ev.part.type !== 'text' || typeof ev.part.text !== 'string') continue;
		if (ev.stepUuid !== step) { step = ev.stepUuid; stepText = ''; }
		stepText += ev.part.text;
		if (stepText.trim()) latest = stepText;
	}
	return latest;
}`,
		},
		loopGuardFile: { homeEnvVar: 'KIMI_CODE_HOME', basename: '.hezo-stop-blocked' },
	},
};

/**
 * Build the judge command script for a runtime, or `null` when that runtime has
 * no judge. `model` is what a runtime whose Stop payload names no model judges
 * with (Claude Code, through {@link judgeModelForProvider}).
 */
export function buildJudgeScriptForRuntime(
	runtime: AgentRuntime,
	model?: string | null,
): string | null {
	const spec = JUDGE_SPECS[runtime];
	return spec ? buildJudgeScript(spec, model) : null;
}

/**
 * Node script that runs inside the Codex container as the `Stop` hook
 * command. Reads Codex's StopCommandInput JSON from stdin and asks the Codex
 * CLI, in a session of its own, to judge completeness.
 */
export function buildCodexJudgeScript(): string {
	return buildJudgeScript(JUDGE_SPECS[AgentRuntime.Codex] as JudgeRuntimeSpec);
}
