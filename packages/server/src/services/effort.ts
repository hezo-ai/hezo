/**
 * Effort configuration for individual agent runs.
 *
 * A run's effective effort level is resolved at activation time with this
 * precedence (highest wins):
 *
 *   1. An explicit `effort` value carried in the wakeup payload — typically
 *      set by the human who posted the triggering comment, or by the caller of
 *      an MCP tool that wants to ask an agent to re-think a problem.
 *   2. The agent's configured `default_effort` column.
 *   3. The global `DEFAULT_EFFORT` fallback.
 *
 * Once resolved, the effort is translated to each runtime's native knob:
 *
 *   - `claude_code`: a "think"/"ultrathink" keyword appended to the task prompt.
 *     These are the documented magic phrases Claude Code recognises to expand
 *     its thinking budget.
 *   - `codex`: the `-c model_reasoning_effort=<level>` CLI flag. Codex supports
 *     `minimal|low|medium|high`; `max` is mapped to `high`.
 *   - `gemini`: the `GEMINI_REASONING_EFFORT` env var. The Gemini CLI respects
 *     this (and callers can read it to size their `thinkingBudget` config).
 *   - `kimi`: no-op — no reasoning knob is exposed today, so effort only
 *     influences the prompt directive.
 */

import { AgentEffort, AgentRuntime, DEFAULT_EFFORT, isAgentEffort } from '@hezo/shared';

export interface EffortRuntimeApplication {
	/** Extra CLI arguments to append to the runtime command, if any. */
	extraArgs: string[];
	/** Extra `KEY=VALUE` env entries to inject, if any. */
	extraEnv: string[];
	/**
	 * A short directive to append to the task prompt, nudging the model to
	 * reason proportionally to the requested effort. Safe across all runtimes.
	 */
	promptDirective: string;
}

/**
 * Pick the effort level an agent run should use.
 *
 * `wakeupEffort` is read out of the wakeup payload before the agent run is
 * activated; `agentDefault` is the agent's configured default.
 */
export function resolveEffort(
	wakeupEffort: unknown,
	agentDefault: string | null | undefined,
): AgentEffort {
	if (isAgentEffort(wakeupEffort)) return wakeupEffort;
	if (isAgentEffort(agentDefault)) return agentDefault;
	return DEFAULT_EFFORT;
}

/**
 * Extract an effort value from a POSTed comment body. Accepts either a
 * top-level `effort` field or a nested `content.effort` field. Returns
 * `null` if none is present or the value is invalid — invalid values are
 * silently dropped so that a typo in the UI never blocks commenting.
 */
export function parseEffortFromCommentBody(body: {
	effort?: unknown;
	content?: unknown;
}): AgentEffort | null {
	if (isAgentEffort(body.effort)) return body.effort;
	if (body.content && typeof body.content === 'object') {
		const inner = (body.content as Record<string, unknown>).effort;
		if (isAgentEffort(inner)) return inner;
	}
	return null;
}

const CLAUDE_CODE_PROMPT_DIRECTIVE: Record<AgentEffort, string> = {
	// No keyword = standard thinking budget.
	[AgentEffort.Minimal]: '',
	[AgentEffort.Low]: 'think about this step by step.',
	[AgentEffort.Medium]: 'think',
	[AgentEffort.High]: 'think hard',
	[AgentEffort.Max]: 'ultrathink',
};

// Codex supports 'minimal|low|medium|high'. Map 'max' to 'high'.
const CODEX_REASONING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'minimal',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'high',
};

const GENERIC_PROMPT_DIRECTIVE: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: '',
	[AgentEffort.Low]: 'Think briefly before answering.',
	[AgentEffort.Medium]: 'Reason carefully before answering.',
	[AgentEffort.High]: 'Reason deeply and exhaustively before answering.',
	[AgentEffort.Max]:
		'Apply maximum reasoning effort: explore alternative approaches, validate assumptions, and only act once you are confident.',
};

/**
 * Translate a resolved effort level into runtime-specific knobs.
 *
 * Callers merge the returned fragments into the command they build for the
 * container exec: append `extraArgs` after the runtime command, `extraEnv`
 * onto the env list, and append `promptDirective` to the task prompt.
 */
export function applyEffortToRuntime(
	runtime: AgentRuntime,
	effort: AgentEffort,
): EffortRuntimeApplication {
	switch (runtime) {
		case AgentRuntime.ClaudeCode: {
			return {
				extraArgs: [],
				extraEnv: [],
				promptDirective: CLAUDE_CODE_PROMPT_DIRECTIVE[effort],
			};
		}
		case AgentRuntime.Codex: {
			return {
				extraArgs: ['-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT[effort]}`],
				extraEnv: [],
				promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
			};
		}
		case AgentRuntime.Gemini: {
			return {
				extraArgs: [],
				extraEnv: [`GEMINI_REASONING_EFFORT=${effort}`],
				promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
			};
		}
		case AgentRuntime.Kimi: {
			return {
				extraArgs: [],
				extraEnv: [],
				promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
			};
		}
	}
}
