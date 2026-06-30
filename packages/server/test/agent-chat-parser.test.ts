import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	type AgentChatTurnEvent,
	createAgentChatParser,
	createAgentStreamParser,
} from '../src/services/agent-stream-parser';

/**
 * The chat parser feeds the CEO real-time chat: it turns each runtime's
 * stream-json events into assistant text blocks (for the streaming bubble),
 * tool-activity hints (for the "working…" status line), and the terminal token
 * usage. It is pure logic, so we drive each runtime's parser with representative
 * event lines and assert the structured turn events it yields.
 */

const line = (event: unknown) => `${JSON.stringify(event)}\n`;

/** Collect both onStdout + flush output for an array of event objects. */
function feed(parser: ReturnType<typeof createAgentChatParser>, events: unknown[]) {
	const out: AgentChatTurnEvent[] = [];
	for (const e of events) out.push(...parser.onStdout(line(e)));
	out.push(...parser.flush());
	return out;
}

describe('agent-chat-parser — Claude Code', () => {
	it('emits assistant text blocks and tool activity, skipping empty text', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		const events = feed(parser, [
			{
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Hello there' },
						{ type: 'text', text: '   ' }, // whitespace-only is dropped
						{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } },
					],
				},
			},
		]);
		expect(events).toEqual([{ text: 'Hello there' }, { toolActivity: 'Edit' }]);
	});

	it('falls back to a generic tool label when the tool_use has no name', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		const events = feed(parser, [
			{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use' }] } },
		]);
		expect(events).toEqual([{ toolActivity: 'tool' }]);
	});

	it('captures usage from the terminal result, summing cache buckets into input', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		feed(parser, [
			{
				type: 'result',
				total_cost_usd: 0.25,
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 20,
					cache_read_input_tokens: 30,
				},
			},
		]);
		expect(parser.getUsage()).toEqual({ inputTokens: 150, outputTokens: 50, costCents: 25 });
	});

	it('handles a result event with no usage object (defaults to zero)', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		feed(parser, [{ type: 'result' }]);
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('reports null usage before any terminal event', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		expect(parser.getUsage()).toBeNull();
	});

	it('normalizes a string message body into a single text block', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		const events = feed(parser, [
			{ type: 'assistant', message: { role: 'assistant', content: 'plain string body' } },
		]);
		expect(events).toEqual([{ text: 'plain string body' }]);
	});

	it('drops lines that fail to parse and unknown event types', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		expect(parser.onStdout('not json\n')).toEqual([]);
		expect(parser.onStdout(line({ type: 'system', subtype: 'init', model: 'x' }))).toEqual([]);
	});
});

describe('agent-chat-parser — Codex', () => {
	it('renders an agent_message item as assistant text', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		const events = feed(parser, [
			{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
		]);
		expect(events).toEqual([{ text: 'Done.' }]);
	});

	it('reads assistant_message text from the message field', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		const events = feed(parser, [
			{ type: 'item.completed', item: { item_type: 'assistant_message', message: 'Via message' } },
		]);
		expect(events).toEqual([{ text: 'Via message' }]);
	});

	it('maps command execution and tool calls to tool-activity hints', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		const events = feed(parser, [
			{ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
			{ type: 'item.completed', item: { type: 'mcp_tool_call', name: 'search' } },
			{ type: 'item.completed', item: { type: 'tool_call' } }, // no name → 'tool'
		]);
		expect(events).toEqual([
			{ toolActivity: 'shell' },
			{ toolActivity: 'search' },
			{ toolActivity: 'tool' },
		]);
	});

	it('captures usage from turn.completed, folding reasoning into output', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		const events = feed(parser, [
			{
				type: 'turn.completed',
				usage: { input_tokens: 500, output_tokens: 40, reasoning_output_tokens: 10 },
			},
		]);
		expect(events).toEqual([]); // terminal events yield no chat text
		expect(parser.getUsage()).toEqual({ inputTokens: 500, outputTokens: 50, costCents: 0 });
	});

	it('captures usage from turn.failed too', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		feed(parser, [{ type: 'turn.failed', usage: { input_tokens: 7, output_tokens: 3 } }]);
		expect(parser.getUsage()).toEqual({ inputTokens: 7, outputTokens: 3, costCents: 0 });
	});

	it('drops empty agent messages and unknown item kinds', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		const events = feed(parser, [
			{ type: 'item.completed', item: { type: 'agent_message', text: '   ' } },
			{ type: 'item.completed', item: { type: 'reasoning', text: 'thinking quietly' } },
			{ type: 'thread.started', model: 'codex-x' },
		]);
		expect(events).toEqual([]);
	});
});

describe('agent-chat-parser — Gemini', () => {
	it('renders assistant message content and skips the user echo', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		const events = feed(parser, [
			{ type: 'message', role: 'user', content: 'the prompt' },
			{ type: 'message', role: 'assistant', content: 'The answer.' },
		]);
		expect(events).toEqual([{ text: 'The answer.' }]);
	});

	it('falls back to the text field when content is absent', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		const events = feed(parser, [{ type: 'message', text: 'from text field' }]);
		expect(events).toEqual([{ text: 'from text field' }]);
	});

	it('maps tool_use to a tool-activity hint', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		const events = feed(parser, [
			{ type: 'tool_use', name: 'web_search' },
			{ type: 'tool_use' }, // no name → 'tool'
		]);
		expect(events).toEqual([{ toolActivity: 'web_search' }, { toolActivity: 'tool' }]);
	});

	it('captures usage from the result event across models', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		feed(parser, [
			{
				type: 'result',
				stats: {
					models: {
						'gemini-2.5-pro': { tokens: { prompt: 1000, candidates: 100, thoughts: 20 } },
					},
				},
			},
		]);
		expect(parser.getUsage()).toEqual({ inputTokens: 1000, outputTokens: 120, costCents: 0 });
	});

	it('drops whitespace-only assistant messages', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		const events = feed(parser, [{ type: 'message', role: 'assistant', content: '   ' }]);
		expect(events).toEqual([]);
	});
});

describe('agent-chat-parser — generic (OpenCode)', () => {
	it('renders assistant text and tool activity, skipping user-role events', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		const events = feed(parser, [
			{ type: 'message', role: 'user', text: 'prompt' },
			{ type: 'message', role: 'assistant', text: 'Hi' },
			{ type: 'tool_use', name: 'bash', input: { command: 'ls' } },
		]);
		expect(events).toEqual([{ text: 'Hi' }, { toolActivity: 'bash' }]);
	});

	it('captures usage from a terminal event carrying tokens', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		feed(parser, [
			{ type: 'init', model: 'opencode-model' },
			{ type: 'result', usage: { input_tokens: 300, output_tokens: 60 } },
		]);
		expect(parser.getUsage()).toEqual({ inputTokens: 300, outputTokens: 60, costCents: 0 });
	});

	it('drops non-object lines and unrecognized events', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		expect(parser.onStdout('123\n')).toEqual([]); // valid JSON, but not a record
		expect(parser.onStdout(line({ type: 'session.status', status: 'busy' }))).toEqual([]);
	});

	it('flushes a trailing partial line with no newline', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		const serialized = JSON.stringify({ type: 'message', role: 'assistant', text: 'tail' });
		const half = Math.floor(serialized.length / 2);
		expect(parser.onStdout(serialized.slice(0, half))).toEqual([]);
		expect(parser.onStdout(serialized.slice(half))).toEqual([]); // still buffered, no newline
		expect(parser.flush()).toEqual([{ text: 'tail' }]);
	});
});

describe('agent-chat-parser — unsupported runtime', () => {
	it('returns a no-op parser for an unknown runtime', () => {
		const parser = createAgentChatParser('made_up' as AgentRuntime);
		expect(parser.onStdout(line({ type: 'message', text: 'x' }))).toEqual([]);
		expect(parser.flush()).toEqual([]);
		expect(parser.getUsage()).toBeNull();
	});
});

/**
 * A handful of log-parser branches that the existing agent-stream-parser.test.ts
 * doesn't reach: the passthrough runtime, empty-string error classification, the
 * Codex `error` event, Gemini `tool_result`/`error` rendering, the empty
 * thinking block, and array-shaped tool_result content.
 */
describe('agent-stream-parser — remaining log branches', () => {
	it('passthrough runtime echoes raw stdout/stderr verbatim', () => {
		const parser = createAgentStreamParser('totally_unknown' as AgentRuntime);
		expect(parser.onStdout('raw line\n')).toBe('raw line\n');
		expect(parser.onStderr('err line\n')).toBe('err line\n');
		expect(parser.flush()).toBe('');
		expect(parser.getUsage()).toBeNull();
		expect(parser.getTerminalError()).toBeNull();
	});

	it('Codex surfaces an error event as a [tool-error] line', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = parser.onStdout(line({ type: 'error', error: { message: 'rate   limited' } }));
		expect(out).toBe('[tool-error] rate limited\n');
	});

	it('Codex drops an error event with no message', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(parser.onStdout(line({ type: 'error' }))).toBe('');
	});

	it('Gemini renders a tool_result and a tool_error distinctly', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(parser.onStdout(line({ type: 'tool_result', output: 'all good' }))).toBe(
			'[tool-result] all good\n',
		);
		expect(parser.onStdout(line({ type: 'tool_result', is_error: true, result: 'boom' }))).toBe(
			'[tool-error] boom\n',
		);
	});

	it('Gemini renders a bare tool_result label when the body is empty', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(parser.onStdout(line({ type: 'tool_result' }))).toBe('[tool-result]\n');
	});

	it('Gemini surfaces an error event as a plain line and marks the result error', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(parser.onStdout(line({ type: 'error', message: 'quota exceeded' }))).toBe(
			'quota exceeded\n',
		);
		const done = parser.onStdout(line({ type: 'result', error: { message: 'x' }, stats: {} }));
		expect(done).toBe('[done] error tokens=0/0\n');
	});

	it('renders a tool_use tool with object input the runner can preview', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const out = parser.onStdout(line({ type: 'tool_use', name: 'grep', args: { pattern: 'foo' } }));
		expect(out).toContain('[tool] grep(');
		expect(out).toContain('pattern=foo');
	});

	it('renders an empty thinking block as the bare [thinking] label', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = parser.onStdout(
			line({
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] },
			}),
		);
		expect(out).toBe('[thinking]\n');
	});

	it('extracts array-shaped tool_result content (Claude)', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = parser.onStdout(
			line({
				type: 'user',
				message: {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							content: [{ type: 'text', text: 'part one' }, 'part two', { irrelevant: true }],
						},
					],
				},
			}),
		);
		expect(out).toBe('[tool-result] part one part two\n');
	});
});
