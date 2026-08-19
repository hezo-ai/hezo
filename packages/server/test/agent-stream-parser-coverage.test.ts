import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	classifyRuntimeError,
	createAgentStreamParser,
	type PriceModelFn,
} from '../src/services/agent-stream-parser';

// Feed one or more JSON events as a single newline-delimited stdout chunk.
function feed(parser: ReturnType<typeof createAgentStreamParser>, events: unknown[]): string {
	return parser.onStdout(`${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
}

describe('classifyRuntimeError', () => {
	it('returns null for empty/whitespace/nullish input', () => {
		expect(classifyRuntimeError(null)).toBeNull();
		expect(classifyRuntimeError(undefined)).toBeNull();
		expect(classifyRuntimeError('   ')).toBeNull();
	});

	it('classifies billing/quota failures with a top-up hint', () => {
		for (const raw of [
			'HTTP 402 Payment Required',
			'insufficient balance',
			'insufficient quota',
			'You exceeded your current quota',
			'billing hard limit reached',
		]) {
			const msg = classifyRuntimeError(raw);
			expect(msg).toContain('lack of credit/quota');
			expect(msg).toContain(raw);
		}
	});

	it('classifies auth failures with a credential hint', () => {
		for (const raw of [
			'HTTP 401 Unauthorized',
			'authentication failed',
			'invalid api key',
			'invalid x-api-key header',
			'not logged in',
		]) {
			const msg = classifyRuntimeError(raw);
			expect(msg).toContain('authentication failed');
			expect(msg).toContain(raw);
		}
	});

	it('passes through an unrecognized error verbatim (trimmed)', () => {
		expect(classifyRuntimeError('  some other failure  ')).toBe('some other failure');
	});
});

describe('passthrough parser (unknown runtime)', () => {
	it('echoes stdout/stderr verbatim and reports no usage', () => {
		const parser = createAgentStreamParser('totally-unknown' as AgentRuntime);
		expect(parser.onStdout('raw bytes')).toBe('raw bytes');
		expect(parser.onStderr('err bytes')).toBe('err bytes');
		expect(parser.flush()).toBe('');
		expect(parser.getUsage()).toBeNull();
		expect(parser.getTerminalError()).toBeNull();
	});
});

describe('codex renderCodexItem branches', () => {
	const item = (extra: Record<string, unknown>) => ({
		type: 'item.completed',
		item: extra,
	});

	it('renders reasoning as a thinking line and drops empty reasoning', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			item({ type: 'reasoning', text: 'pondering the plan' }),
			item({ type: 'reasoning', text: '   ' }),
		]);
		expect(out).toContain('[thinking] pondering the plan');
		expect(out.match(/\[thinking\]/g)?.length).toBe(1);
	});

	it('reads an assistant message from the message field when text is absent', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [item({ type: 'assistant_message', message: 'hello from codex' })]);
		expect(out).toContain('hello from codex');
	});

	it('marks a nonzero exit code as a tool-error', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			item({
				type: 'command_execution',
				command: 'ls /missing',
				aggregated_output: 'no such file',
				exit_code: 1,
			}),
		]);
		expect(out).toContain('[tool] shell(ls /missing)');
		expect(out).toContain('[tool-error] no such file');
	});

	it('renders command output with a zero exit code as a tool-result', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			item({ type: 'command_execution', command: 'echo hi', output: 'hi', exit_code: 0 }),
		]);
		expect(out).toContain('[tool-result] hi');
	});

	it('renders an mcp tool call via item_type fallback', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		const out = feed(parser, [
			item({ item_type: 'mcp_tool_call', name: 'search', arguments: { q: 'x' } }),
		]);
		expect(out).toContain('[tool] search(');
		expect(out).toContain('q=x');
	});

	it('drops an unknown codex item kind', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(feed(parser, [item({ type: 'mystery_kind' })])).toBe('');
	});
});

describe('antigravity renderEvent branches', () => {
	const init = (model: string) => `${JSON.stringify({ event: 'init', init: { model } })}\n`;
	const result = (r: Record<string, unknown>) =>
		`${JSON.stringify({ event: 'result', result: r })}\n`;

	it('renders init, ignores step_update, and reports a success result', () => {
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		expect(parser.onStdout(init('gemini-2.0'))).toContain('[session] model=gemini-2.0');
		expect(
			parser.onStdout(
				`${JSON.stringify({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response' } })}\n`,
			),
		).toBe('');
		expect(parser.onStdout(result({ status: 'SUCCESS', usage: {} }))).toContain('[done] success');
	});

	it('reports an error status on the terminal result when the status is ERROR', () => {
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		expect(parser.onStdout(result({ status: 'ERROR', usage: {} }))).toContain(
			'[done] error tokens=0/0',
		);
	});

	// Every runtime whose stream can name a failure must be able to put that
	// reason on the run row; until these reported one, a non-zero exit here was
	// recorded with no cause at all.
	it('reports an antigravity auth error as the run terminal error', () => {
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		expect(parser.getTerminalError()).toBeNull();
		parser.onStdout(result({ status: 'ERROR', error: 'invalid api key', usage: {} }));
		expect(parser.getTerminalError()).toContain('AI provider authentication failed');
	});

	it('reports an antigravity quota error as the run terminal error', () => {
		const parser = createAgentStreamParser(AgentRuntime.Antigravity);
		parser.onStdout(
			result({ status: 'ERROR', error: 'quota exceeded, payment required', usage: {} }),
		);
		expect(parser.getTerminalError()).toContain('lack of credit/quota');
	});

	it('reports a Codex stream error as the run terminal error', () => {
		const parser = createAgentStreamParser(AgentRuntime.Codex);
		expect(parser.getTerminalError()).toBeNull();
		feed(parser, [{ type: 'error', error: { message: 'unauthorized' } }]);
		expect(parser.getTerminalError()).toContain('AI provider authentication failed');
	});

	it('prices the run model with disjoint input/cache-read/output buckets', () => {
		const seen: Array<{
			model: string | undefined;
			input: number;
			cacheRead: number;
			output: number;
		}> = [];
		const price: PriceModelFn = (model, t) => {
			seen.push({
				model,
				input: t.inputTokens ?? 0,
				cacheRead: t.cacheReadTokens ?? 0,
				output: t.outputTokens ?? 0,
			});
			return 5;
		};
		const parser = createAgentStreamParser(AgentRuntime.Antigravity, price);
		parser.onStdout(init('gemini-pro'));
		parser.onStdout(
			result({
				status: 'SUCCESS',
				usage: { input_tokens: 60, cache_read_tokens: 40, output_tokens: 25 },
			}),
		);
		const usage = parser.getUsage();
		expect(usage?.inputTokens).toBe(60);
		expect(usage?.outputTokens).toBe(25);
		// input_tokens is already the non-cached input, priced as-is; cache_read separate.
		expect(seen).toEqual([{ model: 'gemini-pro', input: 60, cacheRead: 40, output: 25 }]);
	});
});

describe('generic parser (opencode) branches', () => {
	it('renders thinking, errors, nested text, and a terminal done line', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ type: 'reasoning', text: 'hmm' }])).toContain('[thinking] hmm');
		expect(feed(parser, [{ type: 'error', error: 'kaboom' }])).toContain('[tool-error] kaboom');
		expect(feed(parser, [{ type: 'message', delta: { content: 'streamed text' } }])).toContain(
			'streamed text',
		);
		const done = feed(parser, [{ type: 'result', usage: { input_tokens: 10, output_tokens: 4 } }]);
		expect(done).toContain('[done] success tokens=10/4');
	});

	it('skips user/tool role events and non-record lines', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode);
		expect(feed(parser, [{ role: 'user', text: 'hi' }])).toBe('');
		// A bare JSON value parses OK but isn't a record → renderEvent drops it.
		expect(parser.onStdout('42\n')).toBe('');
	});

	it('captures usage with reasoning tokens and a cached subset', () => {
		const seen: Array<{ input: number; cacheRead: number; output: number }> = [];
		const price: PriceModelFn = (_m, t) => {
			seen.push({
				input: t.inputTokens ?? 0,
				cacheRead: t.cacheReadTokens ?? 0,
				output: t.outputTokens ?? 0,
			});
			return 7;
		};
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, price);
		feed(parser, [
			{
				type: 'usage',
				model: 'kimi-x',
				usage: {
					prompt_tokens: 50,
					cached: 10,
					completion_tokens: 8,
					reasoning_output_tokens: 2,
				},
			},
		]);
		const usage = parser.getUsage();
		expect(usage?.inputTokens).toBe(50);
		expect(usage?.outputTokens).toBe(10); // completion 8 + reasoning 2
		expect(seen.at(-1)).toEqual({ input: 40, cacheRead: 10, output: 10 });
	});

	it('ignores a provider-reported usd cost in favor of computed pricing', () => {
		const parser = createAgentStreamParser(AgentRuntime.OpenCode, () => 999);
		feed(parser, [
			{ type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 1, output_tokens: 1 } },
		]);
		expect(parser.getUsage()?.costCents).toBe(999);
	});
});
