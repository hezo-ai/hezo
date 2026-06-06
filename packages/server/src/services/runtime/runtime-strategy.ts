/**
 * Per-runtime behavior, keyed by `AgentRuntime`.
 *
 * This is the single registry where a new agent runtime registers the
 * behaviors that vary by runtime: how an effort level maps to the runtime's
 * native knob, and how its stdout stream is parsed into log lines. The
 * `Record<AgentRuntime, RuntimeStrategy>` typing makes adding a runtime to the
 * `AgentRuntime` enum without a strategy here a compile error.
 *
 * The strategies delegate to the existing, individually-tested implementations
 * (`applyEffortToRuntime`, `createAgentStreamParser`) rather than reimplementing
 * them, so this layer adds a uniform lookup surface without changing behavior.
 */
import { type AgentEffort, AgentRuntime } from '@hezo/shared';
import { type AgentStreamParser, createAgentStreamParser } from '../agent-stream-parser';
import { applyEffortToRuntime, type EffortRuntimeApplication } from '../effort';

export interface RuntimeStrategy {
	/** Translate a resolved effort level into the runtime's native knob. */
	applyEffort(effort: AgentEffort): EffortRuntimeApplication;
	/** Construct a fresh, stateful stdout parser for one run. */
	createStreamParser(): AgentStreamParser;
}

function strategyFor(runtime: AgentRuntime): RuntimeStrategy {
	return {
		applyEffort: (effort) => applyEffortToRuntime(runtime, effort),
		createStreamParser: () => createAgentStreamParser(runtime),
	};
}

export const RUNTIME_STRATEGIES: Record<AgentRuntime, RuntimeStrategy> = {
	[AgentRuntime.ClaudeCode]: strategyFor(AgentRuntime.ClaudeCode),
	[AgentRuntime.Codex]: strategyFor(AgentRuntime.Codex),
	[AgentRuntime.Gemini]: strategyFor(AgentRuntime.Gemini),
};

/** Behavior strategy for an agent runtime. */
export function getRuntimeStrategy(runtime: AgentRuntime): RuntimeStrategy {
	return RUNTIME_STRATEGIES[runtime];
}
