import {
	type AgentLogLine,
	type DoneBlock,
	parseAgentLog,
	type ResultBlock,
	type SystemBlock,
	type TextBlock,
	type ToolBlock,
} from '@hezo/web/lib/parse-agent-log';
import { expect, test } from 'vitest';

let counter = 0;
function makeLines(
	items: ReadonlyArray<string | readonly [string, 'stdout' | 'stderr']>,
): AgentLogLine[] {
	return items.map((it) =>
		typeof it === 'string'
			? { id: counter++, stream: 'stdout', text: it }
			: { id: counter++, stream: it[1], text: it[0] },
	);
}

test('parses the session header', () => {
	const blocks = parseAgentLog(makeLines(['[session] model=deepseek-v4-pro tools=115']));
	expect(blocks).toEqual([
		{ type: 'session', id: expect.any(Number), model: 'deepseek-v4-pro', toolCount: 115 },
	]);
});

test('pairs parallel tool calls with their results FIFO', () => {
	const blocks = parseAgentLog(
		makeLines([
			'[tool] Bash(command=ls -la, description=list)',
			'[tool] mcp__hezo__list_comments(team_id=abc)',
			'[tool] mcp__hezo__get_task(task_id=def)',
			'[tool-result] total 8',
			'[tool-result] [ { "id": "c1" } ]',
			'[tool-result] { "id": "t1" }',
		]),
	);
	const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool');
	expect(tools).toHaveLength(3);
	expect(tools[0]).toMatchObject({
		name: 'Bash',
		argsPreview: 'command=ls -la, description=list',
		status: 'success',
		result: 'total 8',
	});
	expect(tools[1]).toMatchObject({
		name: 'mcp__hezo__list_comments',
		result: '[ { "id": "c1" } ]',
	});
	expect(tools[2]).toMatchObject({ name: 'mcp__hezo__get_task', result: '{ "id": "t1" }' });
	// Every result paired — no orphan result blocks.
	expect(blocks.some((b) => b.type === 'result')).toBe(false);
});

test('marks a tool-error result with error status and pairs in order', () => {
	const blocks = parseAgentLog(
		makeLines([
			'[tool] Bash(command=git log)',
			'[tool] mcp__hezo__list_assets(team_id=abc)',
			'[tool-error] Exit code 128 fatal: not a git repository',
			'[tool-result] { "files": [] }',
		]),
	);
	const tools = blocks.filter((b): b is ToolBlock => b.type === 'tool');
	expect(tools[0]).toMatchObject({
		name: 'Bash',
		status: 'error',
		result: expect.stringContaining('Exit code 128'),
	});
	expect(tools[1]).toMatchObject({ status: 'success', result: '{ "files": [] }' });
});

test('coalesces consecutive prose lines and preserves a markdown list', () => {
	const blocks = parseAgentLog(
		makeLines(['Here is the plan to follow:', '- first item', '- second item']),
	);
	const texts = blocks.filter((b): b is TextBlock => b.type === 'text');
	expect(texts).toHaveLength(1);
	expect(texts[0].text).toBe('Here is the plan to follow:\n- first item\n- second item');
});

test('splits prose into separate blocks across an interrupting event', () => {
	const blocks = parseAgentLog(
		makeLines([
			'Let me check the mockup.',
			'[thinking] considering options',
			'Now starting phase 1.',
		]),
	);
	expect(blocks.map((b) => b.type)).toEqual(['text', 'thinking', 'text']);
});

test('keeps stdout and stderr prose in separate blocks', () => {
	const blocks = parseAgentLog(
		makeLines([
			['building...', 'stdout'],
			['warning: deprecated', 'stderr'],
		]),
	);
	const texts = blocks.filter((b): b is TextBlock => b.type === 'text');
	expect(texts).toHaveLength(2);
	expect(texts[1]).toMatchObject({ stream: 'stderr', text: 'warning: deprecated' });
});

test('treats a $ line as a command block', () => {
	const blocks = parseAgentLog(makeLines(['$ claude --settings /x -p < /y.txt']));
	expect(blocks[0]).toMatchObject({ type: 'command', text: 'claude --settings /x -p < /y.txt' });
});

test('parses the done summary', () => {
	const blocks = parseAgentLog(
		makeLines(['[done] success turns=12 duration=34000ms tokens=1000/2000 cost=$0.1234']),
	);
	expect(blocks[0]).toMatchObject<Partial<DoneBlock>>({
		type: 'done',
		status: 'success',
		turns: 12,
		durationMs: 34000,
		inputTokens: 1000,
		outputTokens: 2000,
		costUsd: 0.1234,
	});
});

test('emits a standalone result block when no tool is pending', () => {
	const blocks = parseAgentLog(makeLines(['[tool-result] orphaned output']));
	expect(blocks[0]).toMatchObject<Partial<ResultBlock>>({
		type: 'result',
		isError: false,
		text: 'orphaned output',
	});
});

test('leaves a tool pending when its result has not arrived', () => {
	const blocks = parseAgentLog(makeLines(['[tool] Bash(command=sleep 1)']));
	const tool = blocks[0] as ToolBlock;
	expect(tool.status).toBe('pending');
	expect(tool.result).toBeNull();
});

test('coalesces consecutive system status lines into one block', () => {
	const blocks = parseAgentLog(
		makeLines([
			'[system] (syncing repos...)',
			'[system] git fetch todo3...',
			'[system] git fetch todo3 done',
			'[system] git worktree todo3...',
		]),
	);
	expect(blocks).toHaveLength(1);
	const sys = blocks[0] as SystemBlock;
	expect(sys.type).toBe('system');
	expect(sys.stream).toBe('stdout');
	expect(sys.lines).toEqual([
		'(syncing repos...)',
		'git fetch todo3...',
		'git fetch todo3 done',
		'git worktree todo3...',
	]);
});

test('separates system stdout from system stderr into different blocks', () => {
	const blocks = parseAgentLog(
		makeLines([
			['[system] git fetch foo...', 'stdout'],
			['[system] git fetch foo failed: timeout', 'stderr'],
			['[system] git worktree foo...', 'stdout'],
		]),
	);
	const sys = blocks.filter((b): b is SystemBlock => b.type === 'system');
	expect(sys).toHaveLength(3);
	expect(sys.map((b) => b.stream)).toEqual(['stdout', 'stderr', 'stdout']);
});

test('flushes pending prose before opening a system block', () => {
	const blocks = parseAgentLog(makeLines(['Setting up.', '[system] (syncing repos...)', 'Done.']));
	expect(blocks.map((b) => b.type)).toEqual(['text', 'system', 'text']);
});
