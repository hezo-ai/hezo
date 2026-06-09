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
 * provider credential. No server-side LLM client. The hook is always on;
 * teams do not opt in or out. The judge model is chosen per provider so the
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
3. The agent says it will "leave that for later" / "the user can fix that manually" / "as a follow-up" without either (a) doing the work in this turn, (b) creating a SUB-TASK via the create_task MCP tool with parent_task_id set to the current task, (c) posting a comment on the current task that describes the deferred work concretely AND leaving the task in a non-terminal status (no set_task_status call to done/closed in this turn — the heartbeat will re-pick the task up and the agent will see its own comment), or (d) filing the deferred work as a SEPARATE ticket whose blocked_by_task_ids points at the specific unfinished ticket it is gated on — valid only when the remaining work genuinely cannot proceed until that other ticket lands AND is not part of THIS ticket's own deliverable (e.g. this ticket's plan/content is finished, but launch execution needs another ticket's not-yet-built feature). In case (d) marking the current ticket terminal is fine: the dependency edge keeps the work tracked and the cascade auto-wakes the follow-up's assignee when the blocker resolves. A new TOP-LEVEL task with NO such blocker edge, OR closing the current task while deferring work that has no gating dependency, is still NOT an acceptable deferral — that would let the deferred work disappear from this task's lifecycle.
4. Code changes were made but tests were not run after them.
5. The agent acknowledges a problem but stops without resolving it.
6. The agent stopped because it needed a credential or secret but did not call the request_credential MCP tool.
7. The agent marked a task as done while leaving unresolved review comments or unanswered questions from another participant in the thread.

Allow the stop (output JSON with "decision":"allow") only if the work appears genuinely complete, or every unfinished thread is captured either as a sub-task (parent_task_id = current task), as a concrete self-comment on the current task with the task left in a non-terminal status, or — when the remaining work is a separate deliverable gated on another unfinished ticket — as a separate ticket whose blocked_by_task_ids points at that gating ticket (in which case the current ticket may be marked terminal), or the agent is correctly waiting on input it cannot proceed without. Posting a comment containing the literal mention "@admin" on the current task and stopping with the task left in a non-terminal status counts as correctly waiting on input — the admin's reply wakes the agent automatically.`;

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
	/** API key env var(s), checked in order; first non-empty wins. */
	apiKeyEnvVars: string[];
	/** Field on the parsed stdin JSON that carries the agent's final message. */
	inputField: string;
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
	const message = input[${JSON.stringify(spec.inputField)}];
	if (!message) return;

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
		process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }));
	}
}

main().catch(() => {});
`;
}

/**
 * Judge specs for the runtimes that need a Node command script (their hook
 * runner can't make the sub-LLM call itself). Claude Code is absent — it uses
 * the native `type:"prompt"` Stop hook via `buildClaudeCodeSettings`. Adding a
 * fourth command-hook provider is one entry here, not a new build function.
 */
const JUDGE_SPECS: Partial<Record<AgentRuntime, JudgeRuntimeSpec>> = {
	// Codex `Stop` hook → OpenAI Chat Completions, judging `last_assistant_message`.
	[AgentRuntime.Codex]: {
		apiKeyEnvVars: ['OPENAI_API_KEY'],
		inputField: 'last_assistant_message',
		model: STOP_HOOK_JUDGE_MODEL_OPENAI,
		fetchExpr: `fetch('https://api.openai.com/v1/chat/completions', {
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
	},
	// Gemini `AfterAgent` hook → Google Generative AI, judging `prompt_response`.
	[AgentRuntime.Gemini]: {
		apiKeyEnvVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
		inputField: 'prompt_response',
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
