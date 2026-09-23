import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRuntime, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	codexRolloutModel,
	createAgentStreamParser,
	extractCodexUsageFromRollout,
	extractGrokUsageFromDebugLog,
	extractKimiUsageFromSessionLog,
} from '../src/services/agent-stream-parser';
import { RunFailureClass } from '../src/services/run-failure-classification';

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

	it('ignores the runtime-reported total_cost_usd and keeps the token counts', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
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
		expect(usage?.model).toBe('claude-x');
		// The reported dollar figure is a client-side estimate and is not kept.
		expect(usage).not.toHaveProperty('costCents');
		expect(out).toContain('[done] success turns=3 duration=2000ms tokens=150/50');
	});

	it('counts the tokens when Claude Code reports no total_cost_usd', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x', tools: [] })}\n`,
		);
		// No total_cost_usd on the terminal event, as on an interrupted run. Only the
		// token buckets matter.
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

		expect(parser.getUsage()?.inputTokens).toBe(150);
		expect(out).toContain('tokens=150/50');
	});

	it('discards a third-party endpoint total_cost_usd and keeps its tokens', () => {
		// Event shape captured from a real DeepSeek-via-Claude-Code run: the
		// Anthropic-compatible endpoint returns a total_cost_usd computed with the
		// CLI's own (wrong-provider) rate card.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
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
		expect(usage?.model).toBe('deepseek-v4-flash');
		expect(out).toContain('tokens=20096/15');
	});

	it('accumulates running usage from assistant turns before the terminal result', () => {
		// A run interrupted before its `result` event (e.g. a server restart) must
		// still report the tokens it burned. The parser sums each assistant turn's
		// usage so getUsage() is non-null mid-stream.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
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
	});

	it('the terminal result replaces the running usage with the authoritative total', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
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
					// Codex's own total proves both subset relations in this fixture:
					// 24763 + 122 === 24885, so reasoning is inside output and the cache
					// buckets are inside input. Neither may be added on top.
					total_tokens: 24885,
				},
			};
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			expect(out).toContain('[done] success turns=1 tokens=24763/122');

			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(24763);
			expect(usage?.outputTokens).toBe(122);
			expect((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toBe(event.usage.total_tokens);
		});

		it('splits the input buckets so cache reads stay apart from fresh input', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex, 'codex-x');
			parser.onStdout(
				`${JSON.stringify({
					type: 'turn.completed',
					usage: {
						input_tokens: 1000,
						cached_input_tokens: 900,
						cache_write_input_tokens: 50,
						output_tokens: 10,
					},
				})}\n`,
			);
			// An agent run is dominated by cache reads, so the usage breakdown shows
			// them apart from fresh input.
			expect(parser.getUsage()?.buckets).toEqual({
				inputTokens: 50,
				cacheReadTokens: 900,
				cacheCreationTokens: 50,
				outputTokens: 10,
			});
		});

		it('ignores a runtime-reported cost', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			parser.onStdout(`${JSON.stringify({ type: 'thread.started', model: 'codex-x' })}\n`);
			parser.onStdout(
				`${JSON.stringify({
					type: 'turn.completed',
					total_cost_usd: 0.5,
					usage: { input_tokens: 1000, output_tokens: 100 },
				})}\n`,
			);
			expect(parser.getUsage()).toMatchObject({
				inputTokens: 1000,
				outputTokens: 100,
				model: 'codex-x',
			});
			expect(parser.getUsage()).not.toHaveProperty('costCents');
		});

		it('marks a failed turn as error', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const event = { type: 'turn.failed', usage: { input_tokens: 10, output_tokens: 2 } };
			const out = parser.onStdout(`${JSON.stringify(event)}\n`);
			expect(out).toContain('[done] error turns=1 tokens=10/2');
			expect(parser.getUsage()?.outputTokens).toBe(2);
		});

		it("reads a failed turn's reason off the turn event itself", () => {
			// Codex does not always follow `turn.failed` with a top-level `error` event,
			// so a reason read only from that arm was lost and the run row fell through
			// to the exit-code backstop with the provider's explanation left in the log.
			// No `type: 'error'` event here on purpose - that is the whole point.
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			const out = parser.onStdout(
				`${JSON.stringify({
					type: 'turn.failed',
					error: { message: 'Selected model is at capacity. Please try a different model.' },
					usage: {},
				})}\n`,
			);
			// The line the log viewer renders as the reported `error · 1 turns · 0 in / 0 out`.
			expect(out).toContain('[done] error turns=1 tokens=0/0');
			expect(parser.getTerminalError()).toContain('at capacity');
			expect(parser.getTerminalVerdict()?.failure).toBe(RunFailureClass.Transient);
		});

		it('leaves an unrecognised failed turn permanent', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			parser.onStdout(
				`${JSON.stringify({
					type: 'turn.failed',
					error: { message: 'the sandbox refused this command' },
					usage: {},
				})}\n`,
			);
			expect(parser.getTerminalVerdict()?.failure).toBe(RunFailureClass.Permanent);
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

		it('records the run model when the stream names none', () => {
			// Codex never names a model on its stream, so the run model is the only
			// record of which model ran.
			const parser = createAgentStreamParser(AgentRuntime.Codex, 'codex-x');
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
			expect(parser.getUsage()?.model).toBe('codex-x');
		});

		it('lets a model named on the stream win over the run model', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex, 'stale-model');
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
			expect(parser.getUsage()).toEqual({
				inputTokens: 5,
				outputTokens: 7,
				model: null,
				buckets: {
					inputTokens: 5,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					outputTokens: 7,
				},
			});
		});

		it('drops unknown events instead of emitting raw JSON', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			expect(parser.onStdout(`${JSON.stringify({ type: 'turn.started' })}\n`)).toBe('');
		});
	});

	describe('codex error events', () => {
		// Recorded shape: Codex reports a transient failure it will retry exactly
		// like a fatal one, as a top-level `error` event.
		const reconnecting = {
			type: 'error',
			message:
				'Reconnecting... 2/5 (stream disconnected before completion: error sending request for url)',
		};
		const lines = (events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

		it('drops an error the turn then recovered from', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			parser.onStdout(
				lines([
					reconnecting,
					{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
				]),
			);
			expect(parser.getTerminalVerdict()).toBeNull();
		});

		it('keeps the error when the turn failed without a reason of its own', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			parser.onStdout(
				lines([
					{
						type: 'error',
						message: 'Selected model is at capacity. Please try a different model.',
					},
					{ type: 'turn.failed', usage: {} },
				]),
			);
			expect(parser.getTerminalVerdict()?.family).toBe('capacity');
		});

		it('keeps the error when the run ended before its turn resolved', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			parser.onStdout(lines([{ type: 'error', message: '401 Unauthorized' }]));
			expect(parser.getTerminalVerdict()?.family).toBe('auth');
		});
	});

	describe('antigravity 1.2.8 recorded frames', () => {
		const frame = (o: unknown) => `${JSON.stringify(o)}\n`;
		const step = (s: Record<string, unknown>) =>
			frame({ event: 'step_update', step_update: { conversation_id: 'c1', ...s } });

		it('names MCP calls by server and tool, renders arguments, and counts failed steps', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			const mcp = {
				name: 'call_mcp_tool',
				parameters: {
					Arguments: { include_comments: true, task_id: 'BE-2' },
					ServerName: 'hezo',
					ToolName: 'get_task',
				},
			};
			let out = '';
			// Each call is reported ACTIVE, then DONE or ERROR; only the end renders.
			out += parser.onStdout(
				step({
					step_index: 2,
					state: 'ACTIVE',
					step_type: 'tool',
					tool_name: 'call_mcp_tool',
					tool_info: mcp,
				}),
			);
			out += parser.onStdout(
				step({
					step_index: 2,
					state: 'DONE',
					step_type: 'tool',
					tool_name: 'call_mcp_tool',
					tool_info: { ...mcp, output: '[{"slug":"demo","name":"Demo"}]' },
				}),
			);
			out += parser.onStdout(
				step({
					step_index: 6,
					state: 'DONE',
					step_type: 'tool',
					tool_name: 'run_command',
					tool_info: {
						name: 'run_command',
						parameters: { CommandLine: 'ls /workspace' },
						output: 'a.txt\n',
					},
				}),
			);
			out += parser.onStdout(
				step({
					step_index: 10,
					state: 'ERROR',
					step_type: 'tool',
					tool_name: 'view_file',
					tool_info: {
						name: 'view_file',
						parameters: { AbsolutePath: '/workspace/missing.txt' },
						error: { type: 'TOOL_ERROR', message: 'no such file or directory' },
					},
				}),
			);
			expect(out).toBe(
				[
					'[tool] mcp__hezo__get_task(include_comments=true, task_id=BE-2)',
					'[tool-result] [{"slug":"demo","name":"Demo"}]',
					'[tool] run_command(CommandLine=ls /workspace)',
					'[tool-result] a.txt',
					'[tool] view_file(AbsolutePath=/workspace/missing.txt)',
					'[tool-error] no such file or directory',
					'',
				].join('\n'),
			);
			expect(parser.getToolCallTotal()).toBe(3);
		});

		it('states a turn the stream missed instead of reporting no output', () => {
			// A fast upstream answer or refusal on a large prompt: SUCCESS, no
			// response, no usage, nothing after the prompt.
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(frame({ event: 'init', init: { model: 'gemini-3.6-flash' } }));
			parser.onStdout(step({ step_index: 0, state: 'DONE', step_type: 'user_input' }));
			parser.onStdout(
				frame({
					event: 'result',
					result: {
						status: 'SUCCESS',
						response: '',
						usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
					},
				}),
			);
			const verdict = parser.getTerminalVerdict();
			expect(verdict?.message).toMatch(/stream missed the turn/);
			expect(verdict?.failure).toBe(RunFailureClass.Permanent);
		});

		it('does not flag a turn that did something, even with an empty response', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(step({ step_index: 0, state: 'DONE', step_type: 'user_input' }));
			parser.onStdout(
				step({
					step_index: 1,
					state: 'DONE',
					step_type: 'tool',
					tool_name: 'run_command',
					tool_info: { name: 'run_command', parameters: { CommandLine: 'true' } },
				}),
			);
			parser.onStdout(
				frame({ event: 'result', result: { status: 'SUCCESS', response: '', usage: {} } }),
			);
			expect(parser.getTerminalVerdict()).toBeNull();
		});
	});

	describe('antigravity', () => {
		const init = (model: string) => `${JSON.stringify({ event: 'init', init: { model } })}\n`;
		const result = (r: Record<string, unknown>) =>
			`${JSON.stringify({ event: 'result', result: r })}\n`;

		it('captures usage from the result event', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(init('gemini-2.5-pro'));
			const out = parser.onStdout(
				result({
					status: 'SUCCESS',
					response: 'done',
					// Buckets are disjoint: input_tokens excludes cache_read_tokens, and
					// output_tokens already includes thinking_tokens.
					usage: {
						input_tokens: 24939,
						output_tokens: 174,
						thinking_tokens: 154,
						cache_read_tokens: 21263,
						total_tokens: 25113,
					},
				}),
			);
			// 24939 uncached + 21263 cache reads. The done line reports the total, as
			// every other runtime's does.
			expect(out).toContain('[done] success tokens=46202/174');

			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(46202);
			expect(usage?.outputTokens).toBe(174);
		});

		const step = (stepIndex: number | undefined, usage: Record<string, number>) =>
			`${JSON.stringify({ event: 'step_update', step_update: { step_index: stepIndex, state: 'DONE', step_type: 'agent_response', usage } })}\n`;

		it('sums per-step usage as the run goes, then takes the result usage once it lands', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(init('gemini-2.5-pro'));
			parser.onStdout(step(1, { input_tokens: 400, output_tokens: 40 }));
			parser.onStdout(step(2, { input_tokens: 600, output_tokens: 60, cache_read_tokens: 100 }));
			// The running sum is what the per-run ceiling reads before the run ends.
			expect(parser.getUsage()?.inputTokens).toBe(1_100);
			expect(parser.getUsage()?.outputTokens).toBe(100);
			expect(parser.hasEnded()).toBe(false);

			parser.onStdout(
				result({
					status: 'SUCCESS',
					usage: { input_tokens: 1_000_000, output_tokens: 200_000, cache_read_tokens: 0 },
				}),
			);
			expect(parser.getUsage()?.inputTokens).toBe(1_000_000);
			expect(parser.hasEnded()).toBe(true);
		});

		it('counts a step reported more than once by its latest figure', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(step(1, { input_tokens: 400, output_tokens: 10 }));
			parser.onStdout(step(1, { input_tokens: 400, output_tokens: 40 }));
			parser.onStdout(step(undefined, { input_tokens: 5, output_tokens: 5 }));
			parser.onStdout(step(undefined, { input_tokens: 5, output_tokens: 5 }));
			// Step 1 once at its latest output; each unindexed step is its own step.
			expect(parser.getUsage()?.inputTokens).toBe(410);
			expect(parser.getUsage()?.outputTokens).toBe(50);
		});

		it('records cache_read in its own bucket, disjoint from input', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(init('gemini-2.5-pro'));
			parser.onStdout(
				result({
					status: 'SUCCESS',
					usage: { input_tokens: 52921, output_tokens: 602, cache_read_tokens: 40586 },
				}),
			);
			const usage = parser.getUsage();
			// No subtraction (unlike Codex): input_tokens is already the non-cached
			// input, so it reaches the buckets as stated.
			expect(usage?.buckets).toEqual({
				inputTokens: 52921,
				cacheReadTokens: 40586,
				outputTokens: 602,
			});
			// The reported total adds the cache back in, so it means the same thing
			// here as it does for every other runtime.
			expect(usage?.inputTokens).toBe(52921 + 40586);
			expect(usage?.outputTokens).toBe(602);
		});

		it('takes the final message from the result response', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(init('gemini-2.5-pro'));
			const out = parser.onStdout(
				result({ status: 'SUCCESS', response: 'HEZO-LIVE-OK\n', usage: {} }),
			);
			expect(out).toContain('HEZO-LIVE-OK');
			expect(parser.getFinalAssistantMessage()).toBe('HEZO-LIVE-OK');
		});

		it('renders nothing for step_update frames', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			expect(
				parser.onStdout(
					`${JSON.stringify({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } })}\n`,
				),
			).toBe('');
		});

		it('marks an error result and renders a done-error line', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(init('gemini-2.5-pro'));
			const out = parser.onStdout(
				result({ status: 'ERROR', response: '', error: 'boom', usage: {} }),
			);
			expect(out).toContain('[done] error');
		});

		it('renders the init event as a session line', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			expect(parser.onStdout(init('gemini-2.5-pro'))).toBe('[session] model=gemini-2.5-pro\n');
		});
	});

	describe('token buckets', () => {
		it('counts cached codex input as input and reports it in its own bucket', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
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
			// Reasoning is already inside the output count, so it is not added on top.
			expect(parser.getUsage()).toMatchObject({
				inputTokens: 24763,
				outputTokens: 122,
				buckets: {
					inputTokens: 315,
					cacheReadTokens: 24448,
					cacheCreationTokens: 0,
					outputTokens: 122,
				},
			});
		});

		it('records an antigravity run against the init model', () => {
			const parser = createAgentStreamParser(AgentRuntime.Antigravity);
			parser.onStdout(`${JSON.stringify({ event: 'init', init: { model: 'gemini-2.5-pro' } })}\n`);
			parser.onStdout(
				`${JSON.stringify({
					event: 'result',
					result: {
						status: 'SUCCESS',
						usage: { input_tokens: 1_000_000, output_tokens: 200_000, cache_read_tokens: 0 },
					},
				})}\n`,
			);
			const usage = parser.getUsage();
			expect(usage?.inputTokens).toBe(1_000_000);
			expect(usage?.outputTokens).toBe(200_000);
			expect(usage?.model).toBe('gemini-2.5-pro');
		});

		it('records the tokens of a model Hezo has never seen', () => {
			const parser = createAgentStreamParser(AgentRuntime.Codex);
			parser.onStdout(`${JSON.stringify({ type: 'thread.started', model: 'unknown-xyz' })}\n`);
			parser.onStdout(
				`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 9999, output_tokens: 9999 } })}\n`,
			);
			expect(parser.getUsage()).toMatchObject({
				inputTokens: 9999,
				outputTokens: 9999,
				model: 'unknown-xyz',
			});
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

	it('captures token usage from a terminal event', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
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
		expect(usage?.model).toBe('gemini-2.5-flash');
	});

	it('ignores a provider-reported usd cost', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			`${JSON.stringify({
				type: 'turn.completed',
				total_cost_usd: 0.25,
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			})}\n`,
		);
		expect(out).toBe('[done] success tokens=10/5\n');
		expect(parser.getUsage()).not.toHaveProperty('costCents');
	});

	it('drops unrecognized structured events instead of dumping raw JSON', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(`${JSON.stringify({ type: 'session.status', status: 'busy' })}\n`);
		expect(out).toBe('');
	});

	// The shape a real run emits: per-step counts nested under `part`, with the
	// cache halves in their own object. Probing only the event root found nothing,
	// so every OpenCode run recorded no tokens.
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

	it('records the run model when the stream names none', () => {
		// OpenCode announces no model anywhere, so the run model is the only record
		// of which model ran.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, 'gemini-2.5-flash');
		for (const e of STEP_FINISHES) parser.onStdout(`${JSON.stringify(e)}\n`);
		expect(parser.getUsage()?.model).toBe('gemini-2.5-flash');
	});

	it('ignores the run model once the stream names one', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, 'stale-model');
		parser.onStdout(`${JSON.stringify({ type: 'init', model: 'gemini-2.5-flash' })}\n`);
		for (const e of STEP_FINISHES) parser.onStdout(`${JSON.stringify(e)}\n`);
		expect(parser.getUsage()?.model).toBe('gemini-2.5-flash');
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

	it('keeps the run going past a step that finished for an unknown reason', () => {
		// From OpenCode 1.18.21 an `unknown` finish loops like `tool-calls` does.
		// Recorded from 1.18.32 against a model that sent a finish reason OpenCode
		// does not recognise: a second model call followed, ending on `stop`.
		const text = (t: string) => ({ type: 'text', part: { type: 'text', text: t } });
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		parser.onStdout(`${JSON.stringify(text('partial answer'))}\n`);
		expect(parser.onStdout(`${JSON.stringify(stepFinish('unknown', 500, 5))}\n`)).toBe('');
		expect(parser.hasEnded()).toBe(false);

		parser.onStdout(`${JSON.stringify(text('second answer'))}\n`);
		expect(parser.onStdout(`${JSON.stringify(stepFinish('stop', 120, 4))}\n`)).toBe(
			'[done] success tokens=620/9\n',
		);
		expect(parser.hasEnded()).toBe(true);
		expect(parser.getFinalAssistantMessage()).toBe('second answer');
		expect(parser.flush()).toBe('');
	});

	it('writes the done line on flush when a run exits after an unknown finish', () => {
		// OpenCode before 1.18.21 stopped here, with no later step_finish.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(parser.onStdout(`${JSON.stringify(stepFinish('unknown', 500, 5))}\n`)).toBe('');
		expect(parser.flush()).toBe('[done] success tokens=500/5\n');
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

	it('captures the Antigravity final assistant message from the result response', () => {
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		parser.onStdout(`${JSON.stringify({ event: 'init', init: { model: 'gemini-2.5-pro' } })}\n`);
		parser.onStdout(
			`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ready for @admin review', usage: {} } })}\n`,
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
		const parser = createAgentStreamParser(AgentRuntime.Grok);
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

	it('sums usage across turns and dedups by request_id', () => {
		// req-a is echoed on two lines within its span (must not double-count).
		const log = [
			span('req-a', 10586, 9, 4352),
			span('req-a', 10586, 9, 4352),
			span('req-b', 200, 50, 0),
			'some other unrelated debug line without tokens',
		].join('\n');

		const usage = extractGrokUsageFromDebugLog(log);
		expect(usage).not.toBeNull();
		// input_tokens is inclusive: 10586 + 200 = 10786; output 9 + 50 = 59.
		expect(usage?.inputTokens).toBe(10786);
		expect(usage?.outputTokens).toBe(59);
		// Input is inclusive of cache reads, so the fresh bucket is what remains.
		expect(usage?.buckets).toEqual({
			inputTokens: 10786 - 4352,
			cacheReadTokens: 4352,
			outputTokens: 59,
		});
		expect(usage?.model).toBe('grok-4.5');
	});

	it('returns null when the log has no usable span', () => {
		expect(extractGrokUsageFromDebugLog('no token spans here\n')).toBeNull();
		expect(extractGrokUsageFromDebugLog('')).toBeNull();
	});
});

describe('kimi stream parser', () => {
	const line = (o: unknown) => `${JSON.stringify(o)}\n`;

	it('renders assistant text and tool calls, and reports no stream usage', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
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

	it('classifies a provider failure Kimi reports only on stderr', () => {
		// A rejected key or an empty balance is not retried, and nothing about it
		// reaches stdout. Lines as Kimi Code 2.0.2 prints them, split across chunks.
		const cases: Array<[string, string]> = [
			['error: failed to run prompt: provider.auth_error: 401 Invalid Authentication', 'auth'],
			[
				'error: failed to run prompt: provider.api_error: 402 Your account is suspended due to insufficient balance',
				'credit',
			],
			[
				'error: failed to run prompt: provider.rate_limit: 429 Too many requests, rate limit reached',
				'rate_limit',
			],
		];
		for (const [stderr, family] of cases) {
			const parser = createAgentStreamParser(AgentRuntime.Kimi);
			parser.onStdout(line({ role: 'meta', type: 'system.version', version: '2.0.2' }));
			const half = Math.floor(stderr.length / 2);
			// Stderr still reaches the run log unchanged.
			expect(parser.onStderr(stderr.slice(0, half))).toBe(stderr.slice(0, half));
			expect(parser.onStderr(`${stderr.slice(half)}\n`)).toBe(`${stderr.slice(half)}\n`);
			expect(parser.getTerminalVerdict()?.family, stderr).toBe(family);
		}
		// Also when the line is the last thing written, with no newline.
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		parser.onStderr(cases[0][0]);
		parser.flush();
		expect(parser.getTerminalVerdict()?.family).toBe('auth');
		// Other stderr is not read as a failure.
		const quiet = createAgentStreamParser(AgentRuntime.Kimi);
		quiet.onStderr('Warning: this folder is not trusted; skipped 1 project-level MCP servers\n');
		expect(quiet.getTerminalVerdict()).toBeNull();
	});

	it('drops session.resume_hint noise from the run log', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		const out = parser.onStdout(
			line({ role: 'meta', type: 'session.resume_hint', session_id: 's1', content: 'kimi -c' }),
		);
		expect(out).toBe('');
	});

	it('parses a run recorded from Kimi Code 2.0.2', () => {
		// Five tool calls (two MCP servers, a doc-guard refusal, an image result and
		// Bash), then a final answer, a Stop-hook block and a second answer. 2.0.2
		// opens the stream with a `system.version` meta line.
		const stream = readKimiFixture('kimi-2.0.2.stdout.jsonl');
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		let out = '';
		// Chunked mid-line, as a pipe delivers it.
		for (let i = 0; i < stream.length; i += 97) out += parser.onStdout(stream.slice(i, i + 97));
		out += parser.flush();

		expect(out).not.toContain('system.version');
		expect(out).not.toContain('resume');
		expect(out).toContain('[tool] mcp__hezo__echo(text=hello-from-mock)');
		expect(out).toContain('[tool-result] bash-ran-ok');
		expect(parser.getToolCallTotal()).toBe(5);
		expect(parser.getFinalAssistantMessage()).toBe(
			'SECOND_FINAL_ANSWER after the judge continued me.',
		);
		expect(parser.getTerminalVerdict()).toBeNull();
		expect(parser.getUsage()).toBeNull();
	});
});

/** A capture recorded from the pinned Kimi Code CLI against a local mock provider. */
function readKimiFixture(name: string): string {
	return readFileSync(resolve(import.meta.dirname, 'fixtures/kimi', name), 'utf8');
}

describe('extractKimiUsageFromSessionLog', () => {
	const rec = (o: Record<string, unknown>) => JSON.stringify(o);

	it('sums per-turn records into their own buckets', () => {
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

		const usage = extractKimiUsageFromSessionLog(log);
		expect(usage).not.toBeNull();
		// inputTokens is the full input side: other + cache read + cache creation.
		expect(usage?.inputTokens).toBe(1300 + 500 + 100);
		expect(usage?.outputTokens).toBe(250);
		// `inputOther` is already the non-cached remainder, so unlike Codex/Grok the
		// cached portion is NOT subtracted out of the input bucket.
		expect(usage?.buckets).toEqual({
			inputTokens: 1300,
			cacheReadTokens: 500,
			cacheCreationTokens: 100,
			outputTokens: 250,
		});
		expect(usage?.model).toBe('kimi-k2.7-code');
	});

	it('dedups repeated records by request id', () => {
		const dup = rec({
			scope: 'turn',
			request_id: 'r1',
			model: 'kimi-k2.7-code',
			usage: { inputOther: 100, output: 10 },
		});
		const usage = extractKimiUsageFromSessionLog([dup, dup].join('\n'));
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
		const usage = extractKimiUsageFromSessionLog(log);
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
		const usage = extractKimiUsageFromSessionLog(log);
		expect(usage?.inputTokens).toBe(300);
		expect(usage?.outputTokens).toBe(30);
	});

	it('accepts the snake_case spelling used by the older kimi-cli logs', () => {
		// Upstream ships two engine generations with duplicated logging paths, so
		// both spellings are tolerated rather than silently recording no tokens.
		const log = rec({
			request_id: 'r1',
			model_id: 'kimi-k2.7-code',
			token_usage: { input_other: 400, output: 40, input_cache_read: 60 },
		});
		const usage = extractKimiUsageFromSessionLog(log);
		expect(usage?.inputTokens).toBe(460);
		expect(usage?.outputTokens).toBe(40);
	});

	it('sums the usage records of a session recorded from Kimi Code 2.0.2', () => {
		// Seven requests, each one `usage.record` with `usageScope: "turn"` and no
		// request id. The mock billed prompt_tokens 17,500 (1,400 of it cached) and
		// completion_tokens 385 across them.
		const usage = extractKimiUsageFromSessionLog(readKimiFixture('kimi-2.0.2.wire.jsonl'));
		expect(usage?.inputTokens).toBe(17_500);
		expect(usage?.outputTokens).toBe(385);
		expect(usage?.buckets).toEqual({
			inputTokens: 16_100,
			cacheReadTokens: 1_400,
			cacheCreationTokens: 0,
			outputTokens: 385,
		});
		// The usage records name `__kimi_env_model__`, the CLI's alias for the
		// env-registered provider; the run is recorded under the real model id.
		expect(usage?.model).toBe('kimi-k3');
	});

	it('resolves the model alias from the request that preceded each usage record', () => {
		const log = [
			rec({ type: 'llm.request', model: 'kimi-k3', modelAlias: '__kimi_env_model__' }),
			rec({
				type: 'usage.record',
				model: '__kimi_env_model__',
				usage: { inputOther: 100, output: 10 },
				usageScope: 'turn',
			}),
		].join('\n');
		expect(extractKimiUsageFromSessionLog(log)?.model).toBe('kimi-k3');
		// A record naming a real model keeps it.
		const named = rec({ model: 'kimi-k2', usage: { inputOther: 1, output: 1 } });
		expect(extractKimiUsageFromSessionLog(`${log}\n${named}`)?.model).toBe('kimi-k2');
	});

	it('returns null when the log carries no usage record', () => {
		expect(extractKimiUsageFromSessionLog('')).toBeNull();
		expect(extractKimiUsageFromSessionLog('{"role":"assistant","content":"hi"}')).toBeNull();
		// An object with a `usage` key but no recognised bucket must not contribute
		// a phantom zero record.
		expect(extractKimiUsageFromSessionLog('{"usage":{"something_else":1}}')).toBeNull();
	});

	it('records the tokens of a model Hezo has never seen', () => {
		const log = rec({
			scope: 'turn',
			request_id: 'r1',
			model: 'kimi-unknown',
			usage: { inputOther: 1000, output: 100 },
		});
		const usage = extractKimiUsageFromSessionLog(log);
		expect(usage?.inputTokens).toBe(1000);
		expect(usage?.model).toBe('kimi-unknown');
	});
});

// ---------------------------------------------------------------------------
// Claude Code stderr: the unrecognized-model diagnostic
//
// Pointed at a third-party Anthropic-compatible endpoint, the CLI cannot resolve
// any of the model ids Hezo hands it and says so on stderr once per (model, call
// site). Suppressed for exactly those providers, kept everywhere else.
// ---------------------------------------------------------------------------

const UNRECOGNIZED_RUN =
	'[claude-code:unrecognized_model] {"model":"deepseek-v4-pro","query_source":"sdk"}';
const UNRECOGNIZED_TITLE =
	'[claude-code:unrecognized_model] {"model":"deepseek-v4-flash","query_source":"generate_session_title"}';

describe('claude-code unrecognized-model stderr', () => {
	it('drops the diagnostic on a third-party Anthropic-compatible provider', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		expect(parser.onStderr(`${UNRECOGNIZED_TITLE}\n`)).toBe('');
		expect(parser.onStderr(`${UNRECOGNIZED_RUN}\n`)).toBe('');
		expect(parser.flush()).toBe('');
	});

	it('keeps every other stderr line, including neighbours of a dropped one', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		const chunk = `before\n${UNRECOGNIZED_RUN}\nafter\n`;
		expect(parser.onStderr(chunk)).toBe('before\nafter\n');
	});

	it('keeps the diagnostic on Anthropic, where it means a model the CLI cannot resolve', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.Anthropic);
		expect(parser.onStderr(`${UNRECOGNIZED_RUN}\n`)).toBe(`${UNRECOGNIZED_RUN}\n`);
	});

	it('keeps the diagnostic when no provider is supplied, so an unknown one silences nothing', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.onStderr(`${UNRECOGNIZED_RUN}\n`)).toBe(`${UNRECOGNIZED_RUN}\n`);
	});

	it('drops it for a Moonshot credential running on Claude Code, not on its own CLI', () => {
		const onClaudeCode = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.Kimi);
		expect(onClaudeCode.onStderr(`${UNRECOGNIZED_RUN}\n`)).toBe('');

		// The kimi runtime has its own parser and never sees this line; its stderr
		// stays a straight passthrough.
		const onKimi = createAgentStreamParser(AgentRuntime.Kimi, null, AiProvider.Kimi);
		expect(onKimi.onStderr(`${UNRECOGNIZED_RUN}\n`)).toBe(`${UNRECOGNIZED_RUN}\n`);
	});

	it('drops it for a local provider, whose ids are off-registry too', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.Ollama);
		expect(parser.onStderr(`${UNRECOGNIZED_RUN}\n`)).toBe('');
	});

	it('matches a line split across chunks rather than leaking half of it', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		const half = Math.floor(UNRECOGNIZED_RUN.length / 2);
		expect(parser.onStderr(UNRECOGNIZED_RUN.slice(0, half))).toBe('');
		expect(parser.onStderr(`${UNRECOGNIZED_RUN.slice(half)}\n`)).toBe('');
	});

	it('flush() releases a held partial line, and drops it when it is the diagnostic', () => {
		const kept = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		expect(kept.onStderr('tail with no newline')).toBe('');
		expect(kept.flush()).toBe('tail with no newline');

		const dropped = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		expect(dropped.onStderr(UNRECOGNIZED_RUN)).toBe('');
		expect(dropped.flush()).toBe('');
	});

	it('flush() still renders the buffered stdout event alongside the stderr tail', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		parser.onStdout('{"type":"system","subtype":"init","model":"deepseek-v4-pro","tools":[]}');
		parser.onStderr('partial');
		expect(parser.flush()).toBe('[session] model=deepseek-v4-pro tools=0\npartial');
	});

	it('releases an over-long partial line instead of buffering it without bound', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		const huge = 'x'.repeat(64 * 1024 + 1);
		expect(parser.onStderr(huge)).toBe(huge);
		// Released early, so the fragment completing it arrives next - concatenated,
		// the log still reads as the original bytes.
		expect(parser.onStderr('rest\n')).toBe('rest\n');
		expect(parser.flush()).toBe('');
	});

	it('leaves stdout rendering untouched', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode, null, AiProvider.DeepSeek);
		expect(
			parser.onStdout('{"type":"system","subtype":"init","model":"claude-x","tools":["Bash"]}\n'),
		).toBe('[session] model=claude-x tools=1\n');
		parser.onStdout(
			'{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":10,"output_tokens":5}}\n',
		);
		expect(parser.getUsage()?.inputTokens).toBe(10);
		expect(parser.getFinalAssistantMessage()).toBe('done');
	});
});

describe('extractCodexUsageFromRollout', () => {
	/** One cumulative `token_count` record, in the shape Codex actually writes. */
	const tokenCount = (t: {
		input: number;
		cached?: number;
		cacheWrite?: number;
		output: number;
		reasoning?: number;
	}): string =>
		`${JSON.stringify({
			type: 'event_msg',
			payload: {
				type: 'token_count',
				info: {
					total_token_usage: {
						input_tokens: t.input,
						cached_input_tokens: t.cached ?? 0,
						cache_write_input_tokens: t.cacheWrite ?? 0,
						output_tokens: t.output,
						reasoning_output_tokens: t.reasoning ?? 0,
						total_tokens: t.input + t.output,
					},
					last_token_usage: { input_tokens: t.input, output_tokens: t.output },
				},
			},
		})}\n`;

	const turnContext = (model: string): string =>
		`${JSON.stringify({ type: 'turn_context', payload: { turn_id: 1, model } })}\n`;

	it('takes the last cumulative total, never the sum of the records', () => {
		// The trap: Codex re-emits `token_count` more often than there are requests,
		// so summing the per-request deltas over-counts - measured at 2.8% on a real
		// 1,105-record session. The totals are cumulative and monotonic.
		const usage = extractCodexUsageFromRollout(
			[tokenCount({ input: 100, output: 10 }), tokenCount({ input: 250, output: 25 })].join(''),
		);
		expect(usage?.inputTokens).toBe(250);
		expect(usage?.outputTokens).toBe(25);
	});

	it('subtracts both cache buckets out of input rather than adding them on top', () => {
		const usage = extractCodexUsageFromRollout(
			tokenCount({ input: 1000, cached: 900, cacheWrite: 50, output: 10 }),
		);
		expect(usage?.buckets).toEqual({
			inputTokens: 50,
			cacheReadTokens: 900,
			cacheCreationTokens: 50,
			outputTokens: 10,
		});
		// The reported total still counts every input token.
		expect(usage?.inputTokens).toBe(1000);
	});

	it('does not add reasoning on top of output', () => {
		const usage = extractCodexUsageFromRollout(
			tokenCount({ input: 500, output: 40, reasoning: 10 }),
		);
		expect(usage?.outputTokens).toBe(40);
	});

	it('sums a mid-session model switch and reports the model that moved the most tokens', () => {
		const usage = extractCodexUsageFromRollout(
			[
				turnContext('heavy'),
				tokenCount({ input: 1000, output: 100 }),
				turnContext('light'),
				tokenCount({ input: 1100, output: 110 }),
			].join(''),
		);
		expect(usage?.inputTokens).toBe(1100);
		expect(usage?.outputTokens).toBe(110);
		// The last model named is not the one reported: it moved a tenth of the tokens.
		expect(usage?.model).toBe('heavy');
	});

	it('seeds the model from the head when the tail carries no turn_context', () => {
		const usage = extractCodexUsageFromRollout(tokenCount({ input: 5, output: 1 }), 'gpt-5-codex');
		expect(usage?.model).toBe('gpt-5-codex');
	});

	it('lets a turn_context in the tail win over the model read from the head', () => {
		const usage = extractCodexUsageFromRollout(
			turnContext('gpt-5.1-codex') + tokenCount({ input: 5, output: 1 }),
			'gpt-5-codex',
		);
		expect(usage?.model).toBe('gpt-5.1-codex');
	});

	it('clamps a counter that goes backwards instead of subtracting', () => {
		// A fork or a compaction resets the cumulative total; that must cost one
		// segment, not corrupt the run's figure with a negative.
		const usage = extractCodexUsageFromRollout(
			[
				tokenCount({ input: 900, output: 90 }),
				tokenCount({ input: 10, output: 1 }),
				tokenCount({ input: 30, output: 3 }),
			].join(''),
		);
		expect(usage?.inputTokens).toBe(920);
		expect(usage?.outputTokens).toBe(92);
	});

	it('ignores a torn line, which a tail read always begins with', () => {
		const usage = extractCodexUsageFromRollout(
			`{"type":"event_msg","payload":{"type":"token_c${'\n'}${tokenCount({ input: 5, output: 1 })}`,
		);
		expect(usage?.inputTokens).toBe(5);
	});

	it('returns null when the rollout carries no usage at all', () => {
		expect(extractCodexUsageFromRollout('')).toBeNull();
		expect(extractCodexUsageFromRollout(turnContext('gpt-5-codex'))).toBeNull();
	});
});

describe('codexRolloutModel', () => {
	const turnContext = (model: string): string =>
		`${JSON.stringify({ type: 'turn_context', payload: { turn_id: 1, model } })}\n`;

	it('returns the first model named in the head of a rollout', () => {
		const head = `${JSON.stringify({ type: 'session_meta', payload: {} })}\n${turnContext('gpt-5-codex')}${turnContext('later')}`;
		expect(codexRolloutModel(head)).toBe('gpt-5-codex');
	});

	it('skips a torn record at the end of the head read', () => {
		const head = `${turnContext('gpt-5-codex').slice(0, 30)}`;
		expect(codexRolloutModel(head)).toBeUndefined();
		expect(codexRolloutModel(`${turnContext('gpt-5-codex')}{"type":"turn_context","pay`)).toBe(
			'gpt-5-codex',
		);
	});

	it('returns undefined when the head names no model', () => {
		expect(codexRolloutModel('')).toBeUndefined();
	});
});

describe('running usage and the end of a run', () => {
	const claudeAssistant = (id: string | undefined, usage: Record<string, number>) =>
		`${JSON.stringify({
			type: 'assistant',
			message: { id, role: 'assistant', usage, content: [{ type: 'text', text: 'working' }] },
		})}\n`;

	it('counts a Claude Code message once, however many content-block events restate it', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		// One API message split into three events, each restating its usage, then a
		// second message.
		for (let i = 0; i < 3; i++) {
			parser.onStdout(
				claudeAssistant('msg_1', {
					input_tokens: 100,
					cache_read_input_tokens: 1_000,
					output_tokens: 10,
				}),
			);
		}
		parser.onStdout(claudeAssistant('msg_2', { input_tokens: 50, output_tokens: 5 }));

		expect(parser.getUsage()?.inputTokens).toBe(1_150);
		expect(parser.getUsage()?.outputTokens).toBe(15);
	});

	it("takes a repeated Claude Code message's latest figure rather than adding it again", () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(claudeAssistant('msg_1', { input_tokens: 100, output_tokens: 1 }));
		parser.onStdout(claudeAssistant('msg_1', { input_tokens: 100, output_tokens: 30 }));
		// An event with no id cannot be matched, so it counts as a message of its own.
		parser.onStdout(claudeAssistant(undefined, { input_tokens: 7, output_tokens: 0 }));
		parser.onStdout(claudeAssistant(undefined, { input_tokens: 7, output_tokens: 0 }));

		expect(parser.getUsage()?.inputTokens).toBe(114);
		expect(parser.getUsage()?.outputTokens).toBe(30);
	});

	it('marks each runtime ended on the event that states its end, and not before', () => {
		const cases: Array<[AgentRuntime, string, string]> = [
			[
				AgentRuntime.ClaudeCode,
				claudeAssistant('msg_1', { input_tokens: 1, output_tokens: 1 }),
				`${JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
			],
			[
				AgentRuntime.Codex,
				`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } })}\n`,
				`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
			],
			[
				AgentRuntime.Antigravity,
				`${JSON.stringify({ event: 'init', init: { model: 'gemini-2.5-pro' } })}\n`,
				`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS' } })}\n`,
			],
			[
				AgentRuntime.Grok,
				`${JSON.stringify({ type: 'text', data: 'hi' })}\n`,
				`${JSON.stringify({ type: 'end', stopReason: 'end_turn' })}\n`,
			],
			[
				AgentRuntime.OpenCode,
				`${JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls', tokens: { input: 1, output: 1 } } })}\n`,
				`${JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 } } })}\n`,
			],
		];
		for (const [runtime, midRun, end] of cases) {
			const parser = createAgentStreamParser(runtime);
			parser.onStdout(midRun);
			expect(parser.hasEnded(), runtime).toBe(false);
			parser.onStdout(end);
			expect(parser.hasEnded(), runtime).toBe(true);
		}
	});

	it("counts every model in Claude Code's modelUsage, the judge included", () => {
		// Recorded shape from 2.1.280 with the Stop judge fired twice: `usage` covers
		// the main loop only, `modelUsage` adds the judge's sonnet calls.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(
			`${JSON.stringify({
				type: 'result',
				subtype: 'success',
				is_error: false,
				usage: {
					input_tokens: 4_604,
					cache_creation_input_tokens: 6_306,
					cache_read_input_tokens: 12_612,
					output_tokens: 242,
				},
				modelUsage: {
					'claude-opus-5': {
						inputTokens: 4_604,
						outputTokens: 242,
						cacheReadInputTokens: 12_612,
						cacheCreationInputTokens: 6_306,
						thinkingTokens: 0,
						costUSD: 0.0748,
					},
					'claude-sonnet-4-6': {
						inputTokens: 14_000,
						outputTokens: 140,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						thinkingTokens: 0,
						costUSD: 0.0441,
					},
				},
			})}\n`,
		);
		expect(parser.getUsage()?.buckets).toEqual({
			inputTokens: 18_604,
			cacheCreationTokens: 6_306,
			cacheReadTokens: 12_612,
			outputTokens: 382,
		});
	});

	it('follows a Claude Code run through a second turn without counting twice', () => {
		// A background Agent finishing starts a second turn: a second init and a
		// second result. `modelUsage` is session-cumulative, `usage` per turn.
		// Recorded from 2.1.280 (a subagent plus the judge).
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const result = (turn: Record<string, number>, cumulative: Record<string, unknown>) =>
			`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: turn, modelUsage: cumulative })}\n`;
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5' })}\n`,
		);
		parser.onStdout(
			result(
				{
					input_tokens: 802,
					cache_creation_input_tokens: 804,
					cache_read_input_tokens: 806,
					output_tokens: 82,
				},
				{
					'claude-opus-5': {
						inputTokens: 1_203,
						cacheCreationInputTokens: 1_206,
						cacheReadInputTokens: 1_209,
						outputTokens: 123,
					},
					'claude-sonnet-4-6': { inputTokens: 7_000, outputTokens: 70 },
				},
			),
		);
		expect(parser.hasEnded()).toBe(true);
		parser.onStdout(
			`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5' })}\n`,
		);
		// The ceiling applies again once the next turn starts.
		expect(parser.hasEnded()).toBe(false);
		parser.onStdout(claudeAssistant('msg_turn2', { input_tokens: 501, output_tokens: 51 }));
		expect(parser.getUsage()?.buckets?.inputTokens).toBe(8_203 + 501);
		parser.onStdout(
			result(
				{
					input_tokens: 501,
					cache_creation_input_tokens: 502,
					cache_read_input_tokens: 503,
					output_tokens: 51,
				},
				{
					'claude-opus-5': {
						inputTokens: 1_704,
						cacheCreationInputTokens: 1_708,
						cacheReadInputTokens: 1_712,
						outputTokens: 174,
					},
					'claude-sonnet-4-6': { inputTokens: 14_000, outputTokens: 140 },
				},
			),
		);
		expect(parser.hasEnded()).toBe(true);
		expect(parser.getUsage()?.buckets).toEqual({
			inputTokens: 15_704,
			cacheCreationTokens: 1_708,
			cacheReadTokens: 1_712,
			outputTokens: 314,
		});
	});

	it('adds a result that carries no modelUsage to what the last one settled', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const result = (extra: Record<string, unknown>) =>
			`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...extra })}\n`;
		parser.onStdout(
			result({
				usage: { input_tokens: 10, output_tokens: 1 },
				modelUsage: { 'claude-opus-5': { inputTokens: 30, outputTokens: 3 } },
			}),
		);
		parser.onStdout(result({ usage: { input_tokens: 5, output_tokens: 2 }, modelUsage: {} }));
		expect(parser.getUsage()?.inputTokens).toBe(35);
		expect(parser.getUsage()?.outputTokens).toBe(5);
	});

	it('logs a Claude Code background task killed when the run ended', () => {
		// Recorded from 2.1.280: a `run_in_background` shell still running at the
		// end of the turn is killed after 5 s, reported only after the result.
		const task = (extra: Record<string, unknown>) =>
			`${JSON.stringify({ type: 'system', task_id: 'basjra8bs', ...extra })}\n`;
		const started = task({
			subtype: 'task_started',
			tool_use_id: 'toolu_bg1',
			description: 'Sleep in background',
			is_backgrounded: true,
			task_type: 'local_bash',
		});
		const killed = [
			task({ subtype: 'task_updated', patch: { status: 'killed' } }),
			task({ subtype: 'task_notification', status: 'stopped', summary: 'Sleep in background' }),
		];
		const resultLine = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: {} })}\n`;

		const atExit = createAgentStreamParser(AgentRuntime.ClaudeCode);
		let out = atExit.onStdout(started) + atExit.onStdout(resultLine);
		for (const line of killed) out += atExit.onStdout(line);
		expect(out.match(/killed background task "Sleep in background"/g)).toHaveLength(1);

		// The model stopping its own task (TaskStop) looks the same, but comes
		// before the result.
		const stoppedByModel = createAgentStreamParser(AgentRuntime.ClaudeCode);
		let own = stoppedByModel.onStdout(started);
		for (const line of killed) own += stoppedByModel.onStdout(line);
		own += stoppedByModel.onStdout(resultLine);
		expect(own).not.toContain('killed background task');

		// A background task that finished is not a kill.
		const finished = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const done =
			finished.onStdout(started) +
			finished.onStdout(resultLine) +
			finished.onStdout(task({ subtype: 'task_notification', status: 'completed' }));
		expect(done).not.toContain('killed background task');
	});

	it('does not end an OpenCode run on a terminal-shaped event that states no reason', () => {
		// The type is matched by a substring rule, so an event that merely looks
		// terminal must not switch the per-run token stop off for the rest of a run
		// that is still going. The summary line is still written.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		parser.onStdout(
			`${JSON.stringify({ type: 'step_finish', part: { tokens: { input: 1, output: 1 } } })}\n`,
		);
		expect(parser.hasEnded()).toBe(false);
		parser.onStdout(
			`${JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 1, output: 1 } } })}\n`,
		);
		expect(parser.hasEnded()).toBe(true);
	});

	it('never marks a Kimi Code run ended, since its stream states no end', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		parser.onStdout(`${JSON.stringify({ role: 'assistant', content: 'done' })}\n`);
		parser.onStdout(
			`${JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 's1' })}\n`,
		);
		expect(parser.hasEnded()).toBe(false);
	});
});
