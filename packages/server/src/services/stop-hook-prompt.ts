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

import { AgentRuntime, AiProvider } from '@hezo/shared';

export const STOP_HOOK_JUDGE_MODEL_ANTHROPIC = 'claude-sonnet-4-6';
export const STOP_HOOK_JUDGE_MODEL_DEEPSEEK = 'deepseek-v4-pro';
export const STOP_HOOK_JUDGE_MODEL_ZAI = 'GLM-4.7';
export const STOP_HOOK_JUDGE_MODEL_OPENAI = 'gpt-4o-mini';
export const STOP_HOOK_JUDGE_MODEL_GOOGLE = 'gemini-1.5-flash';
// Kimi runs on Claude Code against Moonshot's Anthropic-compatible endpoint, so
// the native `type:"prompt"` Stop hook judges with Moonshot's own model.
export const STOP_HOOK_JUDGE_MODEL_KIMI = 'kimi-k2.7-code';

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
 * The rule body the judge LLM evaluates against. Claude Code's hook
 * appends "Agent's final context:\n$ARGUMENTS" and lets Claude Code
 * substitute the transcript. Codex and Gemini get the rules as the
 * system prompt and the assistant's final message as the user message
 * (see the judge scripts).
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
10. The agent's final message is itself written as a handoff or direct address to a teammate or the admin — it contains an active @<agent-slug> or @admin mention, or baton-passing language naming who acts next ("over to you", "ready for your review", "please review / merge / proceed") — but that handoff was never posted to the task thread as a comment via the create_comment MCP tool this turn. A run's final message is delivered to NO ONE: it is not a comment, no mention inside it is parsed, and it wakes nobody — a handoff that exists only in the final message strands the work with both sides waiting, exactly the failure a posted comment exists to prevent. When you can see the full transcript, block unless a create_comment call this turn actually carries the mention/handoff the final message expresses. When you can see only the final message, block when it reads as the undelivered comment itself — an imperative or direct address to a named teammate ("@captain — over to you") with no statement that the same handoff was already posted as a comment; a message that merely REPORTS an already-posted comment ("posted the handoff comment @-mentioning the captain") or that names teammates passively (@@<slug>) is fine. The block reason must tell the agent to post the handoff as a create_comment on the current task (with the active @-mention) — or, if it genuinely already posted it, to simply end the turn without reposting.

Allow the stop (output JSON with "decision":"allow") only if the work appears genuinely complete, or every unfinished thread is captured either as a sub-task (parent_task_id = current task), as a concrete self-comment on the current task with the task left in a non-terminal status, or — when the remaining work is a separate deliverable gated on another unfinished ticket — as a separate ticket whose blocked_by_task_ids points at that gating ticket (in which case the current ticket may be marked terminal), or this ticket has been gated on the ticket it is waiting for via add_task_blocker (so it now shows blocked and the cascade will auto-wake it), or the agent is correctly waiting on input it cannot obtain by itself. "Waiting on input it cannot obtain by itself" means input from a human or an external system — posting a comment containing the literal mention "@admin" on the current task and stopping with the task left in a non-terminal status counts (the admin's reply wakes the agent automatically), as does calling request_credential for a needed secret. The same wait with the task set to done or cancelled is NOT a valid stop — that is rule 7. Waiting on ANOTHER TICKET's completion does NOT count as waiting on input — it is only acceptable with the add_task_blocker edge described in rule 8.

Separately, if the agent has genuinely evaluated the current task, concluded there is no actionable work this turn, and called the report_no_work MCP tool (e.g. a planning ticket whose sub-tasks are still open, or a thread already fully handled), that is a valid stop — but ONLY when none of the block rules 1-10 above is triggered. report_no_work is not an escape hatch: failing tests, an unfixed acknowledged problem, deferred work, or an unanswered thread still blocks the stop regardless of it.`;

export const STOP_HOOK_PROMPT = `${STOP_HOOK_RULES}

Agent's final context:
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
}

export function buildClaudeCodeSettings(provider: AiProvider): ClaudeCodeSettings {
	const model = CLAUDE_CODE_JUDGE_MODEL_BY_PROVIDER[provider] ?? STOP_HOOK_JUDGE_MODEL_ANTHROPIC;
	return {
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
	/** API key env var(s), checked in order; first non-empty wins. */
	apiKeyEnvVars: string[];
	/**
	 * Field(s) on the parsed stdin JSON that may carry the agent's final
	 * message, probed in order (first non-empty string wins). A list lets a
	 * runtime whose Stop payload shape is undocumented degrade gracefully.
	 */
	inputFields: string[];
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
	return `#!/usr/bin/env node
const SYSTEM_PROMPT = ${JSON.stringify(STOP_HOOK_RULES)};
const JUDGE_MODEL = ${JSON.stringify(spec.model)};
const MESSAGE_FIELDS = ${JSON.stringify(spec.inputFields)};
const apiKey = ${apiKeyExpr};

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
	// redundant reposts / repeated work). Both runtimes flag this on stdin.
	if (input && input.stop_hook_active) return;
	let message;
	for (const f of MESSAGE_FIELDS) {
		if (typeof input[f] === 'string' && input[f].trim()) { message = input[f]; break; }
	}
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
		process.stdout.write(JSON.stringify({ decision: ${JSON.stringify(spec.blockDecision)}, reason: verdict.reason }));
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
