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
 *   - `opencode`: `reasoning.effort` on the run's model in the per-run
 *     `opencode.json` (written by that runtime's MCP injector, which is the only
 *     place holding the model id the config map is keyed on).
 *   - `grok`: no stable native knob, so effort is steered through the prompt
 *     directive alone.
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

/**
 * OpenCode's models are reached through OpenRouter, whose unified `reasoning`
 * parameter takes `none|minimal|low|medium|high|xhigh|max`. Hezo's ladder is a
 * subset spelled identically, so the mapping is 1:1 - and because `none` is
 * never produced, every OpenCode run asks the model to reason.
 *
 * A model that cannot reason ignores the parameter: OpenRouter only rejects an
 * unsupported parameter when the caller sets `require_parameters`, which nothing
 * here does.
 */
export const OPENCODE_REASONING_EFFORT: Record<AgentEffort, string> = {
	[AgentEffort.Minimal]: 'minimal',
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
		// OpenCode's native knob is `reasoning.effort` on the run's model, written
		// into the per-run `opencode.json` by its MCP injector (OPENCODE_REASONING_EFFORT
		// above) — not a CLI flag, since `--variant` names a variant that has to be
		// declared in that same config first. The injector is the only place holding
		// the model id the config map is keyed on, so nothing lands in extraArgs here.
		// The prompt directive rides along as it does for Codex and Kimi.
		case AgentRuntime.OpenCode:
			return { extraArgs: [], extraEnv: [], promptDirective: GENERIC_PROMPT_DIRECTIVE[effort] };
		// Grok exposes `--reasoning-effort`, but its accepted values aren't
		// documented/stable across the 0.2.x betas, so steer effort through the
		// portable prompt directive alone.
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
