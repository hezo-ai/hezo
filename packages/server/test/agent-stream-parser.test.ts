import { AgentRuntime, type CostTokens, costCentsFromRate, type ModelRate } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	createAgentStreamParser,
	extractGrokUsageFromDebugLog,
	extractKimiUsageFromSessionLog,
	type PriceModelFn,
} from '../src/services/agent-stream-parser';

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
	'grok-4.5': { inputPerToken: 0.00001, outputPerToken: 0.00003, cacheReadPerToken: 0.000001 },
	'kimi-k2.7-code': {
		inputPerToken: 0.0000074,
		outputPerToken: 0.0000035,
		cacheReadPerToken: 0.0000002,
		cacheCreationPerToken: 0.000001,
	},
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

		it('renders an mcp tool call as a call line and its result', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			// The shape Codex actually emits: the tool is named by server + tool, and the
			// item carries its own outcome, so both lines come from the one event.
			const event = {
				type: 'item.completed',
				item: {
					type: 'mcp_tool_call',
					server: 'hezo',
					tool: 'get_skill',
					arguments: { slug: 'deep-research' },
					status: 'completed',
					result: { content: [{ type: 'text', text: 'Skill body' }] },
				},
			};
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			// mcp__<server>__<tool> is Claude Code's naming, so the log view renders both
			// runtimes' MCP calls through the same display.
			expect(out).toBe(
				'[tool] mcp__hezo__get_skill(slug=deep-research)\n[tool-result] Skill body\n',
			);
		});

		it('renders a failed mcp tool call as a tool-error', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const event = {
				type: 'item.completed',
				item: {
					type: 'mcp_tool_call',
					server: 'hezo',
					tool: 'read_project_doc',
					arguments: { filename: 'missing.md' },
					status: 'failed',
					error: { message: 'document not found' },
				},
			};
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			expect(out).toBe(
				'[tool] mcp__hezo__read_project_doc(filename=missing.md)\n[tool-error] document not found\n',
			);
		});

		it('resolves every tool call in a mixed run, in order', () => {
			// The regression this guards: the client pairs results with calls FIFO and has
			// no correlation id, so one call left without a result silently attaches the
			// NEXT call's result to it and misreports every tool after it.
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const mcp = (tool: string, text: string) => ({
				type: 'item.completed',
				item: {
					type: 'mcp_tool_call',
					server: 'hezo',
					tool,
					arguments: {},
					status: 'completed',
					result: { content: [{ type: 'text', text }] },
				},
			});
			const shell = {
				type: 'item.completed',
				item: {
					type: 'command_execution',
					command: 'ls',
					aggregated_output: 'file1',
					exit_code: 0,
				},
			};
			const out = [mcp('get_task', 'first'), shell, mcp('list_comments', 'second')]
				.map((e) => parser.onStdout(`${JSON.stringify(e)}\n`))
				.join('');
			expect(out.split('\n').filter(Boolean)).toEqual([
				'[tool] mcp__hezo__get_task()',
				'[tool-result] first',
				'[tool] shell(ls)',
				'[tool-result] file1',
				'[tool] mcp__hezo__list_comments()',
				'[tool-result] second',
			]);
		});

		it('omits a tool count it was never given', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			// Codex's thread.started carries only a thread id. A hardcoded `tools=0` here
			// read as a measured zero in the log header.
			const out = parser.onStdout(
				`${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n`,
			);
			expect(out).toBe('[session] model=codex\n');
			expect(out).not.toContain('tools=');
		});

		it('prices from the run model when the stream names none', () => {
			// Codex never names a model, so without the run-model floor every Codex run
			// priced at $0.
			const parser = createAgentStreamParser(AgentRuntime.Codex, price, 'codex-x');
			const out = parser.onStdout(
				`${JSON.stringify({ type: 'thread.started', thread_id: 't1' })}\n`,
			);
			expect(out).toBe('[session] model=codex-x\n');
			parser.onStdout(
				`${JSON.stringify({
					type: 'turn.completed',
					usage: { input_tokens: 1000, output_tokens: 100 },
				})}\n`,
			);
			// 1000*0.00001 + 100*0.00003 = $0.013 → 1 cent.
			expect(parser.getUsage()?.costCents).toBe(1);
		});

		it('lets a model named on the stream win over the run model', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex, price, 'stale-model');
			const out = parser.onStdout(
				`${JSON.stringify({ type: 'thread.started', model: 'codex-x' })}\n`,
			);
			expect(out).toBe('[session] model=codex-x\n');
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

		// The shape the CLI actually writes: `convertToStreamStats` flattens its
		// internal token object into `*_tokens` names and drops the reasoning
		// bucket entirely. Reading only the nested form found nothing here, so every
		// Gemini run reported 0/0 and priced at $0.
		it('captures usage from the flattened per-model stats the CLI emits', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini, price);
			parser.onStdout(
				`${JSON.stringify({
					type: 'result',
					stats: {
						total_tokens: 94109,
						input_tokens: 93507,
						output_tokens: 22,
						cached: 40586,
						input: 52921,
						models: {
							'gemini-2.5-pro': {
								total_tokens: 94109,
								input_tokens: 93507,
								output_tokens: 22,
								cached: 40586,
								input: 52921,
							},
						},
					},
				})}\n`,
			);
			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(93507);
			// The visible answer plus the reasoning the flat projection leaves as the
			// residual between the total and the two counts it does state.
			expect(usage?.outputTokens).toBe(602);
			// Priced, not $0: (93507-40586) full-rate input + 40586 cache-read + 602 output.
			expect(usage?.costCents).toBeGreaterThan(0);
		});

		it('joins the assistant chunks the CLI streams into one final message', () => {
			// A `HEZO-LIVE-OK` reply arrives as `HEZO-LIVE-` then `OK`. Treating each
			// `message` as complete left the final message as the last fragment, which
			// the runner's handoff net would then post verbatim in place of the answer.
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			parser.onStdout(
				`${JSON.stringify({ type: 'message', role: 'assistant', content: 'HEZO-LIVE-' })}\n`,
			);
			parser.onStdout(`${JSON.stringify({ type: 'message', role: 'assistant', content: 'OK' })}\n`);
			const out = parser.onStdout(`${JSON.stringify({ type: 'result', stats: {} })}\n`);
			expect(out).toContain('HEZO-LIVE-OK');
			expect(parser.getFinalAssistantMessage()).toBe('HEZO-LIVE-OK');
		});

		it('recovers a final message still buffered when the stream just stops', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			parser.onStdout(
				`${JSON.stringify({ type: 'message', role: 'assistant', content: 'all done' })}\n`,
			);
			expect(parser.getFinalAssistantMessage()).toBe('all done');
		});

		it('renders an assistant message and skips the user echo', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			expect(
				parser.onStdout(`${JSON.stringify({ type: 'message', role: 'user', content: 'hi' })}\n`),
			).toBe('');
			// Assistant text is buffered until the run of chunks ends, so it renders
			// as one line on the next event rather than one line per chunk.
			expect(
				parser.onStdout(
					`${JSON.stringify({ type: 'message', role: 'assistant', content: 'Done.' })}\n`,
				),
			).toBe('');
			expect(parser.onStdout(`${JSON.stringify({ type: 'result', stats: {} })}\n`)).toContain(
				'Done.',
			);
		});

		it('renders the init event as a session line', () => {
			const parser = createAgentStreamParser(AgentRuntime.Gemini);
			const out = parser.onStdout(`${JSON.stringify({ type: 'init', model: 'gemini-2.5-pro' })}\n`);
			expect(out).toBe('[session] model=gemini-2.5-pro\n');
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

	// The shape a real run emits: per-step counts nested under `part`, with the
	// cache halves in their own object. Probing only the event root found nothing,
	// so every OpenCode run priced at $0.
	const STEP_FINISHES = [
		{
			type: 'step_finish',
			part: {
				type: 'step-finish',
				tokens: {
					total: 44557,
					input: 3,
					output: 40,
					reasoning: 0,
					cache: { write: 44514, read: 0 },
				},
				cost: 0.0558455,
			},
		},
		{
			type: 'step_finish',
			part: {
				type: 'step-finish',
				tokens: {
					total: 44797,
					input: 5,
					output: 11,
					reasoning: 0,
					cache: { write: 267, read: 44514 },
				},
				cost: 0.00484515,
			},
		},
	];

	it('sums per-step usage nested under part, including both cache buckets', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		for (const e of STEP_FINISHES) parser.onStdout(`${JSON.stringify(e)}\n`);
		const usage = parser.getUsage();
		// Every step counted, not just the last: 3+5 fresh input, 44514+267 cache
		// writes and 0+44514 cache reads all read as input the run paid for.
		expect(usage?.inputTokens).toBe(8 + 44_781 + 44_514);
		expect(usage?.outputTokens).toBe(51);
	});

	it('prices from the run model when the stream names none', () => {
		// OpenCode announces no model anywhere, so without the run's own model
		// there is nothing to look up and the run prices at $0 whatever it spent.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, price, 'gemini-2.5-flash');
		for (const e of STEP_FINISHES) parser.onStdout(`${JSON.stringify(e)}\n`);
		expect(parser.getUsage()?.costCents).toBeGreaterThan(0);
	});

	it('ignores the run model once the stream names one', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, price, 'not-in-the-table');
		parser.onStdout(`${JSON.stringify({ type: 'init', model: 'gemini-2.5-flash' })}\n`);
		for (const e of STEP_FINISHES) parser.onStdout(`${JSON.stringify(e)}\n`);
		expect(parser.getUsage()?.costCents).toBeGreaterThan(0);
	});

	// A completed tool call as OpenCode reports it: one event per call, arriving
	// only once the call has finished, with the arguments and the output together
	// on `part.state`.
	const toolUse = (over: Record<string, unknown> = {}) => ({
		type: 'tool_use',
		part: {
			type: 'tool',
			callID: 'call_1',
			tool: 'hezo_list_comments',
			state: {
				status: 'completed',
				input: { task_id: 'HEZO-12' },
				output: 'comment 1\ncomment 2',
				title: 'List comments',
				...over,
			},
		},
	});

	it('renders a completed tool call and its result as a pair', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(`${JSON.stringify(toolUse())}\n`);
		// The pair is what `parse-agent-log.ts` matches FIFO to turn the viewer's
		// status dot green; a lone `[tool]` line leaves it pending forever.
		expect(out).toBe(
			'[tool] hezo_list_comments(task_id=HEZO-12)\n[tool-result] comment 1 comment 2\n',
		);
	});

	it('renders a failed tool call as a tool-error carrying its message', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify(toolUse({ status: 'error', output: undefined, error: 'task not found' }))}\n`,
		);
		expect(out).toBe('[tool] hezo_list_comments(task_id=HEZO-12)\n[tool-error] task not found\n');
	});

	it('emits a bare tool-result label when the call produced no output', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(`${JSON.stringify(toolUse({ output: '' }))}\n`);
		expect(out).toBe('[tool] hezo_list_comments(task_id=HEZO-12)\n[tool-result]\n');
	});

	it('still renders a lone tool line for an event carrying no state', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify({ type: 'tool_use', name: 'bash', input: { command: 'ls' } })}\n`,
		);
		expect(out).toBe('[tool] bash(command=ls)\n');
	});

	// OpenCode emits a step_finish per step. Only the last one is the run's
	// summary; the intermediate ones used to render a full-width success banner
	// between every pair of tool calls.
	const stepFinish = (reason: string, input: number, output: number) => ({
		type: 'step_finish',
		part: { type: 'step-finish', reason, tokens: { input, output, cache: { read: 0, write: 0 } } },
	});

	it('renders one done line for the terminal step, not one per step', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(parser.onStdout(`${JSON.stringify(stepFinish('tool-calls', 100, 10))}\n`)).toBe('');
		expect(parser.onStdout(`${JSON.stringify(stepFinish('tool-calls', 200, 20))}\n`)).toBe('');
		// The line carries the whole run's totals, so suppressing the intermediate
		// steps must not have dropped their counts.
		expect(parser.onStdout(`${JSON.stringify(stepFinish('stop', 300, 30))}\n`)).toBe(
			'[done] success tokens=600/60\n',
		);
		expect(parser.flush()).toBe('');
	});

	it('reports an error reason on the done line', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(parser.onStdout(`${JSON.stringify(stepFinish('error', 5, 1))}\n`)).toBe(
			'[done] error tokens=5/1\n',
		);
	});

	it('writes the done line on flush when the terminal step never arrived', () => {
		// OpenCode is documented to exit before its final step_finish under some
		// container setups; without this the run would show no summary at all.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(parser.onStdout(`${JSON.stringify(stepFinish('tool-calls', 100, 10))}\n`)).toBe('');
		expect(parser.flush()).toBe('[done] success tokens=100/10\n');
	});

	it('writes no done line on flush when the run reported no usage at all', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		parser.onStdout(`${JSON.stringify({ type: 'message', text: 'hi' })}\n`);
		expect(parser.flush()).toBe('');
	});

	it('renders a reasoning block whose text sits on the part', () => {
		// `--thinking` puts these on the stream; a root-only probe found nothing
		// and dropped every thinking block the run produced.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify({ type: 'reasoning', part: { type: 'reasoning', text: 'weighing it up' } })}\n`,
		);
		expect(out).toBe('[thinking] weighing it up\n');
	});

	// A rejected provider credential, exactly as the CLI reports it: the message
	// is nested under `error.data`, which a probe reading only `error.message`
	// found empty - so the event rendered nothing and the run failed in silence.
	const apiError = {
		type: 'error',
		timestamp: 1,
		sessionID: 'ses_x',
		error: {
			name: 'APIError',
			data: {
				message: 'User not found.',
				statusCode: 401,
				isRetryable: false,
				responseHeaders: { server: 'cloudflare', 'cf-ray': 'a2cd2a726aeffd40-SIN' },
			},
		},
	};

	it('renders a provider error whose message is nested under error.data', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(parser.onStdout(`${JSON.stringify(apiError)}\n`)).toBe(
			'[tool-error] APIError: User not found. (HTTP 401)\n',
		);
	});

	it('reports a nested provider error as the run terminal error, classified', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(parser.getTerminalError()).toBeNull();
		parser.onStdout(`${JSON.stringify(apiError)}\n`);
		// The status code is what makes this recognisable: "User not found." names
		// no auth problem on its own.
		expect(parser.getTerminalError()).toBe(
			"AI provider authentication failed — check the team's provider credential. (APIError: User not found. (HTTP 401))",
		);
	});

	it('keeps the upstream response headers out of the log and the run row', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(`${JSON.stringify(apiError)}\n`);
		expect(out).not.toContain('cloudflare');
		expect(parser.getTerminalError()).not.toContain('cloudflare');
	});

	it('still reads an error carrying a flat message', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(
			parser.onStdout(`${JSON.stringify({ type: 'error', error: { message: 'boom' } })}\n`),
		).toBe('[tool-error] boom\n');
		expect(parser.getTerminalError()).toBe('boom');
	});

	it('leaves the terminal error null for a run that reports no error', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		parser.onStdout(`${JSON.stringify({ type: 'message', text: 'all good' })}\n`);
		expect(parser.getTerminalError()).toBeNull();
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

	it('captures the Grok final assistant text once the turn ends', () => {
		// Grok has no `result` event — the text deltas are flushed on `end`, and
		// that flush is the only place the final message can be captured. It also
		// matters most here: Grok is one of the two runtimes whose hooks cannot
		// host the completeness judge, so the runner's delivery net is its only
		// guardrail and a null final message disables it entirely.
		const parser = createAgentStreamParser(AgentRuntime.Grok);
		parser.onStdout(`${JSON.stringify({ type: 'thought', data: 'thinking' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'text', data: 'done — over ' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'text', data: 'to you @admin' })}\n`);
		expect(parser.getFinalAssistantMessage()).toBeNull();
		parser.onStdout(`${JSON.stringify({ type: 'end', stopReason: 'stop' })}\n`);
		expect(parser.getFinalAssistantMessage()).toBe('done — over to you @admin');
	});

	it('keeps the Grok final message to the LAST turn across a multi-turn run', () => {
		// Consecutive `text` events are deltas of one message, but a run has many
		// messages: each turn opens with `thought` and the tool activity between
		// them arrives as event types this parser drops. Flushing only on `end`
		// therefore ran the whole run's narration together into one buffer, and
		// `finalMessage` became that concatenation - sentences abutting with no
		// separator, since deltas are appended raw. The runner's delivery net posts
		// this value verbatim, so on Grok (no completeness judge, net is the only
		// guardrail) an entire run's thinking was posted as one comment.
		const parser = createAgentStreamParser(AgentRuntime.Grok);
		parser.onStdout(`${JSON.stringify({ type: 'thought', data: 'checking status' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'text', data: 'Checking the task.' })}\n`);
		// A tool call: an event type this parser renders nothing for, but which
		// still ends the assistant message before it.
		parser.onStdout(`${JSON.stringify({ type: 'tool_use', data: 'get_task' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'thought', data: 'nothing due' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'text', data: 'Nothing to do ' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'text', data: 'today.' })}\n`);
		parser.onStdout(`${JSON.stringify({ type: 'end', stopReason: 'stop' })}\n`);

		expect(parser.getFinalAssistantMessage()).toBe('Nothing to do today.');
		// The specific regression: the earlier turn must not be glued to the front.
		expect(parser.getFinalAssistantMessage()).not.toContain('Checking the task.');
	});

	it('renders each Grok turn as its own log line rather than one blob at the end', () => {
		const parser = createAgentStreamParser(AgentRuntime.Grok);
		let out = '';
		out += parser.onStdout(`${JSON.stringify({ type: 'text', data: 'First message.' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'thought', data: 'now the second' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'text', data: 'Second message.' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'end', stopReason: 'stop' })}\n`);

		expect(out).toContain('First message.');
		expect(out).toContain('Second message.');
		// Run together, this would read `First message.Second message.`
		expect(out).not.toContain('First message.Second message.');
	});
});

describe('grok stream parser', () => {
	it('renders thought/text/end and reports no stream usage (usage comes from the debug log)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Grok, price);
		let out = '';
		out += parser.onStdout(`${JSON.stringify({ type: 'thought', data: 'let me ' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'thought', data: 'reason' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'text', data: 'Hello ' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'text', data: 'world' })}\n`);
		out += parser.onStdout(`${JSON.stringify({ type: 'end', stopReason: 'EndTurn' })}\n`);
		// Accumulated thought flushes as one [thinking] line when text starts; text
		// accumulates and flushes on the terminal end event alongside [done].
		expect(out).toContain('[thinking] let me reason');
		expect(out).toContain('Hello world');
		expect(out).toContain('[done] EndTurn');
		// The stream carries no token usage.
		expect(parser.getUsage()).toBeNull();
	});

	it('surfaces a stream error as a terminal error', () => {
		const parser = createAgentStreamParser(AgentRuntime.Grok);
		// A recognized auth phrase is classified; other messages pass through raw.
		parser.onStdout(`${JSON.stringify({ type: 'error', message: '401 unauthorized' })}\n`);
		expect(parser.getTerminalError()).toMatch(/authentication failed/i);
	});
});

describe('extractGrokUsageFromDebugLog', () => {
	// One real `process_conversation_turn` span line, verbatim shape.
	const span = (reqId: string, input: number, output: number, cacheRead: number) =>
		`2026-07-09T08:38:38Z DEBUG session.process_conversation_turn{session_id=s agent.name="grok-build-plan" model_id="grok-4.5" request_id="${reqId}" ttft_ms=951 input_tokens=${input} output_tokens=${output} cache_read_tokens=${cacheRead} stop_reason="stop" response.has_tool_call=false}: record`;

	it('sums usage across turns, dedups by request_id, and prices codex-style', () => {
		// req-a is echoed on two lines within its span (must not double-count).
		const log = [
			span('req-a', 10586, 9, 4352),
			span('req-a', 10586, 9, 4352),
			span('req-b', 200, 50, 0),
			'some other unrelated debug line without tokens',
		].join('\n');

		const usage = extractGrokUsageFromDebugLog(log, price);
		expect(usage).not.toBeNull();
		// input_tokens is inclusive: 10586 + 200 = 10786; output 9 + 50 = 59.
		expect(usage?.inputTokens).toBe(10786);
		expect(usage?.outputTokens).toBe(59);
		// Cost: input priced as (input - cacheRead) at full rate + cacheRead at
		// cache-read rate + output. cacheRead total = 4352.
		const expected = costCentsFromRate(RATES['grok-4.5'], {
			inputTokens: 10786 - 4352,
			cacheReadTokens: 4352,
			outputTokens: 59,
		});
		expect(usage?.costCents).toBeCloseTo(expected, 8);
	});

	it('returns null when the log has no usable span', () => {
		expect(extractGrokUsageFromDebugLog('no token spans here\n')).toBeNull();
		expect(extractGrokUsageFromDebugLog('')).toBeNull();
	});
});

describe('kimi stream parser', () => {
	const line = (o: unknown) => `${JSON.stringify(o)}\n`;

	it('renders assistant text and tool calls, and reports no stream usage', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi, price);
		let out = '';
		out += parser.onStdout(line({ role: 'assistant', content: 'Looking at the repo.' }));
		out += parser.onStdout(
			line({
				role: 'assistant',
				content: '',
				tool_calls: [
					{
						type: 'function',
						id: 'c1',
						// `arguments` arrives as a JSON *string* on the wire.
						function: { name: 'Read', arguments: '{"path":"/workspace/a.ts"}' },
					},
				],
			}),
		);
		out += parser.onStdout(line({ role: 'tool', tool_call_id: 'c1', content: 'file contents' }));

		expect(out).toContain('Looking at the repo.');
		// The JSON-string arguments are parsed so the log reads like every other
		// runtime rather than showing a quoted blob.
		expect(out).toContain('[tool] Read(path=/workspace/a.ts)');
		expect(out).toContain('[tool-result] file contents');
		// Usage is recovered post-run from the session log, never from the stream.
		expect(parser.getUsage()).toBeNull();
	});

	it('tracks the last assistant message for the handoff-delivery net', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		parser.onStdout(line({ role: 'assistant', content: 'first' }));
		parser.onStdout(line({ role: 'tool', tool_call_id: 'c1', content: 'noise' }));
		parser.onStdout(line({ role: 'assistant', content: '@admin please review' }));
		expect(parser.getFinalAssistantMessage()).toBe('@admin please review');
	});

	it('classifies a retry meta event as a terminal error and logs it', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		const out = parser.onStdout(
			line({
				role: 'meta',
				type: 'turn.step.retrying',
				failed_attempt: 1,
				max_attempts: 5,
				status_code: 401,
				error_message: '401 unauthorized',
			}),
		);
		expect(out).toContain('[system] retrying after error (attempt 1/5)');
		expect(parser.getTerminalError()).toMatch(/authentication failed/i);
	});

	it('drops session.resume_hint noise from the run log', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		const out = parser.onStdout(
			line({ role: 'meta', type: 'session.resume_hint', session_id: 's1', content: 'kimi -c' }),
		);
		expect(out).toBe('');
	});
});

describe('extractKimiUsageFromSessionLog', () => {
	const rec = (o: Record<string, unknown>) => JSON.stringify(o);

	it('sums per-turn records and prices each bucket at its own rate', () => {
		const log = [
			rec({
				type: 'usage.record',
				scope: 'turn',
				request_id: 'r1',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 1000, output: 200, inputCacheRead: 500, inputCacheCreation: 100 },
			}),
			rec({
				type: 'usage.record',
				scope: 'turn',
				request_id: 'r2',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 300, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
			}),
			'not json at all',
		].join('\n');

		const usage = extractKimiUsageFromSessionLog(log, price);
		expect(usage).not.toBeNull();
		// inputTokens is the full input side: other + cache read + cache creation.
		expect(usage?.inputTokens).toBe(1300 + 500 + 100);
		expect(usage?.outputTokens).toBe(250);
		// `inputOther` is already the non-cached remainder, so unlike Codex/Grok the
		// cached portion is NOT subtracted out of the input bucket.
		const expected = costCentsFromRate(RATES['kimi-k2.7-code'], {
			inputTokens: 1300,
			cacheReadTokens: 500,
			cacheCreationTokens: 100,
			outputTokens: 250,
		});
		expect(usage?.costCents).toBeCloseTo(expected, 8);
	});

	it('dedups repeated records by request id', () => {
		const dup = rec({
			scope: 'turn',
			request_id: 'r1',
			model: 'kimi-k2.7-code',
			usage: { inputOther: 100, output: 10 },
		});
		const usage = extractKimiUsageFromSessionLog([dup, dup].join('\n'), price);
		expect(usage?.inputTokens).toBe(100);
		expect(usage?.outputTokens).toBe(10);
	});

	it('never sums cumulative session-scoped totals — takes the last instead', () => {
		// Session records are running totals; summing them would multiply the bill.
		const log = [
			rec({
				scope: 'session',
				id: 's1',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 100, output: 10 },
			}),
			rec({
				scope: 'session',
				id: 's2',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 300, output: 30 },
			}),
		].join('\n');
		const usage = extractKimiUsageFromSessionLog(log, price);
		expect(usage?.inputTokens).toBe(300);
		expect(usage?.outputTokens).toBe(30);
	});

	it('prefers turn records and ignores the cumulative session record beside them', () => {
		const log = [
			rec({
				scope: 'turn',
				request_id: 'r1',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 100, output: 10 },
			}),
			rec({
				scope: 'turn',
				request_id: 'r2',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 200, output: 20 },
			}),
			rec({
				scope: 'session',
				id: 's1',
				model: 'kimi-k2.7-code',
				usage: { inputOther: 300, output: 30 },
			}),
		].join('\n');
		const usage = extractKimiUsageFromSessionLog(log, price);
		expect(usage?.inputTokens).toBe(300);
		expect(usage?.outputTokens).toBe(30);
	});

	it('accepts the snake_case spelling used by the older kimi-cli logs', () => {
		// Upstream ships two engine generations with duplicated logging paths, so
		// both spellings are tolerated rather than silently pricing to $0.
		const log = rec({
			request_id: 'r1',
			model_id: 'kimi-k2.7-code',
			token_usage: { input_other: 400, output: 40, input_cache_read: 60 },
		});
		const usage = extractKimiUsageFromSessionLog(log, price);
		expect(usage?.inputTokens).toBe(460);
		expect(usage?.outputTokens).toBe(40);
	});

	it('returns null when the log carries no usage record (⇒ $0, fail-low)', () => {
		expect(extractKimiUsageFromSessionLog('')).toBeNull();
		expect(extractKimiUsageFromSessionLog('{"role":"assistant","content":"hi"}')).toBeNull();
		// An object with a `usage` key but no recognised bucket must not contribute
		// a phantom zero record.
		expect(extractKimiUsageFromSessionLog('{"usage":{"something_else":1}}')).toBeNull();
	});

	it('prices to $0 for a model with no pricing row rather than guessing', () => {
		const log = rec({
			scope: 'turn',
			request_id: 'r1',
			model: 'kimi-unpriced',
			usage: { inputOther: 1000, output: 100 },
		});
		const usage = extractKimiUsageFromSessionLog(log, price);
		expect(usage?.inputTokens).toBe(1000);
		expect(usage?.costCents).toBe(0);
	});
});
