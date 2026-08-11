import { AgentRuntime, type CostTokens } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	createAgentChatParser,
	createAgentStreamParser,
	type PriceModelFn,
} from '../src/services/agent-stream-parser';

/**
 * Branch-coverage sweep for agent-stream-parser.ts. The existing
 * agent-stream-parser.test.ts / agent-chat-parser.test.ts /
 * agent-stream-parser-coverage.test.ts cover the happy paths; this file
 * targets the remaining conditional arms: ??/||/?: fallbacks, optional-chain
 * short-circuits, the loose generic-parser field probes, and the shared
 * rendering helpers (renderToolInput / stringifyArg / formatThinking / etc.) at
 * their edges. Pure functions — we feed crafted JSONL and assert exact output.
 */

const line = (event: unknown) => `${JSON.stringify(event)}\n`;

function feed(parser: ReturnType<typeof createAgentStreamParser>, events: unknown[]): string {
	return parser.onStdout(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// classifyRuntimeError — remaining regex arms (each alternation branch)
// ---------------------------------------------------------------------------

describe('classifyRuntimeError — individual regex alternations (via Claude result)', () => {
	const reasonFor = (raw: string): string | null => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [{ type: 'result', is_error: true, result: raw, usage: {} }]);
		return parser.getTerminalError();
	};

	it('matches insufficient funds / credit phrasings for the quota branch', () => {
		expect(reasonFor('insufficient funds')).toContain('credit/quota');
		expect(reasonFor('insufficient credit on account')).toContain('credit/quota');
		expect(reasonFor('payment required to continue')).toContain('credit/quota');
	});

	it('matches the unauthorized / invalid-key phrasings for the auth branch', () => {
		expect(reasonFor('Request unauthorized')).toContain('authentication failed');
		expect(reasonFor('invalid x-api-key supplied')).toContain('authentication failed');
	});

	it('keeps an existing terminalError when a later result has no classifiable reason', () => {
		// `classifyRuntimeError(...) ?? terminalError` — first result sets it, an
		// empty-result error event must not blank it back to null.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [{ type: 'result', is_error: true, result: '401 unauthorized', usage: {} }]);
		expect(parser.getTerminalError()).toContain('authentication failed');
		// is_error true but result is empty → classify returns null → keep prior.
		feed(parser, [{ type: 'result', is_error: true, result: '', usage: {} }]);
		expect(parser.getTerminalError()).toContain('authentication failed');
	});
});

// ---------------------------------------------------------------------------
// Claude Code parser — fallback arms
// ---------------------------------------------------------------------------

describe('Claude Code — session/init fallback arms', () => {
	it('falls back to model=unknown and tools=0 when model is absent and tools is not an array', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		// no `model` field; `tools` present but not an array → Array.isArray false arm.
		const out = feed(parser, [{ type: 'system', subtype: 'init', tools: { not: 'an array' } }]);
		expect(out).toBe('[session] model=unknown tools=0\n');
	});

	it('counts tools when they are an array', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{ type: 'system', subtype: 'init', model: 'm', tools: ['a', 'b', 'c'] },
		]);
		expect(out).toBe('[session] model=m tools=3\n');
	});

	it('records a terminal error when the Hezo MCP server did not connect', () => {
		// The transcript this comes from: the tunnel died, the MCP server could not
		// be reached, and the agent ran a full max-effort budget with 25 built-in
		// tools and none of Hezo's. Claude Code reported the failure in this very
		// event and nothing read it, so the run was recorded as "produced no
		// output" - which blames the model for a dead transport.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'deepseek-v4-pro',
				tools: Array.from({ length: 25 }, (_, i) => `builtin-${i}`),
				mcp_servers: [{ name: 'hezo', status: 'failed' }],
			},
		]);

		expect(out).toContain('mcp: hezo=failed');
		const terminal = parser.getTerminalError();
		expect(terminal).toContain('Hezo MCP server did not connect');
		// Names the transport, because that is where the fix is.
		expect(terminal).toContain('tunnel');
	});

	it('stays silent when the Hezo MCP server connected', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: ['a'],
				mcp_servers: [{ name: 'hezo', status: 'connected' }],
			},
		]);
		expect(out).toContain('mcp: hezo=connected');
		expect(parser.getTerminalError()).toBeNull();
	});

	it('treats `pending` as "not yet", because that is what a healthy run reports', () => {
		// Measured on Claude Code 2.1.220 against a live backend: MCP servers connect
		// asynchronously *after* `init`, so a healthy run's init says `pending` and
		// lists the built-ins only (the CLI ships `WaitForMcpServers` for exactly
		// this). The first cut of this check read anything-but-connected as a
		// failure, which would have failed every Claude Code run on that CLI.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'deepseek-v4-flash',
				tools: Array.from({ length: 20 }, (_, i) => `builtin-${i}`),
				mcp_servers: [{ name: 'hezo', status: 'pending' }],
			},
		]);

		// Still recorded verbatim - the operator gets to see it, they just are not
		// told the run is doomed on the strength of it.
		expect(out).toContain('mcp: hezo=pending');
		expect(parser.getTerminalError()).toBeNull();
	});

	it('does not fail a run on a status the CLI has never emitted before', () => {
		// The same lesson generalised: an unknown string is "we do not know", not
		// "it failed". A CLI upgrade that renames or adds a status must not take
		// every run down with it.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: ['a'],
				mcp_servers: [{ name: 'hezo', status: 'reconnecting-v2' }],
			},
		]);
		expect(parser.getTerminalError()).toBeNull();
	});

	it('does not invent a failure when the runtime reports no MCP servers at all', () => {
		// An older CLI that never sends the array told us nothing, which is not the
		// same as telling us the server failed. The tunnel's own guard is the
		// backstop there; guessing here would fail healthy runs.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [{ type: 'system', subtype: 'init', model: 'm', tools: ['a'] }]);
		expect(out).toBe('[session] model=m tools=1\n');
		expect(parser.getTerminalError()).toBeNull();
	});

	it('ignores a server entry for a different MCP server', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: ['a'],
				mcp_servers: [{ name: 'github', status: 'failed' }],
			},
		]);
		// A connector failing is the connector's problem, not a toolless run.
		expect(parser.getTerminalError()).toBeNull();
	});

	it('ignores a system event whose subtype is not init', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(feed(parser, [{ type: 'system', subtype: 'other' }])).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Claude Code — per-server tool counts in the session line
// ---------------------------------------------------------------------------

describe('Claude Code — per-server MCP tool counts', () => {
	it("counts each server's tools from the mcp__<server>__<tool> namespace", () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: [
					'Bash',
					'Read',
					'mcp__hezo__list_tasks',
					'mcp__hezo__create_comment',
					'mcp__typefully__typefully_list_drafts',
				],
				mcp_servers: [
					{ name: 'hezo', status: 'connected' },
					{ name: 'typefully', status: 'connected' },
				],
			},
		]);
		expect(out).toContain('tools=5 mcp: hezo=connected(2) typefully=connected(1)');
		// Kept past the log line so the runner can persist it and `list_connectors`
		// can answer the same question from inside the run.
		expect(parser.getMcpToolCounts()).toEqual({ hezo: 2, typefully: 1 });
	});

	it('exposes a zero count, which is the actionable one', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: ['Bash', 'mcp__hezo__list_tasks'],
				mcp_servers: [
					{ name: 'hezo', status: 'connected' },
					{ name: 'typefully', status: 'connected' },
				],
			},
		]);
		expect(parser.getMcpToolCounts()).toEqual({ hezo: 1, typefully: 0 });
	});

	it('reports null counts, not zeroes, when no tool name could be parsed', () => {
		// "not measured" and "measured zero" lead to different conclusions, so an
		// unreadable tools array must not masquerade as a server contributing none.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: [{ unexpected: 'shape' }, 42],
				mcp_servers: [{ name: 'hezo', status: 'connected' }],
			},
		]);
		expect(parser.getMcpToolCounts()).toBeNull();
	});

	it('reports null counts before any init event, and on a runtime that emits none', () => {
		expect(createAgentStreamParser(AgentRuntime.ClaudeCode).getMcpToolCounts()).toBeNull();
		expect(createAgentStreamParser(AgentRuntime.Codex).getMcpToolCounts()).toBeNull();
		expect(createAgentStreamParser(AgentRuntime.Gemini).getMcpToolCounts()).toBeNull();
	});

	it('warns when a server reports connected but contributed no tools', () => {
		// The failure this exists to surface: the transport came up, so the status
		// reads healthy, but the runtime deferred the tool list behind its own
		// search tool and none of the server's tools reached the model.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'deepseek-v4-pro',
				tools: ['Bash', 'mcp__hezo__list_tasks'],
				mcp_servers: [
					{ name: 'hezo', status: 'connected' },
					{ name: 'typefully', status: 'connected' },
				],
			},
		]);
		expect(out).toContain('typefully=connected(0)');
		expect(out).toContain('MCP server "typefully" connected but contributed no tools');
		// The server that did contribute is not warned about.
		expect(out).not.toContain('"hezo" connected but contributed no tools');
		// A discovery gap, not a run-ending one.
		expect(parser.getTerminalError()).toBeNull();
	});

	it('does not warn about a server that has not finished connecting', () => {
		// `pending` at init is what a healthy run reports - the servers connect
		// asynchronously afterwards - so zero tools there means nothing yet.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: ['Bash'],
				mcp_servers: [{ name: 'typefully', status: 'pending' }],
			},
		]);
		expect(out).toContain('typefully=pending(0)');
		expect(out).not.toContain('contributed no tools');
	});

	it('omits the counts entirely when no tool name can be read', () => {
		// A shape change in the CLI's `tools` array must degrade to "no per-server
		// numbers", never to a misleading zero against every server.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: [{ unexpected: 'shape' }, 42],
				mcp_servers: [{ name: 'hezo', status: 'connected' }],
			},
		]);
		expect(out).toContain('tools=2 mcp: hezo=connected');
		expect(out).not.toContain('hezo=connected(');
		expect(out).not.toContain('contributed no tools');
	});

	it('reads a name off an object entry as well as a bare string', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: [{ name: 'mcp__hezo__get_task' }, 'mcp__hezo__list_tasks'],
				mcp_servers: [{ name: 'hezo', status: 'connected' }],
			},
		]);
		expect(out).toContain('hezo=connected(2)');
	});

	it('counts correctly for a connector whose own name contains the separator', () => {
		// Counting by the server names the event reports, rather than splitting on
		// `__`, is what keeps this right.
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'system',
				subtype: 'init',
				model: 'm',
				tools: ['mcp__od__d__alpha', 'mcp__od__d__beta'],
				mcp_servers: [{ name: 'od__d', status: 'connected' }],
			},
		]);
		expect(out).toContain('od__d=connected(2)');
	});
});

describe('Claude Code — assistant usage edge arms', () => {
	it('renders text without usage when message.usage is absent (mu falsy arm)', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
			},
		]);
		expect(out).toBe('hi\n');
		expect(parser.getUsage()).toBeNull();
	});

	it('stops accumulating assistant usage once the terminal result has been seen', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [
			{
				type: 'result',
				subtype: 'success',
				is_error: false,
				usage: { input_tokens: 5, output_tokens: 2 },
			},
		]);
		// After result, sawResult=true → the !sawResult arm is false, usage unchanged.
		feed(parser, [
			{
				type: 'assistant',
				message: { role: 'assistant', usage: { input_tokens: 999, output_tokens: 999 } },
			},
		]);
		expect(parser.getUsage()).toEqual({ inputTokens: 5, outputTokens: 2, costCents: 0 });
	});

	it('handles assistant usage fields all defaulting to zero', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		feed(parser, [{ type: 'assistant', message: { role: 'assistant', usage: {} } }]);
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('ignores an assistant event with no message', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(feed(parser, [{ type: 'assistant' }])).toBe('');
	});
});

describe('Claude Code — user/result edge arms', () => {
	it('drops non-tool_result blocks inside a user message', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'echoed prompt' }] },
			},
		]);
		expect(out).toBe('');
	});

	it('ignores a user event with no message', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(feed(parser, [{ type: 'user' }])).toBe('');
	});

	it('uses subtype as status on a successful result and defaults duration/turns/cost to zero', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [{ type: 'result', subtype: 'success', is_error: false, usage: {} }]);
		expect(out).toBe('[done] success turns=0 duration=0ms tokens=0/0 cost=$0.0000\n');
	});

	it('falls back to status=success when result has neither is_error nor subtype', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [{ type: 'result', usage: {} }]);
		expect(out).toContain('[done] success turns=0');
	});

	it('emits error status and no usage object on result (usage ?? {} arm)', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [{ type: 'result', is_error: true, result: 'weird custom failure' }]);
		expect(out).toContain('[done] error turns=0');
		expect(parser.getTerminalError()).toBe('weird custom failure');
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('ignores an entirely unknown top-level event type', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(feed(parser, [{ type: 'stream_event', foo: 'bar' }])).toBe('');
	});
});

// ---------------------------------------------------------------------------
// Codex parser — fallback arms
// ---------------------------------------------------------------------------

describe('Codex — thread.started + item edge arms', () => {
	it('falls back to model=codex when thread.started carries no model', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(feed(parser, [{ type: 'thread.started' }])).toBe('[session] model=codex tools=0\n');
	});

	it('defaults turn.completed usage fields to zero when usage is absent', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [{ type: 'turn.completed' }]);
		expect(out).toBe('[done] success turns=1 tokens=0/0\n');
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('renders a command with output but no command string (cmd empty arm)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			{
				type: 'item.completed',
				item: { type: 'command_execution', output: 'just output', exit_code: 0 },
			},
		]);
		// No [tool] shell(...) line since command was empty; only the result.
		expect(out).toBe('[tool-result] just output\n');
	});

	it('renders a command string with no output (output empty arm)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			{ type: 'item.completed', item: { type: 'command_execution', command: 'true' } },
		]);
		expect(out).toBe('[tool] shell(true)\n');
	});

	it('treats a non-numeric exit_code as success (typeof number false arm)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			{
				type: 'item.completed',
				item: { type: 'command_execution', command: 'x', output: 'ok', exit_code: 'oops' },
			},
		]);
		expect(out).toContain('[tool-result] ok');
		expect(out).not.toContain('[tool-error]');
	});

	it('renders a plain tool_call item using the args fallback for input', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			{ type: 'item.completed', item: { type: 'tool_call', name: 'lookup', args: { id: 7 } } },
		]);
		expect(out).toContain('[tool] lookup(');
		expect(out).toContain('id=7');
	});

	it('falls back to tool name "tool" when a tool_call item has no name', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [{ type: 'item.completed', item: { type: 'tool_call' } }]);
		expect(out).toBe('[tool] tool()\n');
	});

	it('renders agent_message via the text field directly', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(
			feed(parser, [{ type: 'item.completed', item: { type: 'agent_message', text: 'plain' } }]),
		).toBe('plain\n');
	});

	it('drops an empty agent_message item', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(
			feed(parser, [{ type: 'item.completed', item: { type: 'agent_message', text: '  ' } }]),
		).toBe('');
	});

	it('ignores item.completed with no item present', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(feed(parser, [{ type: 'item.completed' }])).toBe('');
	});

	it('surfaces a string-shaped error event', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(feed(parser, [{ type: 'error', error: 'string failure mode' }])).toBe(
			'[tool-error] string failure mode\n',
		);
	});

	it('surfaces an error event via the message fallback when error is absent', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(feed(parser, [{ type: 'error', message: 'fallback msg' }])).toBe(
			'[tool-error] fallback msg\n',
		);
	});

	it('drops an empty reasoning item', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(feed(parser, [{ type: 'item.completed', item: { type: 'reasoning', text: '' } }])).toBe(
			'',
		);
	});
});

// ---------------------------------------------------------------------------
// Gemini parser — fallback arms
// ---------------------------------------------------------------------------

describe('Gemini — message/tool/result edge arms', () => {
	it('falls back to model=gemini when init has no model', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'init' }])).toBe('[session] model=gemini tools=0\n');
	});

	it('reads message text from the text field when content is absent', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		// Buffered until the chunk run ends, so the flush is what emits it.
		expect(feed(parser, [{ type: 'message', text: 'via text' }, { type: 'result' }])).toContain(
			'via text',
		);
	});

	it('drops a whitespace-only assistant message', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'message', content: '   ' }])).toBe('');
	});

	it('renders tool_use using the input field (not args)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const out = feed(parser, [{ type: 'tool_use', name: 'read', input: { path: '/x' } }]);
		expect(out).toContain('[tool] read(');
		expect(out).toContain('path=/x');
	});

	it('falls back to tool name "tool" when tool_use has no name', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'tool_use' }])).toBe('[tool] tool()\n');
	});

	it('reads tool_result body from result field when output is absent', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'tool_result', result: 'from result' }])).toBe(
			'[tool-result] from result\n',
		);
	});

	it('reports a success result with no stats (undefined stats arm)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const out = feed(parser, [{ type: 'result' }]);
		expect(out).toBe('[done] success tokens=0/0\n');
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('drops an error event with no extractable message', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'error' }])).toBe('');
	});

	it('ignores an unknown gemini event type', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'turn.delta' }])).toBe('');
	});

	it('skips a model entry that has no tokens object when summing', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		feed(parser, [
			{
				type: 'result',
				stats: {
					models: { 'with-tokens': { tokens: { prompt: 10, candidates: 3 } }, 'no-tokens': {} },
				},
			},
		]);
		expect(parser.getUsage()).toEqual({ inputTokens: 10, outputTokens: 3, costCents: 0 });
	});
});

// ---------------------------------------------------------------------------
// Generic parser (OpenCode) — field-probe arms
// ---------------------------------------------------------------------------

describe('generic parser — extractGenericText arms', () => {
	it('reads from the output_text field (last of the direct keys)', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'message', output_text: 'spoke' }])).toBe('spoke\n');
	});

	it('reads from a string-valued part field', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'message', part: 'string part' }])).toBe('string part\n');
	});

	it('skips a nested user/tool-role object and keeps scanning', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		// delta is a user-role record (continue), message holds the real text.
		const out = feed(parser, [
			{ type: 'event', delta: { role: 'user', text: 'nope' }, message: { text: 'yep' } },
		]);
		expect(out).toBe('yep\n');
	});

	it('joins text from a nested content array', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = feed(parser, [
			{ type: 'event', message: { content: [{ text: 'a' }, { notText: 1 }, { text: 'b' }] } },
		]);
		expect(out).toBe('a b\n');
	});

	it('skips a tool-role top-level event (returns no text)', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'message', role: 'tool', text: 'tool output' }])).toBe('');
	});

	it('drops an event with no recoverable text', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'something', foo: 'bar' }])).toBe('');
	});

	it('ignores a nested content array that yields only empty strings', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(
			feed(parser, [{ type: 'event', message: { content: [{ notText: 1 }, 'str-not-record'] } }]),
		).toBe('');
	});
});

describe('generic parser — extractGenericTool arms', () => {
	it('detects a tool by a tool-ish type even without a name', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'shell_command' }])).toBe('[tool] tool()\n');
	});

	it('detects a tool by an explicit name on a non-toolish type', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = feed(parser, [{ type: 'step', name: 'grep', input: { q: 'z' } }]);
		expect(out).toContain('[tool] grep(');
		expect(out).toContain('q=z');
	});

	it('detects a tool from a nested part.name', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = feed(parser, [{ type: 'step', part: { tool_name: 'fetcher' } }]);
		expect(out).toBe('[tool] fetcher()\n');
	});

	it('renders a tool using the arguments field for input', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = feed(parser, [{ type: 'function_call', name: 'do', arguments: { a: 1 } }]);
		expect(out).toContain('[tool] do(');
		expect(out).toContain('a=1');
	});
});

describe('generic parser — usage/error/terminal arms', () => {
	it('prefers the tokens object when usage is absent', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, () => 0);
		feed(parser, [{ type: 'metrics', tokens: { input: 12, output: 4 } }]);
		expect(parser.getUsage()).toEqual({ inputTokens: 12, outputTokens: 4, costCents: 0 });
	});

	it('falls back to the stats object for usage', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, () => 0);
		feed(parser, [{ type: 'metrics', stats: { prompt: 7, candidates: 2 } }]);
		expect(parser.getUsage()).toEqual({ inputTokens: 7, outputTokens: 2, costCents: 0 });
	});

	it('returns null usage when there is no usage object and no cost', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		feed(parser, [{ type: 'message', text: 'just text' }]);
		expect(parser.getUsage()).toBeNull();
	});

	it('returns null usage when a usage object is present but all-zero', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		feed(parser, [{ type: 'metrics', usage: { input_tokens: 0, output_tokens: 0 } }]);
		expect(parser.getUsage()).toBeNull();
	});

	it('ignores a bare total_cost_usd with no token object present', () => {
		// A reported dollar figure alone is not usage — tokens are the only
		// authoritative signal, and cost is always computed from them.
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		feed(parser, [{ type: 'usage', total_cost_usd: 0.5 }]);
		expect(parser.getUsage()).toBeNull();
	});

	it('records the model from a model field for later pricing', () => {
		const seen: Array<string | undefined> = [];
		const price: PriceModelFn = (m: string | undefined, _t: CostTokens) => {
			seen.push(m);
			return 1;
		};
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, price);
		feed(parser, [
			{ type: 'session', model: 'kimi-9' },
			{ type: 'usage', usage: { input_tokens: 5, output_tokens: 2 } },
		]);
		// Priced when the total is read, not per event: the counts arrive per step
		// and only their sum is what the run is charged for.
		parser.getUsage();
		expect(seen).toContain('kimi-9');
	});

	it('matches a generic error type and renders a [tool-error] line', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'run_failed', error: 'whoops' }])).toBe('[tool-error] whoops\n');
	});

	it('drops an error-typed event when there is no error message to show', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'failed' }])).toBe('');
	});

	it('renders thinking text for a think-typed event', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'thinking', thinking: 'pondering' }])).toBe(
			'[thinking] pondering\n',
		);
	});

	it('drops a reasoning-typed event with no text', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'reasoning' }])).toBe('');
	});

	it('does not emit a done line for a terminal-typed event without captured usage', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		// type matches GENERIC_TERMINAL_RE ("complete") but no usage → no done line.
		expect(feed(parser, [{ type: 'task.complete' }])).toBe('');
	});

	it('emits a done line for a finish-typed event carrying usage', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		const out = feed(parser, [{ type: 'finish', usage: { input_tokens: 3, output_tokens: 9 } }]);
		expect(out).toBe('[done] success tokens=3/9\n');
	});

	it('captures usage on a non-terminal-typed event without emitting a done line', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		// type doesn't match GENERIC_TERMINAL_RE → usage captured, no done line emitted.
		const out = feed(parser, [{ type: 'usage', usage: { input_tokens: 3, output_tokens: 9 } }]);
		expect(out).toBe('');
		expect(parser.getUsage()).toEqual({ inputTokens: 3, outputTokens: 9, costCents: 0 });
	});

	it('ignores a non-finite number when probing usage fields', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		// Infinity/NaN aren't finite → firstNumber skips them; no other tokens → null.
		feed(parser, [{ type: 'metrics', usage: { input_tokens: Number.POSITIVE_INFINITY } }]);
		expect(parser.getUsage()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Shared rendering helpers — exercised through the parsers
// ---------------------------------------------------------------------------

describe('renderToolInput / stringifyArg arms', () => {
	it('renders a scalar (non-object) tool input via String()', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'tool_use', name: 'echo', input: 42 }])).toBe('[tool] echo(42)\n');
	});

	it('renders a tool with null input as name()', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'tool_use', name: 'noargs', input: null }])).toBe(
			'[tool] noargs()\n',
		);
	});

	it('renders a tool with an empty-object input as name()', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		expect(feed(parser, [{ type: 'tool_use', name: 'empty', input: {} }])).toBe('[tool] empty()\n');
	});

	it('collapses whitespace in a string tool argument', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const out = feed(parser, [{ type: 'tool_use', name: 'run', input: { cmd: 'a\n\t  b' } }]);
		expect(out).toBe('[tool] run(cmd=a b)\n');
	});

	it('JSON-stringifies a non-string tool argument value', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const out = feed(parser, [
			{ type: 'tool_use', name: 'cfg', input: { flag: true, nums: [1, 2] } },
		]);
		expect(out).toContain('flag=true');
		expect(out).toContain('nums=[1,2]');
	});

	it('keeps a long per-argument value in full (no truncation, no ellipsis)', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const long = 'x'.repeat(2000);
		const out = feed(parser, [{ type: 'tool_use', name: 'big', input: { v: long } }]);
		// The whole value is recorded verbatim; nothing is clipped.
		expect(out).toContain(`v=${long}`);
		expect(out).not.toContain('…');
	});
});

describe('full-length lines (no per-line cap — the whole run log is recorded)', () => {
	it('keeps a long collapsed thinking line in full without an ellipsis', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const long = 'z'.repeat(8000);
		const out = feed(parser, [
			{
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'thinking', thinking: long }] },
			},
		]);
		const body = out.replace('[thinking] ', '').trimEnd();
		expect(body).toBe(long);
		expect(body).not.toContain('…');
	});

	it('keeps a long tool result in full without an ellipsis', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		const long = 'result-'.repeat(1000);
		const out = feed(parser, [{ type: 'tool_result', output: long, is_error: false }]);
		const body = out.replace('[tool-result] ', '').trimEnd();
		expect(body).toBe(long);
		expect(body).not.toContain('…');
	});
});

describe('thinking preserves the model line breaks (multi-line [thinking] block)', () => {
	const think = (thinking: string) =>
		feed(createAgentStreamParser(AgentRuntime.ClaudeCode), [
			{
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'thinking', thinking }] },
			},
		]);

	it('emits one [thinking] line per physical line, a blank line kept as a bare [thinking]', () => {
		const out = think(
			'First, understand the picture.\n\nThen:\n1. read the thread\n2. check state',
		);
		expect(out).toBe(
			[
				'[thinking] First, understand the picture.',
				'[thinking]',
				'[thinking] Then:',
				'[thinking] 1. read the thread',
				'[thinking] 2. check state',
				'',
			].join('\n'),
		);
	});

	it('collapses only horizontal whitespace and caps a blank run at one blank line', () => {
		expect(think('  spaced   out  \n\n\n\nnext   thought  ')).toBe(
			'[thinking] spaced out\n[thinking]\n[thinking] next thought\n',
		);
	});

	it('leaves single-line thinking as exactly one [thinking] line', () => {
		const out = think('just one line');
		expect(out).toBe('[thinking] just one line\n');
		expect(out.match(/\[thinking\]/g)).toHaveLength(1);
	});

	it('renders empty thinking as a bare [thinking] line', () => {
		expect(think('   \n  \n')).toBe('[thinking]\n');
	});
});

describe('extractToolResultText arms (Claude tool_result content shapes)', () => {
	it('renders a string-content tool_result directly', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'user',
				message: { role: 'user', content: [{ type: 'tool_result', content: 'plain body' }] },
			},
		]);
		expect(out).toBe('[tool-result] plain body\n');
	});

	it('renders a bare label when array content has no text parts', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'user',
				message: {
					role: 'user',
					content: [{ type: 'tool_result', content: [{ image: 'x' }, 123] }],
				},
			},
		]);
		expect(out).toBe('[tool-result]\n');
	});

	it('renders a bare label when content is a non-string, non-array value', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{
				type: 'user',
				message: { role: 'user', content: [{ type: 'tool_result', content: { obj: 1 } }] },
			},
		]);
		expect(out).toBe('[tool-result]\n');
	});

	it('renders a tool_result with no content field as the bare label', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		const out = feed(parser, [
			{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
		]);
		expect(out).toBe('[tool-result]\n');
	});
});

// ---------------------------------------------------------------------------
// JSONL framing — buffering / flush / malformed
// ---------------------------------------------------------------------------

describe('JSONL framing arms', () => {
	it('drops a blank line (trimmed empty) without emitting anything', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.onStdout('\n   \n')).toBe('');
	});

	it('passes a malformed-JSON line through verbatim with a newline', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.onStdout('{not valid json\n')).toBe('{not valid json\n');
	});

	it('flush() returns empty when the buffer is empty', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		parser.onStdout('{"type":"system","subtype":"init","model":"m","tools":[]}\n');
		expect(parser.flush()).toBe('');
	});

	it('flush() renders a buffered final event that had no trailing newline', () => {
		const parser = createAgentStreamParser(AgentRuntime.Gemini);
		parser.onStdout('{"type":"init","model":"g"}');
		expect(parser.flush()).toBe('[session] model=g tools=0\n');
	});

	it('onStderr passes bytes through unchanged for a real runtime parser', () => {
		const parser = createAgentStreamParser(AgentRuntime.ClaudeCode);
		expect(parser.onStderr('warning: something\n')).toBe('warning: something\n');
	});
});

// ---------------------------------------------------------------------------
// Chat parser — remaining arms
// ---------------------------------------------------------------------------

describe('chat parser — remaining arms', () => {
	it('Claude chat ignores an assistant event with no message', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		expect(parser.onStdout(line({ type: 'assistant' }))).toEqual([]);
	});

	it('Claude chat handles a result with an explicit empty usage object', () => {
		const parser = createAgentChatParser(AgentRuntime.ClaudeCode);
		parser.onStdout(line({ type: 'result', usage: {} }));
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('Codex chat reads an item via the message field when text is absent', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		expect(
			parser.onStdout(
				line({ type: 'item.completed', item: { type: 'agent_message', message: 'msg' } }),
			),
		).toEqual([{ text: 'msg' }]);
	});

	it('Codex chat defaults missing turn.completed usage to zero', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		parser.onStdout(line({ type: 'turn.completed' }));
		expect(parser.getUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
	});

	it('Codex chat drops an item.completed with an unknown kind', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		expect(
			parser.onStdout(line({ type: 'item.completed', item: { type: 'file_change' } })),
		).toEqual([]);
	});

	it('Codex chat ignores item.completed with no item', () => {
		const parser = createAgentChatParser(AgentRuntime.Codex);
		expect(parser.onStdout(line({ type: 'item.completed' }))).toEqual([]);
	});

	it('Gemini chat skips a user message and drops empty assistant text', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		expect(parser.onStdout(line({ type: 'message', role: 'user', content: 'hi' }))).toEqual([]);
		expect(parser.onStdout(line({ type: 'message', content: '   ' }))).toEqual([]);
	});

	it('Gemini chat falls back to tool label when tool_use has no name', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		expect(parser.onStdout(line({ type: 'tool_use' }))).toEqual([{ toolActivity: 'tool' }]);
	});

	it('Gemini chat ignores an unknown event type', () => {
		const parser = createAgentChatParser(AgentRuntime.Gemini);
		expect(parser.onStdout(line({ type: 'whatever' }))).toEqual([]);
	});

	it('generic chat records model and captures usage but yields no text', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		const out = parser.onStdout(
			line({ type: 'usage', model: 'k', usage: { input_tokens: 4, output_tokens: 1 } }),
		);
		expect(out).toEqual([]);
		expect(parser.getUsage()).toEqual({ inputTokens: 4, outputTokens: 1, costCents: 0 });
	});

	it('generic chat maps a tool event to a tool-activity hint', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		expect(parser.onStdout(line({ type: 'tool_call', name: 'fetch' }))).toEqual([
			{ toolActivity: 'fetch' },
		]);
	});

	it('generic chat drops a non-record line', () => {
		const parser = createAgentChatParser(AgentRuntime.OpenCode);
		expect(parser.onStdout('true\n')).toEqual([]);
	});
});
