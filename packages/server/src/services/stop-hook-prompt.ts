/**
 * Quality-gate Stop hook injected into every agent run.
 *
 * Claude Code's Stop hook fires when the assistant decides to end its turn;
 * returning `{"decision":"block","reason":"..."}` keeps the run looping
 * (even in headless `-p` mode) so the gate forces the agent to keep working
 * until its own judgment agrees the task is genuinely complete. Codex's
 * `Stop` and Gemini's `AfterAgent` hooks share the same block-and-loop
 * shape — only Claude Code supports the elegant `type: "prompt"` sub-LLM
 * call directly; Codex and Gemini support `type: "command"` only, so the
 * judge LLM call has to be made by a small Node script Hezo writes
 * alongside the hook config (`buildCodexJudgeScript`,
 * `buildGeminiJudgeScript`).
 *
 * The judge runs inside the container against the team's existing
 * provider credential. No server-side LLM client. The hook is on for every
 * runtime that exposes a turn-end hook — the one exception is OpenCode, whose
 * plugin API can't block-and-continue the agent loop in headless `opencode run`
 * (upstream sst/opencode#16626), so OpenCode runs with no completeness judge.
 * The judge model is chosen per provider so the
 * call resolves against the team's own upstream — see
 * CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER for the Claude Code runtimes and the
 * OpenAI/Google constants below. If a judge is genuinely unreachable
 * (subscription auth with no API key, or an upstream outage) the script
 * fails open — exits 0 with no output, which the runtimes treat as "allow"
 * — and the agent stops normally.
 */

import {
	AgentRuntime,
	AiProvider,
	claudeCodeModelArg,
	claudeCodeProviderUsesCustomEndpoint,
	KIMI_DEFAULT_MODEL,
} from '@hezo/shared';

export const STOP_HOOK_JUDGE_MODEL_ANTHROPIC = 'claude-sonnet-4-6';
export const STOP_HOOK_JUDGE_MODEL_DEEPSEEK = 'deepseek-v4-pro';
export const STOP_HOOK_JUDGE_MODEL_ZAI = 'GLM-4.7';
export const STOP_HOOK_JUDGE_MODEL_OPENAI = 'gpt-4o-mini';
export const STOP_HOOK_JUDGE_MODEL_GOOGLE = 'gemini-1.5-flash';
// Shared by BOTH ways of running Kimi. On the `kimi` provider (Claude Code
// against Moonshot's Anthropic-compatible endpoint) the native `type:"prompt"`
// Stop hook judges with it; on the `kimi_code` provider (Moonshot's own CLI) the
// command-script judge calls Moonshot's OpenAI-compatible endpoint with it.
export const STOP_HOOK_JUDGE_MODEL_KIMI = KIMI_DEFAULT_MODEL;

/**
 * Judge model for the Claude Code `type:"prompt"` Stop hook, keyed by provider.
 * Claude Code makes the judge call itself against the session's own upstream,
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
export function judgeModelForProvider(provider: AiProvider, runModel?: string | null): string {
	const fallback = CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER[provider] ?? STOP_HOOK_JUDGE_MODEL_ANTHROPIC;
	const trimmed = runModel?.trim();
	if (trimmed && claudeCodeProviderUsesCustomEndpoint(provider)) {
		return claudeCodeModelArg(provider, trimmed);
	}
	return fallback;
}

/**
 * The rule body the judge LLM evaluates against. Claude Code's `type:"prompt"`
 * hook appends the raw Stop-hook input JSON as `$ARGUMENTS`; that JSON carries
 * the assistant's final message in its `last_assistant_message` field (alongside
 * `stop_hook_active`), and STOP_HOOK_PROMPT points the judge explicitly at that
 * field so a weaker judge model evaluates the message, not the surrounding
 * metadata. Codex and Gemini get the rules as the system prompt and the
 * assistant's final message as the user message (see the judge scripts).
 */
export const STOP_HOOK_RULES = `You are a quality gate. The agent is about to stop working on a Hezo task. Review its final message and decide whether the work is truly complete.

Block the stop (output JSON with "decision":"block" and a "reason") if ANY of the following are true:
1. There are still failing tests that haven't been fixed.
2. The agent is claiming an issue is "out of scope" / "pre-existing" / "unrelated" to avoid fixing it.
3. The agent says it will "leave that for later" / "the user can fix that manually" / "as a follow-up" without either (a) doing the work in this turn, (b) creating a SUB-TASK via the create_task MCP tool with parent_task_id set to the current task, (c) posting a comment on the current task that describes the deferred work concretely AND leaving the task in a non-terminal status (no set_task_status call to done/cancelled in this turn — the heartbeat will re-pick the task up and the agent will see its own comment), or (d) filing the deferred work as a SEPARATE ticket whose blocked_by_task_ids points at the specific unfinished ticket it is gated on — valid only when the remaining work genuinely cannot proceed until that other ticket lands AND is not part of THIS ticket's own deliverable (e.g. this ticket's plan/content is finished, but launch execution needs another ticket's not-yet-built feature). In case (d) marking the current ticket terminal is fine: the dependency edge keeps the work tracked and the cascade auto-wakes the follow-up's assignee when the blocker resolves. A new TOP-LEVEL task with NO such blocker edge, OR closing the current task while deferring work that has no gating dependency, is still NOT an acceptable deferral — that would let the deferred work disappear from this task's lifecycle. CRITICAL: options (b) and (d) are NOT available for work that is part of THIS ticket's own deliverable — a defect, gap, omission, or rework discovered in the very thing this ticket is producing (a bug in code this ticket wrote, a failing check on this ticket's work, a review finding on it, an adjacent issue noticed while editing it). That is this ticket's own remaining work, not separable follow-up: it must be resolved by (a) doing it this turn or (c) a concrete self-comment with the task left non-terminal. Spinning it into a sub-task or a separate ticket is itself a block-worthy deferral — sub-tasks and peer tickets are only for genuinely separable work (a parallelisable slice, or an independent deliverable that can ship on its own), never for fixing this ticket's own in-flight output.
4. Code changes were made but tests were not run after them.
5. The agent acknowledges a problem but stops without resolving it.
6. The agent stopped because it needed a credential or secret but did not call the request_credential MCP tool.
7. The agent marked a task as done while leaving unresolved review comments or unanswered questions from another participant in the thread, OR while its OWN outbound question is still awaiting an answer — an active @admin or @<agent-slug> mention the agent posted asking for a decision, approval, review, or information that has not arrived yet. The order does not matter: closing the task and then posting the question is the same failure as closing with the question already open. A task waiting on an answer must stay in a non-terminal status (in_progress or review) until the reply arrives.
8. The agent is stopping because THIS ticket cannot make further progress until another, separate ticket finishes (it says it is "waiting on" / "blocked on" / "pending" that ticket, or references it as a prerequisite), but it did NOT call the add_task_blocker MCP tool to declare this ticket blocked on that ticket. A prose "waiting on <ticket>" note — even one posted as a comment or progress summary — creates NO dependency edge: nothing re-engages this ticket when the other one closes, so the work strands silently. The only acceptable way to pause on another ticket's completion is to call add_task_blocker(task_id=<this ticket>, blocked_by_task_id=<the gating ticket>), which flips this ticket to blocked and makes the system auto-wake the assignee when the blocker reaches a terminal status. (This is distinct from case 3(d): 3(d) is about deferring NEW work to a separate ticket; this rule 8 is about THIS ticket's own remaining work being gated on another ticket.)
9. The agent earlier announced a plan or next step on this ticket — a comment of its own stating what it WOULD do (an explicit first-person commitment such as "I will delegate fixes to the specialists", "once this decision lands I'll update X and Y" — visible in the "Your original comment" block of a reply handoff or in list_comments output it read) — the input that plan was waiting on has arrived, and the agent is now stopping (especially marking the task done) having neither (a) carried the announced plan out — directly, or through the structural routes rule 3 accepts (a sub-task per announced delegation, a blocked_by follow-up ticket, or a concrete self-comment with the task left non-terminal) — nor (b) posted a comment explicitly revising or retracting the plan with the reason. Doing only a smaller piece of what was announced and closing silently is a silent scope reduction and must be blocked: a thread reader cannot distinguish it from dropped work. This rule targets explicit self-commitments only — options merely enumerated, analyses floated, or approaches discussed without committing do NOT count. A wrap-up comment that explicitly reconciles the plan (what was done; what is no longer needed and why — e.g. "the decision collapsed the scope, so only X remained; the delegation fan-out is retracted") fully satisfies this rule: the block is for closing silently, never for legitimately revising scope in the thread.
10. The agent's final message is itself written as a handoff or direct address to a teammate or the admin — it contains an active @<agent-slug> or @admin mention, baton-passing language naming who acts next ("over to you", "ready for your review", "please review / merge / proceed"), or a stative assertion that the work awaits, needs, or is pending a specifically named approver's sign-off, approval, or review ("awaiting Captain sign-off", "needs the marketing-lead's approval", "pending the admin's review") — where that named approver (a teammate slug or the admin) is the party expected to act next — but that handoff was never posted to the task thread as a comment via the create_comment MCP tool this turn. A run's final message is delivered to NO ONE: it is not a comment, no mention inside it is parsed, and it wakes nobody — a handoff that exists only in the final message strands the work with both sides waiting, exactly the failure a posted comment exists to prevent. When you can see the full transcript, block unless a create_comment call this turn actually carries the mention/handoff the final message expresses. When you can see only the final message (the usual case), any active @<agent-slug> or @admin mention or baton-passing address ("over to you", "please review / merge / proceed") is an UNDELIVERED handoff — BLOCK by default. A purely STATIVE sign-off recap counts the same: naming a specific approver as the party still owed the work — "the ticket stays in review awaiting Captain sign-off", "needs the marketing-lead's approval", "pending the admin's review" — with no active @-mention to that approver posted this turn is an undelivered handoff exactly as a baton-passing line is, and it strands the work whether the ticket is left non-terminal OR marked terminal (the non-terminal case is the one rule 11, which requires a terminal transition, does not reach). Treat the named approver as the next actor and block. Only two things exempt it: (a) the message EXPLICITLY states the same handoff was already posted as a comment this turn — a first-person claim of the create_comment itself ("posted the handoff comment @-mentioning the captain", "left the @admin approval ask as a comment on this ticket"); a passive or stative description of the work's readiness — "is presented for your final approval", "ready for your review", "the plan is ready" — is NOT such a claim and must still be blocked; or (b) the name is written passively (@@<slug>), which notifies no one by design. Never infer a comment was posted from report-like grammar alone. The block reason must tell the agent to post the handoff as a create_comment on the current task (with the active @-mention) — for a sign-off recap that means the live @<approver-slug>/@admin sign-off ask, with the ticket left non-terminal so their reply wakes it — or, if it genuinely already posted it, to simply end the turn without reposting.
11. The agent is marking the task terminal (done/cancelled) but the ticket thread has established that the work still needs an approval or sign-off that has NOT been granted — a final approval from the admin, or a sign-off from a named approver (e.g. a lead or captain) — and the agent is closing on the strength of its OWN review or its own satisfaction with the work rather than that party's actual approval. This is DISTINCT from rule 7 (an unanswered question THE AGENT ITSELF posted this run): rule 11 fires on an approval requirement INHERITED from the thread — stated by ANY participant, in any prior run, and often before a rework/detour — that the agent, having read the thread (list_comments output, or the reply-handoff context it was given), can see is still outstanding. Signals of an established-but-ungranted approval: the thread says the work is "ready for admin approval", "needs Captain sign-off", "awaiting final approval", "pending the admin's review", or the flow named a specific approver whose granting comment never arrived. A reviewer's own pass ("my review is complete", "approved on my end", "no changes needed", "looks good to me") is ONE link in the chain, NOT the terminal approval when the flow requires a higher or final sign-off — closing on it silently short-circuits the approval chain and must be blocked. A rework or detour cycle (guidelines changed, assets redone, feedback incorporated) does NOT discharge a pending approval: the approval that was outstanding before the rework is still outstanding after it and must be re-requested — do not treat "I redid the work and re-reviewed it" as equivalent to "the required approval was granted". The block reason must tell the agent to post the outstanding approval as a live @-mention ask on the current task — @admin for the human's final approval, @<approver-slug> for a named approver such as the captain — leave the ticket in a non-terminal status (review or in_progress), and end the turn so that party's reply/approval wakes it; the ticket may become done only after the required approval actually lands.

Allow the stop (output JSON with "decision":"allow") only if the work appears genuinely complete, or every unfinished thread is captured either as a sub-task (parent_task_id = current task), as a concrete self-comment on the current task with the task left in a non-terminal status, or — when the remaining work is a separate deliverable gated on another unfinished ticket — as a separate ticket whose blocked_by_task_ids points at that gating ticket (in which case the current ticket may be marked terminal), or this ticket has been gated on the ticket it is waiting for via add_task_blocker (so it now shows blocked and the cascade will auto-wake it), or the agent is correctly waiting on input it cannot obtain by itself. "Waiting on input it cannot obtain by itself" means input from a human or an external system — posting a comment containing the literal mention "@admin" on the current task and stopping with the task left in a non-terminal status counts (the admin's reply wakes the agent automatically), as does calling request_credential for a needed secret. Waiting on an approval or sign-off the ticket's flow requires — whether the admin's final approval (@admin) or a named approver's sign-off (@<approver-slug>, e.g. a lead or captain) — is likewise a valid stop when the agent has posted that approval request as a live @-mention comment on the current task this run and left the ticket non-terminal; the approver's reply wakes the agent. What is NOT valid is closing the ticket while such a required approval is still ungranted (rule 11). Filing a proposal or opening an approval that now awaits an admin decision the agent cannot make itself — e.g. a hire proposal via create_hire_proposal — and leaving the task in a non-terminal status counts the same way: the admin's resolution auto-wakes the agent exactly as an @admin reply does, so re-evaluating such a task on a later turn and calling report_no_work while the approval is still pending is a valid stop, NOT an unresolved problem (rule 5) or an unanswered outbound question (rule 7). The same wait with the task set to done or cancelled is NOT a valid stop — that is rule 7. Waiting on ANOTHER TICKET's completion does NOT count as waiting on input — it is only acceptable with the add_task_blocker edge described in rule 8.

Separately, if the agent has genuinely evaluated the current task, concluded there is no actionable work this turn, and called the report_no_work MCP tool (e.g. a planning ticket whose sub-tasks are still open, or a thread already fully handled), that is a valid stop — but ONLY when none of the block rules 1-11 above is triggered. report_no_work is not an escape hatch: failing tests, an unfixed acknowledged problem, deferred work, or an unanswered thread still blocks the stop regardless of it.`;

export const STOP_HOOK_PROMPT = `${STOP_HOOK_RULES}

Loop breaker (check this FIRST): the "Stop-hook input" below is the raw Stop-hook input JSON. If it contains "stop_hook_active": true, this turn has ALREADY been continued once by this very hook — output {"decision":"allow"} immediately, with no further analysis. Blocking again would re-continue the same run and can loop the agent indefinitely on a verdict that is not going to change. (The command-script judges for the other runtimes short-circuit on this same flag.)

The agent's final message — the text you evaluate against the rules above — is the "last_assistant_message" field of the Stop-hook input JSON below. Evaluate THAT message. Every other field (session_id, transcript_path, cwd, permission_mode, hook_event_name) is metadata: ignore it, except "stop_hook_active" for the loop breaker above. In particular, rule 10 turns on what the "last_assistant_message" text itself says — an active @<agent-slug> or @admin mention or a baton-passing handoff there is UNDELIVERED and blocks by default. If "last_assistant_message" is absent or empty, output {"decision":"allow"}.

Stop-hook input:
$ARGUMENTS`;

interface ClaudeStopHookEntry {
	type: 'prompt';
	prompt: string;
	timeout: number;
	model: string;
	statusMessage: string;
}

interface ClaudeStopHookMatcherGroup {
	hooks: ClaudeStopHookEntry[];
}

export interface ClaudeCodeSettings {
	hooks: {
		Stop: ClaudeStopHookMatcherGroup[];
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
	provider: AiProvider,
	runModel?: string | null,
	/**
	 * MCP tools to withhold, as fully-qualified `mcp__<server>__<tool>` patterns.
	 * Claude Code's per-server config entry has no tool filter, so the allowlist
	 * has to be expressed here as a deny list of the *disabled* tools — which is
	 * why the caller resolves it against the connector's known method catalog
	 * rather than passing the allowlist through.
	 */
	deniedTools?: readonly string[],
): ClaudeCodeSettings {
	const model = judgeModelForProvider(provider, runModel);
	return {
		...(deniedTools && deniedTools.length > 0 ? { permissions: { deny: [...deniedTools] } } : {}),
		hooks: {
			Stop: [
				{
					hooks: [
						{
							type: 'prompt',
							prompt: STOP_HOOK_PROMPT,
							timeout: 30,
							model,
							statusMessage: 'Checking work completeness...',
						},
					],
				},
			],
		},
	};
}

/**
 * Per-runtime parameters for the judge script that runs inside the agent
 * container. The script body is identical across Codex and Gemini — stdin
 * read, JSON parse, fetch, verdict extraction, fail-open — only the input
 * field, API call, and response extraction differ.
 */
interface JudgeRuntimeSpec {
	/**
	 * The `decision` value the hook must emit to make THIS runtime keep the
	 * agent working. Codex's `Stop` hook continues on `block` (the reason
	 * becomes the continuation prompt); Gemini's `AfterAgent` hook continues on
	 * `deny` (the reason becomes a correction prompt) and ignores `block`
	 * outright. This is the runtime's wire value, distinct from the judge LLM's
	 * own `block`/`allow` verdict.
	 */
	blockDecision: string;
	/**
	 * Process exit code to set when blocking, for runtimes whose hook runner reads
	 * the *exit code* rather than (or as well as) stdout JSON.
	 *
	 * Kimi Code documents exit 2 as "intentional block", 0 as allow, and any other
	 * non-zero as a script error that fails open — so returning 0 alongside a block
	 * verdict would silently discard it. Left unset for Codex/Gemini, which read
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
	/** API key env var(s), checked in order; first non-empty wins. */
	apiKeyEnvVars: string[];
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
	 * Kimi Code's Stop payload carries only `hook_event_name` / `session_id` /
	 * `cwd` — the agent's final message is not passed under any field name — so
	 * without this the judge would have nothing to evaluate and would always fail
	 * open. The script walks `$KIMI_CODE_HOME` (a per-run directory Hezo owns) for
	 * the session's JSONL and takes the last assistant message. Set only for
	 * runtimes whose payload genuinely lacks the message; every other runtime
	 * leaves it unset and keeps the cheaper stdin-only path.
	 */
	sessionLogLookup?: {
		/** Env var holding the runtime's data root. */
		homeEnvVar: string;
		/** Basename of the per-session JSONL to search for under that root. */
		logBasename: string;
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
	/** Judge model identifier passed to the upstream API. */
	model: string;
	/**
	 * JS expression (as a string) evaluating to the fetch request. Receives
	 * `apiKey`, `JUDGE_MODEL`, `SYSTEM_PROMPT`, and `message` in scope.
	 */
	fetchExpr: string;
	/**
	 * JS expression (as a string) extracting the verdict JSON text from the
	 * parsed response `data`.
	 */
	extractTextExpr: string;
}

function buildJudgeScript(spec: JudgeRuntimeSpec): string {
	const apiKeyExpr = spec.apiKeyEnvVars.map((v) => `process.env.${v}`).join(' || ');
	const guard = spec.loopGuardFile;
	const lookup = spec.sessionLogLookup;
	// Both extras are emitted as no-op constants when unset, so the script body
	// stays a single shared shape across every runtime rather than forking.
	const extrasDecl = `
const GUARD_HOME_ENV = ${JSON.stringify(guard?.homeEnvVar ?? '')};
const GUARD_BASENAME = ${JSON.stringify(guard?.basename ?? '')};
const LOG_HOME_ENV = ${JSON.stringify(lookup?.homeEnvVar ?? '')};
const LOG_BASENAME = ${JSON.stringify(lookup?.logBasename ?? '')};

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
		else if (e.isFile() && e.name === LOG_BASENAME) out.push(full);
	}
	return out;
}

// Last assistant message from the run's own session log, for runtimes whose Stop
// payload omits it. Prefers the file whose path contains the session id when the
// run has more than one session dir.
function messageFromSessionLog(sessionId) {
	if (!LOG_HOME_ENV || !LOG_BASENAME) return undefined;
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
		for (const line of contents.split('\\n')) {
			const t = line.trim();
			if (!t) continue;
			let rec;
			try { rec = JSON.parse(t); } catch { continue; }
			if (!rec || rec.role !== 'assistant') continue;
			const c = rec.content;
			if (typeof c === 'string' && c.trim()) latest = c;
		}
	}
	return latest;
}
`;
	// ESM imports, not `require`: the script is written as `.mjs`, so Node loads it
	// as a module where `require` is undefined. Getting this wrong throws at load,
	// which every runtime reads as a broken hook and fails open — the judge would
	// silently never fire.
	return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = ${JSON.stringify(STOP_HOOK_RULES)};
const JUDGE_MODEL = ${JSON.stringify(spec.model)};
const MESSAGE_FIELDS = ${JSON.stringify(spec.inputFields)};
const apiKey = ${apiKeyExpr};
${extrasDecl}
async function readStdin() {
	let buf = '';
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

async function main() {
	if (!apiKey) return; // no api key — fail open
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
		const res = await ${spec.fetchExpr};
		if (!res.ok) return;
		const data = await res.json();
		const text = ${spec.extractTextExpr};
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
 * Judge specs for the runtimes that need a Node command script (their hook
 * runner can't make the sub-LLM call itself). Claude Code is absent — it uses
 * the native `type:"prompt"` Stop hook via `buildClaudeCodeSettings`. Adding another
 * command-hook provider is one entry here, not a new build function.
 */
/**
 * Build a JudgeRuntimeSpec for any OpenAI-compatible Chat Completions upstream
 * (Codex/OpenAI). Only the base URL, key env, model, and stdin field names vary
 * — the request/response shape is identical.
 */
function openAiCompatJudgeSpec(opts: {
	baseUrl: string;
	apiKeyEnvVars: string[];
	model: string;
	inputFields: string[];
}): JudgeRuntimeSpec {
	const url = `${opts.baseUrl.replace(/\/$/, '')}/chat/completions`;
	return {
		// Codex's `Stop` hook continues the turn on `block`.
		blockDecision: 'block',
		apiKeyEnvVars: opts.apiKeyEnvVars,
		inputFields: opts.inputFields,
		model: opts.model,
		fetchExpr: `fetch(${JSON.stringify(url)}, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
			body: JSON.stringify({
				model: JUDGE_MODEL,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: "Agent's final response:\\n" + message },
				],
				response_format: { type: 'json_object' },
				temperature: 0,
			}),
			signal: AbortSignal.timeout(25_000),
		})`,
		extractTextExpr: `data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content`,
	};
}

const JUDGE_SPECS: Partial<Record<AgentRuntime, JudgeRuntimeSpec>> = {
	// Codex `Stop` hook → OpenAI Chat Completions, judging `last_assistant_message`.
	[AgentRuntime.Codex]: openAiCompatJudgeSpec({
		baseUrl: 'https://api.openai.com/v1',
		apiKeyEnvVars: ['OPENAI_API_KEY'],
		model: STOP_HOOK_JUDGE_MODEL_OPENAI,
		inputFields: ['last_assistant_message'],
	}),
	// Gemini `AfterAgent` hook → Google Generative AI, judging `prompt_response`.
	[AgentRuntime.Gemini]: {
		// AfterAgent forces a corrective retry on `deny` and ignores `block`.
		blockDecision: 'deny',
		apiKeyEnvVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
		inputFields: ['prompt_response'],
		model: STOP_HOOK_JUDGE_MODEL_GOOGLE,
		fetchExpr: `fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(JUDGE_MODEL) + ':generateContent?key=' + encodeURIComponent(apiKey), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
				contents: [{ role: 'user', parts: [{ text: "Agent's final response:\\n" + message }] }],
				generationConfig: { responseMimeType: 'application/json', temperature: 0 },
			}),
			signal: AbortSignal.timeout(25_000),
		})`,
		extractTextExpr: `data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text`,
	},
	// Kimi Code `Stop` hook → Moonshot's OpenAI-compatible Chat Completions.
	//
	// Kimi's Stop hook is genuinely blockable (one of only three such events, with
	// UserPromptSubmit and PreToolUse), and a blocked stop feeds the reason back as
	// a new user message — the same continue-the-turn semantics as Codex. But its
	// payload is thinner than any other runtime's: it carries `hook_event_name`,
	// `session_id` and `cwd` and nothing else we need. Hence the two extras:
	//
	//  - `inputFields` is still probed first (cheap, and future-proof if upstream
	//    starts passing the message), but realistically `sessionLogLookup` is what
	//    supplies the final message;
	//  - `loopGuardFile` replaces the absent `stop_hook_active` so the one-block
	//    ceiling is real rather than nominal.
	//
	// Both read `$KIMI_CODE_HOME`, which the runner points at a per-run directory
	// (see SUBSCRIPTION_LAYOUTS), so neither can leak across runs. The API key is
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
		sessionLogLookup: { homeEnvVar: 'KIMI_CODE_HOME', logBasename: 'wire.jsonl' },
		loopGuardFile: { homeEnvVar: 'KIMI_CODE_HOME', basename: '.hezo-stop-blocked' },
	},
};

/**
 * Build the judge command script for a runtime, or `null` when that runtime has
 * no command-script judge (Claude Code, which uses the native prompt hook).
 */
export function buildJudgeScriptForRuntime(runtime: AgentRuntime): string | null {
	const spec = JUDGE_SPECS[runtime];
	return spec ? buildJudgeScript(spec) : null;
}

/**
 * Node script that runs inside the Codex container as the `Stop` hook
 * command. Reads Codex's StopCommandInput JSON from stdin and asks the
 * OpenAI Chat Completions API to judge completeness.
 */
export function buildCodexJudgeScript(): string {
	return buildJudgeScript(JUDGE_SPECS[AgentRuntime.Codex] as JudgeRuntimeSpec);
}

/**
 * Node script that runs inside the Gemini container as the `AfterAgent`
 * hook command. Reads the AfterAgent input JSON from stdin and asks the
 * Google Generative AI API to judge completeness on `prompt_response`.
 */
export function buildGeminiJudgeScript(): string {
	return buildJudgeScript(JUDGE_SPECS[AgentRuntime.Gemini] as JudgeRuntimeSpec);
}
