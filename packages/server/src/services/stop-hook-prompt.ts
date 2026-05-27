/**
 * Quality-gate Stop hook injected into every Claude Code run.
 *
 * Claude Code's `Stop` hook fires when the assistant decides to end its turn.
 * Returning `{"decision":"block","reason":"..."}` from the hook keeps Claude
 * looping in headless `-p` mode (the same loop `--max-turns` bounds), so the
 * gate effectively forces the agent to keep working until its own judgment
 * agrees the task is genuinely complete. The hook runs as a `type: "prompt"`
 * sub-LLM call inside the container, billed to the team's existing
 * Anthropic-compatible credential — no server-side LLM client.
 *
 * The judge model is intentionally hardcoded. The hook is always on; teams do
 * not opt in or out per `aa8439f9-settings.json`-style user preference. For
 * non-Anthropic Claude Code providers (DeepSeek, Z.ai) the hook is still
 * emitted; if the configured judge model isn't available at the upstream the
 * hook fails open (no block decision) and the agent stops normally.
 */

export const STOP_HOOK_JUDGE_MODEL = 'claude-sonnet-4-6';

export const STOP_HOOK_PROMPT = `You are a quality gate. The agent is about to stop working on a Hezo task. Review its final message and decide whether the work is truly complete.

Block the stop (output JSON with "decision":"block" and a "reason") if ANY of the following are true:
1. There are still failing tests that haven't been fixed.
2. The agent is claiming an issue is "out of scope" / "pre-existing" / "unrelated" to avoid fixing it.
3. The agent says it will "leave that for later" / "the user can fix that manually" / "as a follow-up" without either (a) doing the work in this turn, (b) creating a SUB-TASK via the create_task MCP tool with parent_task_id set to the current task, or (c) posting a comment on the current task that describes the deferred work concretely AND leaving the task in a non-terminal status (no set_task_status call to done/closed in this turn — the heartbeat will re-pick the task up and the agent will see its own comment). A new TOP-LEVEL task, OR closing the current task while deferring, is NOT an acceptable deferral — both would let the deferred work disappear from this task's lifecycle.
4. Code changes were made but tests were not run after them.
5. The agent acknowledges a problem but stops without resolving it.
6. The agent stopped because it needed a credential or secret but did not call the request_credential MCP tool.
7. The agent marked a task as done while leaving unresolved review comments or unanswered questions from another participant in the thread.

Allow the stop (output JSON with "decision":"allow") only if the work appears genuinely complete, or every unfinished thread is captured either as a sub-task (parent_task_id = current task) or as a concrete self-comment on the current task with the task left in a non-terminal status, or the agent is correctly waiting on input it cannot proceed without.

Agent's final context:
$ARGUMENTS`;

interface StopHookEntry {
	type: 'prompt';
	prompt: string;
	timeout: number;
	model: string;
	statusMessage: string;
}

interface StopHookMatcherGroup {
	hooks: StopHookEntry[];
}

export interface ClaudeCodeSettings {
	hooks: {
		Stop: StopHookMatcherGroup[];
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
							model: STOP_HOOK_JUDGE_MODEL,
							statusMessage: 'Checking work completeness...',
						},
					],
				},
			],
		},
	};
}
