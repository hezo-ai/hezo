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

	it('still reports null when a run genuinely called nothing', () => {
		// "Not instrumented" and "called nothing" must stay distinguishable, so a
		// parser that saw no tool event reports null rather than an empty record.
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		parser.onStdout(line({ event: 'init', init: { model: 'gemini' } }));
		expect(parser.getToolCallCounts()).toBeNull();
		expect(parser.getToolCallTotal()).toBe(0);
	});

	it('counts an Antigravity tool step once, on the state that completes it', () => {
		// A step goes ACTIVE then DONE; counting both would double every call.
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		parser.onStdout(
			line({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE' } }),
		);
		parser.onStdout(
			line({
				event: 'step_update',
				step_update: { step_type: 'tool', state: 'DONE', tool_info: { name: 'read_file' } },
			}),
		);
		// A non-tool step is not a tool call.
		parser.onStdout(
			line({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE' } }),
		);
		expect(parser.getToolCallCounts()).toEqual({ read_file: 1 });
		expect(parser.getToolCallTotal()).toBe(1);
	});

	it('every runtime can be counted, so the ceiling has no unbounded backend', () => {
		// AGENTS.md: a backend that cannot do what the interface requires is
		// unsupported, not a second code path. If a new runtime lands without a
		// tally, its runs would silently ignore the per-run tool-call ceiling.
		for (const runtime of Object.values(AgentRuntime)) {
			const parser = createAgentStreamParser(runtime);
			expect(typeof parser.getToolCallTotal(), runtime).toBe('number');
		}
	});

	it('counts Grok tool calls across every spelling upstream ships', () => {
		// Field names are probed rather than picked: xAI carries two engine
		// generations with duplicated logging paths, and a spelling this misses
		// does not fail - it silently counts zero for the whole run.
		const parser = createAgentStreamParser(AgentRuntime.Grok);
		parser.onStdout(line({ type: 'tool_call', name: 'bash' }));
		parser.onStdout(line({ type: 'tool_call', toolName: 'bash' }));
		parser.onStdout(line({ type: 'tool_call', tool_name: 'read_file' }));
		parser.onStdout(line({ type: 'tool_call', function: { name: 'read_file' } }));
		expect(parser.getToolCallCounts()).toEqual({ bash: 2, read_file: 2 });
	});

	it('counts a Grok tool call once, not once per argument delta', () => {
		const parser = createAgentStreamParser(AgentRuntime.Grok);
		parser.onStdout(line({ type: 'tool_call', name: 'bash' }));
		parser.onStdout(line({ type: 'tool_call_update', name: 'bash' }));
		parser.onStdout(line({ type: 'tool_call_update', name: 'bash' }));
		expect(parser.getToolCallCounts()).toEqual({ bash: 1 });
	});
});
