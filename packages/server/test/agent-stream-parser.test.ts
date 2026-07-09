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

	it('ignores the runtime-reported total_cost_usd and prices from the table', () => {
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

		const usage = parser.getUsage();
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(150);
		expect(usage?.outputTokens).toBe(50);
		// The reported 0.4567 is a client-side estimate and is discarded; the table
		// prices the buckets: 100*0.001 + 30*0.0001 + 20*0.002 + 50*0.002 = 0.243 → 24c.
		expect(usage?.costCents).toBe(24);
		expect(out).toContain('[done] success turns=3 duration=2000ms tokens=150/50 cost=$0.2400');
	});

	it('prices from the table when Claude Code reports no total_cost_usd', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, price);
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', tools: [] })}\n`,
		);
		// No total_cost_usd on the terminal event (e.g. an interrupted run) — pricing
		// is unchanged, since only the token buckets matter.
		const event = {
			type: 'result',
			subtype: 'success',
			duration_ms: 2000,
			num_turns: 3,
			is_error: false,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: 20,
				cache_read_input_tokens: 30,
			},
		};
		const out = parser.onStdout(`${JSON.stringify(event)}\n`);

		const usage = parser.getUsage();
		expect(usage?.costCents).toBe(24);
		expect(out).toContain('tokens=150/50 cost=$0.2400');
	});

	it('discards a third-party endpoint total_cost_usd — an unpriced model records $0', () => {
		// Event shape captured from a real DeepSeek-via-Claude-Code run: the
		// Anthropic-compatible endpoint returns a total_cost_usd computed with the
		// CLI's own (wrong-provider) rate card. It must be ignored; with no table
		// rate for the model the run prices to $0 (fail-low), never to the estimate.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, price);
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'deepseek-v4-flash', tools: [] })}\n`,
		);
		const event = {
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 3276,
			num_turns: 1,
			result: 'ok',
			total_cost_usd: 0.100855,
			usage: {
				input_tokens: 20096,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 15,
			},
		};
		const out = parser.onStdout(`${JSON.stringify(event)}\n`);
		const usage = parser.getUsage();
		expect(usage?.inputTokens).toBe(20096);
		expect(usage?.outputTokens).toBe(15);
		expect(usage?.costCents).toBe(0);
		expect(out).toContain('tokens=20096/15 cost=$0.0000');
	});

	it('accumulates running usage from assistant turns before the terminal result', () => {
		// A run interrupted before its `result` event (e.g. a server restart) must
		// still report the tokens it burned. The parser sums each assistant turn's
		// usage so getUsage() is non-null mid-stream.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, price);
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', tools: [] })}\n`,
		);
		// No usage seen yet — nothing to report.
		expect(parser.getUsage()).toBeNull();

		const assistantTurn = {
			type: 'assistant',
			message: {
				role: 'assistant',
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 5,
				},
				content: [{ type: 'text', text: 'working' }],
			},
		};
		parser.onStdout(`${JSON.stringify(assistantTurn)}\n`);
		parser.onStdout(`${JSON.stringify(assistantTurn)}\n`);

		const usage = parser.getUsage();
		expect(usage).not.toBeNull();
		// Aggregate keeps every input bucket: (100 + 10 + 5) summed across two turns.
		expect(usage?.inputTokens).toBe(230);
		expect(usage?.outputTokens).toBe(40);
		expect(usage?.costCents).toBeGreaterThan(0);
	});

	it('the terminal result replaces the running usage with the authoritative total', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, price);
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', tools: [] })}\n`,
		);
		parser.onStdout(
			`${JSON.stringify({
				type: 'assistant',
				message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 20 } },
			})}\n`,
		);
		parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: false,
				total_cost_usd: 0.1,
				usage: { input_tokens: 150, output_tokens: 50 },
			})}\n`,
		);
		const usage = parser.getUsage();
		// Authoritative cumulative figure from `result`, not the 100/20 running sum.
		expect(usage?.inputTokens).toBe(150);
		expect(usage?.outputTokens).toBe(50);
	});

	it('captures a provider billing rejection as the run terminal error', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.getTerminalError()).toBeNull();
		parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				is_error: true,
				result: 'API Error: 402 Insufficient Balance',
				usage: {},
			})}\n`,
		);
		const reason = parser.getTerminalError();
		expect(reason).toContain('credit/quota');
		expect(reason).toContain('API Error: 402 Insufficient Balance');
	});

	it('captures a provider auth rejection as the run terminal error', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				is_error: true,
				result: 'Not logged in · Please run /login',
				usage: {},
			})}\n`,
		);
		expect(parser.getTerminalError()).toContain('authentication failed');
	});

	it('leaves the terminal error null for a successful run', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(
			`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: {} })}\n`,
		);
		expect(parser.getTerminalError()).toBeNull();
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

		it('ignores a runtime-reported cost and prices from the table', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex, price);
			parser.onStdout(`${JSON.stringify({ type: 'thread.started', model: 'codex-x' })}\n`);
			parser.onStdout(
				`${JSON.stringify({
					type: 'turn.completed',
					total_cost_usd: 0.5,
					usage: { input_tokens: 1000, output_tokens: 100 },
				})}\n`,
			);
			// The reported 0.5 USD is discarded; the table prices the tokens:
			// 1000*0.00001 + 100*0.00003 = $0.013 → 1 cent.
			expect(parser.getUsage()?.costCents).toBe(1);
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

		it('ignores a runtime-reported cost and prices the per-model table sum', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini, price);
			parser.onStdout(
				`${JSON.stringify({
					type: 'result',
					total_cost_usd: 0.5,
					stats: {
						models: { 'gemini-2.5-pro': { tokens: { prompt: 1_000_000, candidates: 200_000 } } },
					},
				})}\n`,
			);
			// The reported 0.5 USD is discarded; the per-model table sum prices the
			// tokens: 1e6*0.00001 + 2e5*0.00003 = $16 → 1600 cents.
			expect(parser.getUsage()?.costCents).toBe(1600);
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

describe('agent-stream-parser — generic (opencode)', () => {
	it('renders assistant text from a loosely-shaped event', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify({ type: 'message', role: 'assistant', text: 'Hello there' })}\n`,
		);
		expect(out).toBe('Hello there\n');
	});

	it('skips user-role messages', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify({ type: 'message', role: 'user', text: 'the prompt' })}\n`,
		);
		expect(out).toBe('');
	});

	it('renders a tool call with a condensed input preview', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify({ type: 'tool_use', name: 'bash', input: { command: 'ls -la' } })}\n`,
		);
		expect(out).toContain('[tool] bash(');
		expect(out).toContain('command=ls -la');
	});

	it('captures token usage and prices it from a terminal event', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, price);
		parser.onStdout(`${JSON.stringify({ type: 'init', model: 'gemini-2.5-flash' })}\n`);
		const out = parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				usage: { input_tokens: 1000, output_tokens: 200 },
			})}\n`,
		);
		expect(out).toBe('[done] success tokens=1000/200\n');
		const usage = parser.getUsage();
		expect(usage?.inputTokens).toBe(1000);
		expect(usage?.outputTokens).toBe(200);
		// 1000 * 0.000005 + 200 * 0.00001 = 0.005 + 0.002 = 0.007 USD = 0.7 cents → round 1.
		expect(usage?.costCents).toBe(1);
	});

	it('ignores a provider-reported usd cost in favor of computed pricing', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, price);
		const out = parser.onStdout(
			`${JSON.stringify({
				type: 'turn.completed',
				total_cost_usd: 0.25,
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			})}\n`,
		);
		expect(out).toBe('[done] success tokens=10/5\n');
		// No model was announced, so the table prices to 0 — the reported figure
		// never substitutes for it.
		expect(parser.getUsage()?.costCents).toBe(0);
	});

	it('drops unrecognized structured events instead of dumping raw JSON', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(`${JSON.stringify({ type: 'session.status', status: 'busy' })}\n`);
		expect(out).toBe('');
	});
});

describe('getFinalAssistantMessage', () => {
	it('captures the Claude Code result event as the final message', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.getFinalAssistantMessage()).toBeNull();
		parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: '@admin — Higgsfield is broken, which way do you want to go?',
				usage: { input_tokens: 5, output_tokens: 3 },
			})}\n`,
		);
		expect(parser.getFinalAssistantMessage()).toBe(
			'@admin — Higgsfield is broken, which way do you want to go?',
		);
	});

	it('falls back to the last assistant text block when no result event arrives', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const assistant = (text: string) =>
			`${JSON.stringify({
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text }] },
			})}\n`;
		parser.onStdout(assistant('first pass'));
		parser.onStdout(assistant('handing off to @architect now'));
		// Last assistant message wins; no `result` event was emitted.
		expect(parser.getFinalAssistantMessage()).toBe('handing off to @architect now');
	});

	it('does not take an error result as the final message', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				subtype: 'error',
				is_error: true,
				result: 'API Error: 529 overloaded',
			})}\n`,
		);
		expect(parser.getFinalAssistantMessage()).toBeNull();
	});

	it('captures the Codex final agent_message', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		parser.onStdout(
			`${JSON.stringify({
				type: 'item.completed',
				item: { type: 'agent_message', text: 'done — over to you @admin' },
			})}\n`,
		);
		expect(parser.getFinalAssistantMessage()).toBe('done — over to you @admin');
	});

	it('captures the Gemini final assistant message and ignores user turns', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		parser.onStdout(`${JSON.stringify({ type: 'message', role: 'user', content: 'ignored' })}\n`);
		parser.onStdout(
			`${JSON.stringify({ type: 'message', role: 'assistant', content: 'ready for @admin review' })}\n`,
		);
		expect(parser.getFinalAssistantMessage()).toBe('ready for @admin review');
	});

	it('captures the OpenCode/generic final assistant text', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		parser.onStdout(
			`${JSON.stringify({ type: 'message', role: 'assistant', content: 'blocked — @admin please advise' })}\n`,
		);
		expect(parser.getFinalAssistantMessage()).toBe('blocked — @admin please advise');
	});
});
