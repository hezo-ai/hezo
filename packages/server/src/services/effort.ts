/**
 * Effort configuration for individual agent runs.
 *
 * A run's effective effort level is resolved at activation time with this
 * precedence (highest wins). The CEO and Captain are seeded at max effort, and
 * an operator who changes that setting gets what they set:
 *
 *   1. An explicit `effort` value carried in the wakeup payload — typically
 *      set by the human who posted the triggering comment, or by the caller of
 *      an MCP tool that wants to ask an agent to re-think a problem.
 *   2. The agent's configured `default_effort` column.
 *   3. The global `DEFAULT_EFFORT` fallback.
 *
 * Once resolved, the effort is translated to each runtime's native knob:
 *
 *   - `claude_code`: the `--effort <low|medium|high|max>` CLI flag. It has no
 *     `minimal`, which maps to `low`.
 *   - `codex`: the `-c model_reasoning_effort=<level>` CLI flag, sent upstream
 *     unchanged. Its model catalog lists no `minimal`, which maps to `low`, and
 *     lacks `max` on the pinned models, so `max` maps to `xhigh`.
 *   - `kimi`: the `KIMI_MODEL_THINKING_EFFORT` env var. Kimi Code accepts
 *     `low|medium|high|xhigh|max`; it has no `minimal`, which maps to `low`.
 *   - `opencode`: `reasoning.effort` on the run's model in the per-run
 *     `opencode.json` (written by that runtime's MCP injector, which is the only
 *     place holding the model id the config map is keyed on).
 *   - `grok`: no stable native knob, so effort is steered through the prompt
 *     directive alone.
 */

import { AgentEffort, AgentRuntime, DEFAULT_EFFORT, isAgentEffort } from '@hezo/shared';

export interface EffortRuntimeApplication {
	extraArgs: string[];
	extraEnv: string[];
	promptDirective: string;
}

export function resolveEffort(
	wakeupEffort: unknown,
	agentDefault: string | null | undefined,
): AgentEffort {
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

export const GENERIC_PROMPT_DIRECTIVE: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: '',
	[AgentEffort.Low]: 'Think briefly before answering.',
	[AgentEffort.Medium]: 'Reason carefully before answering.',
	[AgentEffort.High]: 'Reason deeply and exhaustively before answering.',
	[AgentEffort.Max]:
		'Apply maximum reasoning effort: explore alternative approaches, validate assumptions, and only act once you are confident.',
};
