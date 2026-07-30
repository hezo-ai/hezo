/**
 * Effort configuration for individual agent runs.
 *
 * A run's effective effort level is resolved at activation time with this
 * precedence (highest wins):
 *
 *   0. The CEO and team Captains always run at max effort. Strategic,
 *      delegation, and hiring decisions cascade across the org, so these
 *      leaders are never allowed to think shallow. Wakeup payloads and column
 *      defaults are ignored for them.
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
 *   - `kimi`: the `KIMI_MODEL_THINKING_EFFORT` env var. Kimi Code accepts
 *     `low|medium|high|xhigh|max`; it has no `minimal`, which maps to `low`.
 *   - `opencode` / `grok`: no stable native knob, so effort is steered through
 *     the prompt directive alone.
 */

import {
	AgentEffort,
	AgentRuntime,
	CAPTAIN_AGENT_SLUG,
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
	if (agentSlug === CAPTAIN_AGENT_SLUG || agentSlug === CEO_AGENT_SLUG) return AgentEffort.Max;
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

// Kimi Code accepts `low|medium|high|xhigh|max`. It has no `minimal`, so the
// lowest Hezo level maps to `low`; `max` maps straight through. `xhigh` is
// deliberately unused — Hezo's ladder tops out at `max`, and reaching past
// `high` for the `max` level would make the two indistinguishable.
const KIMI_THINKING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'low',
	[AgentEffort.Low]: 'low',
	[AgentEffort.Medium]: 'medium',
	[AgentEffort.High]: 'high',
	[AgentEffort.Max]: 'max',
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
		// OpenCode (`--variant`) exposes model-dependent reasoning knobs whose
		// accepted values aren't stable across versions, so steer effort through the
		// prompt directive — the portable lever every runtime honors.
		case AgentRuntime.OpenCode:
			return { extraArgs: [], extraEnv: [], promptDirective: GENERIC_PROMPT_DIRECTIVE[effort] };
		// Grok exposes `--reasoning-effort`, but its accepted values aren't
		// documented/stable across the 0.2.x betas, so steer effort through the
		// portable prompt directive like OpenCode.
		case AgentRuntime.Grok:
			return { extraArgs: [], extraEnv: [], promptDirective: GENERIC_PROMPT_DIRECTIVE[effort] };
		// Kimi Code exposes a real, documented thinking-effort knob as an env var
		// (part of the shell-read KIMI_MODEL_* family), so unlike OpenCode/Grok it
		// gets a native lever rather than prompt-only steering. The prompt directive
		// rides along too — it costs nothing and keeps behaviour consistent when a
		// model ignores the knob.
		case AgentRuntime.Kimi:
			return {
				extraArgs: [],
				extraEnv: [`KIMI_MODEL_THINKING_EFFORT=${KIMI_THINKING_EFFORT[effort]}`],
				promptDirective: GENERIC_PROMPT_DIRECTIVE[effort],
			};
	}
}
