import { AgentEffort, AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { createAgentStreamParser } from '../src/services/agent-stream-parser';
import { applyEffortToRuntime } from '../src/services/effort';
import { getRuntimeStrategy, RUNTIME_STRATEGIES } from '../src/services/runtime/runtime-strategy';

describe('RUNTIME_STRATEGIES', () => {
	it('has a strategy for every AgentRuntime', () => {
		const runtimes = Object.values(AgentRuntime);
		expect(runtimes.length).toBeGreaterThan(0);
		expect(Object.keys(RUNTIME_STRATEGIES).sort()).toEqual([...runtimes].sort());
	});

	it('applyEffort matches the legacy applyEffortToRuntime for every runtime × effort', () => {
		for (const runtime of Object.values(AgentRuntime)) {
			for (const effort of Object.values(AgentEffort)) {
				expect(RUNTIME_STRATEGIES[runtime].applyEffort(effort)).toEqual(
					applyEffortToRuntime(runtime, effort),
				);
			}
		}
	});

	it('createStreamParser yields a runtime-appropriate parser', () => {
		// Claude Code parses structured stream-json; the result event captures usage.
		const cc = getRuntimeStrategy(AgentRuntime.ClaudeCode).createStreamParser();
		cc.onStdout(
			`${JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.01 })}\n`,
		);
		expect(cc.getUsage()).toEqual({ inputTokens: 10, outputTokens: 5, costCents: 1 });

		// Other runtimes pass stdout through verbatim with no usage.
		const codex = getRuntimeStrategy(AgentRuntime.Codex).createStreamParser();
		expect(codex.onStdout('plain text line\n')).toBe('plain text line\n');
		expect(codex.getUsage()).toBeNull();
	});

	it('returns fresh parser instances per call (parsers are stateful per run)', () => {
		const a = getRuntimeStrategy(AgentRuntime.ClaudeCode).createStreamParser();
		const b = getRuntimeStrategy(AgentRuntime.ClaudeCode).createStreamParser();
		expect(a).not.toBe(b);
	});

	it('delegates parser creation identically to createAgentStreamParser', () => {
		// Same passthrough behavior as the legacy factory for an unstructured runtime.
		const viaRegistry = getRuntimeStrategy(AgentRuntime.Gemini).createStreamParser();
		const viaLegacy = createAgentStreamParser(AgentRuntime.Gemini);
		expect(viaRegistry.onStdout('x\n')).toBe(viaLegacy.onStdout('x\n'));
	});
});
