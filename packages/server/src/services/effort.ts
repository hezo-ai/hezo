/**
 * Effort configuration for individual agent runs.
 *
 * A run's effective effort level is resolved at activation time with this
 * precedence (highest wins):
 *
 *   0. The CEO always runs at max effort. Strategic, delegation, and hiring
 *      decisions cascade to the whole org, so the CEO is never allowed to
 *      think shallow. Wakeup payloads and column defaults are ignored for the
 *      CEO.
 *   1. An explicit `effort` value carried in the wakeup payload — typically
 *      set by the human who posted the triggering comment, or by the caller of
 *      an MCP tool that wants to ask an agent to re-think a problem.
 *   2. The agent's configured `default_effort` column.
 *   3. The global `DEFAULT_EFFORT` fallback.
 *
 * Once resolved, the effort is translated to each runtime's native knob:
 *
 *   - `claude_code`: a "think"/"ultrathink" keyword appended to the task prompt.
 *   - `codex`: the `-c model_reasoning_effort=<level>` CLI flag. Codex supports
 *     `minimal|low|medium|high`; `max` is mapped to `high`.
 *   - `gemini`: the `GEMINI_REASONING_EFFORT` env var.
 */

import {
	AgentEffort,
	AgentRuntime,
	CEO_AGENT_SLUG,
	DEFAULT_EFFORT,
	isAgentEffort,
} from '@hezo/shared';

export interface EffortRuntimeApplication {
	extraArgs: string[];
	extraEnv: string[];
	promptDirective: string;
}

export function resolveEffort(
	wakeupEffort: unknown,
	agentDefault: string | null | undefined,
	agentSlug?: string | null,
): AgentEffort {
	if (agentSlug === CEO_AGENT_SLUG) return AgentEffort.Max;
	if (isAgentEffort(wakeupEffort)) return wakeupEffort;
	if (isAgentEffort(agentDefault)) return agentDefault;
	return DEFAULT_EFFORT;
}

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
	[AgentEffort.Minimal]: '',
	[AgentEffort.Low]: 'think about this step by step.',
	[AgentEffort.Medium]: 'think',
	[AgentEffort.High]: 'think hard',
	[AgentEffort.Max]: 'ultrathink',
};

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

export function applyEffortToRuntime(
	runtime: AgentRuntime,
	effort: AgentEffort,
): EffortRuntimeApplication {
	switch (runtime) {
		case AgentRuntime.ClaudeCode:
			return { extraArgs: [], extraEnv: [], promptDirective: CLAUDE_CODE_PROMPT_DIRECTIVE[effort] };
		case AgentRuntime.Codex:
			return {
				extraArgs: ['-c', `model_reasoning_effort=${CODEX_REASONING_EFFORT[effort]}`],
				extraEnv: [],
				promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
			};
		case AgentRuntime.Gemini:
			return {
				extraArgs: [],
				extraEnv: [`GEMINI_REASONING_EFFORT=${effort}`],
				promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
			};
	}
}
