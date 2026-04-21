import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { createAgentStreamParser } from '../../services/agent-stream-parser';

describe('agent-stream-parser', () => {
	it('passes non-claude runtimes through unchanged', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(parser.onStdout('some raw text\n')).toBe('some raw text\n');
		expect(parser.onStderr('error line\n')).toBe('error line\n');
		expect(parser.flush()).toBe('');
		expect(parser.getUsage()).toBeNull();
	});

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
});
