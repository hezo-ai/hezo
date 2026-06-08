import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { createAgentStreamParser } from '../src/services/agent-stream-parser';

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

	it('captures usage and cost from the result event', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
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
		expect(out).toContain('[done] success turns=3 duration=2000ms tokens=150/50 cost=$0.4567');

		const usage = parser.getUsage();
		expect(usage).not.toBeNull();
		expect(usage?.inputTokens).toBe(150);
		expect(usage?.outputTokens).toBe(50);
		expect(usage?.costCents).toBe(46);
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
});
