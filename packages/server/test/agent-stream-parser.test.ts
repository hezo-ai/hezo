import { AgentRuntime, type CostTokens, costCentsFromRate, type ModelRate } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { createAgentStreamParser, type PriceModelFn } from '../src/services/agent-stream-parser';

/** A price function backed by a fixed rate table, mirroring PricingService. */
const RATES: Record<string, ModelRate> = {
	'claude-x': {
		inputPerToken: 0.001,
		outputPerToken: 0.002,
		cacheReadPerToken: 0.0001,
		cacheCreationPerToken: 0.002,
	},
	'codex-x': { inputPerToken: 0.00001, outputPerToken: 0.00003, cacheReadPerToken: 0.000001 },
	'gemini-2.5-pro': {
		inputPerToken: 0.00001,
		outputPerToken: 0.00003,
		cacheReadPerToken: 0.000001,
	},
	'gemini-2.5-flash': { inputPerToken: 0.000005, outputPerToken: 0.00001 },
};
const price: PriceModelFn = (model: string | undefined, tokens: CostTokens) => {
	const rate = model ? RATES[model] : undefined;
	return rate ? costCentsFromRate(rate, tokens) : 0;
};

describe('agent-stream-parser', () => {
	it('buffers partial lines and parses when a newline arrives', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const event = { type: 'system', subtype: 'init', model: 'claude-x', tools: [] };
		const serialized = JSON.stringify(event);
		const half = Math.floor(serialized.length / 2);

		expect(parser.onStdout(serialized.slice(0, half))).toBe('');
		const second = parser.onStdout(`${serialized.slice(half)}\n`);
		expect(second).toBe('[session] model=claude-x tools=0\n');
	});

	it('renders tool calls with condensed input preview', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const event = {
			type: 'assistant',
			message: {
				role: 'assistant',
				content: [
					{
						type: 'tool_use',
						id: 't1',
						name: 'Edit',
						input: { file_path: '/src/a.ts', old_string: 'foo', new_string: 'bar' },
					},
				],
			},
		};
		const out = parser.onStdout(`${JSON.stringify(event)}\n`);
		expect(out).toContain('[tool] Edit(');
		expect(out).toContain('file_path=/src/a.ts');
		expect(out).toContain('old_string=foo');
		expect(out).toContain('new_string=bar');
	});

	it('renders tool errors distinctly from tool results', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const event = {
			type: 'user',
			message: {
				role: 'user',
				content: [
					{
						type: 'tool_result',
						tool_use_id: 't1',
						is_error: true,
						content: 'ENOENT: missing file',
					},
				],
			},
		};
		const out = parser.onStdout(`${JSON.stringify(event)}\n`);
		expect(out).toContain('[tool-error] ENOENT: missing file');
	});

	it('captures usage and computes cost from the pricing table (not total_cost_usd)', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, price);
		// The model arrives on the init event; the parser needs it to price the run.
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', tools: [] })}\n`,
		);
		const event = {
			type: 'result',
			subtype: 'success',
			duration_ms: 2000,
			num_turns: 3,
			is_error: false,
			total_cost_usd: 0.4567,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: 20,
				cache_read_input_tokens: 30,
			},
		};
		const out = parser.onStdout(`${JSON.stringify(event)}\n`);
		// total_cost_usd is still echoed in the log line as a cross-check…
		expect(out).toContain('[done] success turns=3 duration=2000ms tokens=150/50 cost=$0.4567');

		const usage = parser.getUsage();
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(150);
		expect(usage?.outputTokens).toBe(50);
		// …but the persisted cost is computed from the table, pricing the cache
		// buckets separately: 100*0.001 + 30*0.0001 + 20*0.002 + 50*0.002
		//   = 0.1 + 0.003 + 0.04 + 0.1 = 0.243 → 24 cents (not the 46c of total_cost_usd).
		expect(usage?.costCents).toBe(24);
	});

	it('passes through lines that fail to parse as JSON', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = parser.onStdout('not json at all\n');
		expect(out).toBe('not json at all\n');
	});

	it('flushes a trailing line that has no newline', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.onStdout('tail without newline')).toBe('');
		expect(parser.flush()).toBe('tail without newline\n');
	});

	describe('codex', () => {
		it('captures usage from the turn.completed event', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const event = {
				type: 'turn.completed',
				usage: {
					input_tokens: 24763,
					cached_input_tokens: 24448,
					output_tokens: 122,
					reasoning_output_tokens: 8,
				},
			};
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			// cached_input_tokens is a subset of input_tokens; reasoning is billed output.
			expect(out).toContain('[done] success turns=1 tokens=24763/130');

			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(24763);
			expect(usage?.outputTokens).toBe(130);
			expect(usage?.costCents).toBe(0);
		});

		it('marks a failed turn as error', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const event = { type: 'turn.failed', usage: { input_tokens: 10, output_tokens: 2 } };
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			expect(out).toContain('[done] error turns=1 tokens=10/2');
			expect(parser.getUsage()?.outputTokens).toBe(2);
		});

		it('renders an agent message item as plain text', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const event = {
				type: 'item.completed',
				item: { type: 'agent_message', text: 'Hello world' },
			};
			expect(parser.onStdout(`${JSON.stringify(event)}\n`)).toBe('Hello world\n');
		});

		it('renders a command execution as a tool call and result', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const event = {
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'ls -la',
					aggregated_output: 'file1\nfile2',
					exit_code: 0,
				},
			};
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			expect(out).toContain('[tool] shell(ls -la)');
			expect(out).toContain('[tool-result] file1 file2');
		});

		it('buffers a turn.completed split across chunks', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const serialized = JSON.stringify({
				type: 'turn.completed',
				usage: { input_tokens: 5, output_tokens: 7 },
			});
			const half = Math.floor(serialized.length / 2);
			expect(parser.onStdout(serialized.slice(0, half))).toBe('');
			parser.onStdout(`${serialized.slice(half)}\n`);
			expect(parser.getUsage()).toEqual({ inputTokens: 5, outputTokens: 7, costCents: 0 });
		});

		it('drops unknown events instead of emitting raw JSON', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			expect(parser.onStdout(`${JSON.stringify({ type: 'turn.started' })}\n`)).toBe('');
		});
	});

	describe('gemini', () => {
		it('captures usage from the result event', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			const event = {
				type: 'result',
				stats: {
					models: {
						'gemini-2.5-pro': {
							tokens: { prompt: 24939, candidates: 20, thoughts: 154, total: 25113, cached: 21263 },
						},
					},
				},
			};
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			// input = prompt; output = candidates + thoughts (cached is a subset of prompt).
			expect(out).toContain('[done] success tokens=24939/174');

			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(24939);
			expect(usage?.outputTokens).toBe(174);
			expect(usage?.costCents).toBe(0);
		});

		it('sums usage across multiple models', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			const event = {
				type: 'result',
				stats: {
					models: {
						'gemini-2.5-pro': { tokens: { prompt: 1000, candidates: 100, thoughts: 0 } },
						'gemini-2.5-flash': { tokens: { prompt: 200, candidates: 50, thoughts: 10 } },
					},
				},
			};
			parser.onStdout(`${JSON.stringify(event)}\n`);
			expect(parser.getUsage()).toEqual({ inputTokens: 1200, outputTokens: 160, costCents: 0 });
		});

		it('renders an assistant message and skips the user echo', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			expect(
				parser.onStdout(`${JSON.stringify({ type: 'message', role: 'user', content: 'hi' })}\n`),
			).toBe('');
			expect(
				parser.onStdout(
					`${JSON.stringify({ type: 'message', role: 'assistant', content: 'Done.' })}\n`,
				),
			).toBe('Done.\n');
		});

		it('renders the init event as a session line', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			const out = parser.onStdout(`${JSON.stringify({ type: 'init', model: 'gemini-2.5-pro' })}\n`);
			expect(out).toBe('[session] model=gemini-2.5-pro tools=0\n');
		});
	});

	describe('cost from the pricing table', () => {
		it('prices a codex run, charging cached input at the cache-read rate', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex, price);
			parser.onStdout(`${JSON.stringify({ type: 'thread.started', model: 'codex-x' })}\n`);
			parser.onStdout(
				`${JSON.stringify({
					type: 'turn.completed',
					usage: {
						input_tokens: 24763,
						cached_input_tokens: 24448,
						output_tokens: 122,
						reasoning_output_tokens: 8,
					},
				})}\n`,
			);
			// regular=315@1e-5, cacheRead=24448@1e-6, output=130@3e-5
			//   = 0.00315 + 0.024448 + 0.0039 = 0.031498 → 3 cents
			expect(parser.getUsage()?.costCents).toBe(3);
		});

		it('prices a gemini run per model and sums', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini, price);
			parser.onStdout(
				`${JSON.stringify({
					type: 'result',
					stats: {
						models: {
							'gemini-2.5-pro': { tokens: { prompt: 1_000_000, candidates: 200_000, thoughts: 0 } },
							'gemini-2.5-flash': { tokens: { prompt: 200_000, candidates: 100_000, thoughts: 0 } },
						},
					},
				})}\n`,
			);
			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(1_200_000);
			expect(usage?.outputTokens).toBe(300_000);
			// pro: 1e6*1e-5 + 2e5*3e-5 = 16.0 → 1600c; flash: 2e5*5e-6 + 1e5*1e-5 = 2.0 → 200c
			expect(usage?.costCents).toBe(1800);
		});

		it('records 0 cost for an unpriced model', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex, price);
			parser.onStdout(`${JSON.stringify({ type: 'thread.started', model: 'unknown-xyz' })}\n`);
			parser.onStdout(
				`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9999, output_tokens: 9999 } })}\n`,
			);
			expect(parser.getUsage()?.costCents).toBe(0);
		});
	});
});
