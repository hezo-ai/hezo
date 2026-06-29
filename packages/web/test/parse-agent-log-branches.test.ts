// Supplements parse-agent-log.test.ts: covers the fallback branches of the
// per-line parsers (missing model/tools/turns/duration/tokens/cost fields and
// a prefix not followed by a space) that the happy-path suite doesn't exercise.
import {
	type AgentLogLine,
	type DoneBlock,
	parseAgentLog,
	type SessionBlock,
	type ThinkingBlock,
	type ToolBlock,
} from '@hezo/web/lib/parse-agent-log';
import { expect, test } from 'vitest';

let counter = 0;
function line(text: string, stream: 'stdout' | 'stderr' = 'stdout'): AgentLogLine {
	return { id: counter++, stream, text };
}

test('session header with no model= falls back to "unknown" and null toolCount', () => {
	const [block] = parseAgentLog([line('[session] starting up')]);
	expect(block).toMatchObject<Partial<SessionBlock>>({
		type: 'session',
		model: 'unknown',
		toolCount: null,
	});
});

test('session header with model but no tools= leaves toolCount null', () => {
	const [block] = parseAgentLog([line('[session] model=claude-opus-4-8')]);
	expect(block).toMatchObject<Partial<SessionBlock>>({
		type: 'session',
		model: 'claude-opus-4-8',
		toolCount: null,
	});
});

test('done line with only a status leaves every numeric field null', () => {
	const [block] = parseAgentLog([line('[done] failed')]);
	expect(block).toMatchObject<Partial<DoneBlock>>({
		type: 'done',
		status: 'failed',
		turns: null,
		durationMs: null,
		inputTokens: null,
		outputTokens: null,
		costUsd: null,
	});
});

test('bare "[done]" with no status token falls back to status "done"', () => {
	const [block] = parseAgentLog([line('[done]')]);
	expect(block).toMatchObject<Partial<DoneBlock>>({ type: 'done', status: 'done' });
});

test('thinking prefix immediately followed by content (no space) keeps the content verbatim', () => {
	// stripPrefix's `startsWith(' ')` false branch: the char after the prefix is not a space.
	const [block] = parseAgentLog([line('[thinking]:weighing options')]);
	expect(block).toMatchObject<Partial<ThinkingBlock>>({
		type: 'thinking',
		text: ':weighing options',
	});
});

test('a [tool] line with no parenthesised args yields an empty argsPreview', () => {
	const [block] = parseAgentLog([line('[tool] TodoWrite')]);
	expect(block).toMatchObject<Partial<ToolBlock>>({
		type: 'tool',
		name: 'TodoWrite',
		argsPreview: '',
		status: 'pending',
	});
});

test('a [tool] args string missing the closing paren is not truncated', () => {
	const [block] = parseAgentLog([line('[tool] Bash(command=ls -la')]);
	expect(block).toMatchObject<Partial<ToolBlock>>({
		type: 'tool',
		name: 'Bash',
		argsPreview: 'command=ls -la',
	});
});
