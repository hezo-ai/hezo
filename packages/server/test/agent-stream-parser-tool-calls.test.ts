import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { createAgentStreamParser } from '../src/services/agent-stream-parser';

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

/** One Claude Code assistant turn carrying `calls` tool_use blocks. */
const claudeTurn = (...names: string[]) =>
	line({
		type: 'assistant',
		message: {
			role: 'assistant',
			content: names.map((name) => ({ type: 'tool_use', name, input: { a: 1 } })),
		},
	});

describe('getToolCallCounts', () => {
	it('counts each tool call, keyed by the name the runtime puts on the wire', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(claudeTurn('mcp__hezo__create_comment', 'Bash'));
		parser.onStdout(claudeTurn('mcp__hezo__create_comment', 'mcp__typefully__list_drafts'));
		expect(parser.getToolCallCounts()).toEqual({
			mcp__hezo__create_comment: 2,
			Bash: 1,
			mcp__typefully__list_drafts: 1,
		});
	});

	it('is null before any tool call, not an empty object', () => {
		// "Not instrumented" and "called nothing" lead to different conclusions, and
		// only the second is actionable - the same distinction mcp_tool_counts keeps.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.getToolCallCounts()).toBeNull();
		parser.onStdout(line({ type: 'system', subtype: 'init', model: 'claude-x', tools: [] }));
		expect(parser.getToolCallCounts()).toBeNull();
	});

	it('answers a different question from getMcpToolCounts', () => {
		// One server offering 2 tools, of which the run calls exactly one, twice.
		// Offered and called must not be conflated: that gap is the whole point.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout(
			line({
				type: 'system',
				subtype: 'init',
				model: 'claude-x',
				tools: ['mcp__hezo__get_task', 'mcp__hezo__create_comment'],
				mcp_servers: [{ name: 'hezo', status: 'connected' }],
			}),
		);
		parser.onStdout(claudeTurn('mcp__hezo__get_task', 'mcp__hezo__get_task'));
		expect(parser.getMcpToolCounts()).toEqual({ hezo: 2 });
		expect(parser.getToolCallCounts()).toEqual({ mcp__hezo__get_task: 2 });
	});

	it('tallies Codex MCP tool calls', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		for (const tool of ['get_skill', 'get_skill', 'read_project_doc']) {
			parser.onStdout(
				line({
					type: 'item.completed',
					item: {
						type: 'mcp_tool_call',
						server: 'hezo',
						tool,
						arguments: {},
						status: 'completed',
						result: { content: [{ type: 'text', text: 'ok' }] },
					},
				}),
			);
		}
		const counts = parser.getToolCallCounts() ?? {};
		expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(3);
	});

	it('tallies OpenCode tool calls', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		parser.onStdout(line({ type: 'tool_use', name: 'bash', input: { command: 'ls' } }));
		parser.onStdout(line({ type: 'tool_use', name: 'bash', input: { command: 'pwd' } }));
		expect(parser.getToolCallCounts()).toEqual({ bash: 2 });
	});

	it('tallies Kimi Code tool calls', () => {
		const parser = createAgentStreamParser(AgentRuntime.Kimi);
		parser.onStdout(
			line({
				role: 'assistant',
				content: '',
				tool_calls: [
					{ type: 'function', id: 'c1', function: { name: 'Read', arguments: '{"path":"/a"}' } },
					{ type: 'function', id: 'c2', function: { name: 'Read', arguments: '{"path":"/b"}' } },
				],
			}),
		);
		expect(parser.getToolCallCounts()).toEqual({ Read: 2 });
	});

	it('does not pool counts across concurrent parsers', () => {
		// The tally is per parser instance. A module-level one would merge the tool
		// calls of every run executing at the same time.
		const a = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const b = createAgentStreamParser(AgentRuntime.ClaudeCode);
		a.onStdout(claudeTurn('Bash'));
		b.onStdout(claudeTurn('Read'));
		expect(a.getToolCallCounts()).toEqual({ Bash: 1 });
		expect(b.getToolCallCounts()).toEqual({ Read: 1 });
	});

	it('reports null for the runtimes whose parsers render no tool events', () => {
		// Grok's tool calls arrive as a type its parser drops; Antigravity handles
		// only init/step_update/result. Neither can be instrumented without first
		// teaching its parser to render tool calls, so both must read as "not
		// instrumented" rather than as runs that called nothing.
		for (const runtime of [AgentRuntime.Grok, AgentRuntime.Antigravity]) {
			const parser = createAgentStreamParser(runtime);
			parser.onStdout(line({ type: 'assistant', content: 'hello' }));
			expect(parser.getToolCallCounts(), runtime).toBeNull();
		}
	});
});
