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
 * teams do not opt in or out. If the configured judge model isn't
 * reachable through the team's upstream (e.g. DeepSeek for Claude Code,
 * an unreachable OpenAI/Google API) the script fails open — exits 0 with
 * no output, which Codex/Gemini treat as "allow" — and the agent stops
 * normally.
 */

export const STOP_HOOK_JUDGE_MODEL_ANTHROPIC = 'claude-sonnet-4-6';
export const STOP_HOOK_JUDGE_MODEL_OPENAI = 'gpt-4o-mini';
export const STOP_HOOK_JUDGE_MODEL_GOOGLE = 'gemini-1.5-flash';

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
3. The agent says it will "leave that for later" / "the user can fix that manually" / "as a follow-up" without either (a) doing the work in this turn, (b) creating a SUB-TASK via the create_task MCP tool with parent_task_id set to the current task, or (c) posting a comment on the current task that describes the deferred work concretely AND leaving the task in a non-terminal status (no set_task_status call to done/closed in this turn — the heartbeat will re-pick the task up and the agent will see its own comment). A new TOP-LEVEL task, OR closing the current task while deferring, is NOT an acceptable deferral — both would let the deferred work disappear from this task's lifecycle.
4. Code changes were made but tests were not run after them.
5. The agent acknowledges a problem but stops without resolving it.
6. The agent stopped because it needed a credential or secret but did not call the request_credential MCP tool.
7. The agent marked a task as done while leaving unresolved review comments or unanswered questions from another participant in the thread.

Allow the stop (output JSON with "decision":"allow") only if the work appears genuinely complete, or every unfinished thread is captured either as a sub-task (parent_task_id = current task) or as a concrete self-comment on the current task with the task left in a non-terminal status, or the agent is correctly waiting on input it cannot proceed without.`;

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

export function buildClaudeCodeSettings(): ClaudeCodeSettings {
	return {
		hooks: {
			Stop: [
				{
					hooks: [
						{
							type: 'prompt',
							prompt: STOP_HOOK_PROMPT,
							timeout: 30,
							model: STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
							statusMessage: 'Checking work completeness...',
						},
					],
				},
			],
		},
	};
}

/**
 * Node script that runs inside the Codex container as the `Stop` hook
 * command. Reads Codex's StopCommandInput JSON from stdin, asks the
 * OpenAI Chat Completions API to judge completeness, writes a
 * `{"decision":"block","reason":"..."}` payload to stdout to block the
 * stop, or exits silently to allow it. Fails open on every error path.
 */
export function buildCodexJudgeScript(): string {
	return `#!/usr/bin/env node
const SYSTEM_PROMPT = ${JSON.stringify(STOP_HOOK_RULES)};
const JUDGE_MODEL = ${JSON.stringify(STOP_HOOK_JUDGE_MODEL_OPENAI)};
const apiKey = process.env.OPENAI_API_KEY;

async function readStdin() {
	let buf = '';
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

async function main() {
	if (!apiKey) return; // subscription auth — fail open
	const raw = await readStdin();
	if (!raw.trim()) return;
	let input;
	try { input = JSON.parse(raw); } catch { return; }
	const message = input.last_assistant_message;
	if (!message) return;

	const body = {
		model: JUDGE_MODEL,
		messages: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{ role: 'user', content: 'Agent\\'s final response:\\n' + message },
		],
		response_format: { type: 'json_object' },
		temperature: 0,
	};

	let verdict;
	try {
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(25_000),
		});
		if (!res.ok) return;
		const data = await res.json();
		const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
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
 * Node script that runs inside the Gemini container as the
 * `AfterAgent` hook command. Reads the AfterAgent input JSON from
 * stdin, asks the Google Generative AI API to judge completeness on
 * the agent's `prompt_response`, writes a
 * `{"decision":"block","reason":"..."}` payload to stdout to block the
 * stop, or exits silently to allow. Fails open on every error path.
 */
export function buildGeminiJudgeScript(): string {
	return `#!/usr/bin/env node
const SYSTEM_PROMPT = ${JSON.stringify(STOP_HOOK_RULES)};
const JUDGE_MODEL = ${JSON.stringify(STOP_HOOK_JUDGE_MODEL_GOOGLE)};
const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

async function readStdin() {
	let buf = '';
	for await (const chunk of process.stdin) buf += chunk;
	return buf;
}

async function main() {
	if (!apiKey) return; // no api-key auth — fail open
	const raw = await readStdin();
	if (!raw.trim()) return;
	let input;
	try { input = JSON.parse(raw); } catch { return; }
	const message = input.prompt_response;
	if (!message) return;

	const body = {
		systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
		contents: [{ role: 'user', parts: [{ text: 'Agent\\'s final response:\\n' + message }] }],
		generationConfig: {
			responseMimeType: 'application/json',
			temperature: 0,
		},
	};

	let verdict;
	try {
		const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(JUDGE_MODEL) + ':generateContent?key=' + encodeURIComponent(apiKey);
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(25_000),
		});
		if (!res.ok) return;
		const data = await res.json();
		const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
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
