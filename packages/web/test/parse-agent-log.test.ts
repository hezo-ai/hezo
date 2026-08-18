import { formatContainerMetaLogLine } from '@hezo/shared';
import {
	type AgentLogLine,
	type DoneBlock,
	parseAgentLog,
	type ResultBlock,
	type RunnerBlock,
	type SystemBlock,
	type TextBlock,
	type ThinkingBlock,
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

test('renders a session header with no tool count', () => {
	// Codex and Gemini never report how many tools they were given, so their session
	// line omits `tools=` rather than claiming a measured zero.
	const blocks = parseAgentLog(makeLines(['[session] model=gpt-5-codex']));
	expect(blocks).toEqual([
		{ type: 'session', id: expect.any(Number), model: 'gpt-5-codex', toolCount: null },
	]);
});

test('gives each tool call in a mixed run its own result', () => {
	// Results are paired with calls FIFO, with no correlation id. A call whose result
	// line is missing does not just stay pending - it swallows the NEXT call's result
	// and every tool after it reports somebody else's outcome. This is the shape a
	// Codex run produces once each call carries its own result line.
	const blocks = parseAgentLog(
		makeLines([
			'[tool] mcp__hezo__get_task(task_id=INV-125)',
			'[tool-result] first',
			'[tool] shell(ls)',
			'[tool-result] file1',
			'[tool] mcp__hezo__read_project_doc(filename=missing.md)',
			'[tool-error] document not found',
		]),
	) as ToolBlock[];
	expect(blocks.map((b) => [b.name, b.status, b.result])).toEqual([
		['mcp__hezo__get_task', 'success', 'first'],
		['shell', 'success', 'file1'],
		['mcp__hezo__read_project_doc', 'error', 'document not found'],
	]);
});

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

test('coalesces consecutive [thinking] lines into one block, blank line → paragraph break', () => {
	const blocks = parseAgentLog(
		makeLines([
			'[thinking] First, understand the picture.',
			'[thinking]',
			'[thinking] Then read the thread.',
			'[thinking] 1. check status',
			'[thinking] 2. verify the draft',
		]),
	);
	const thinking = blocks.filter((b): b is ThinkingBlock => b.type === 'thinking');
	expect(thinking).toHaveLength(1);
	// A bare `[thinking]` line is a blank line the model wrote — it round-trips to a
	// `\n\n` paragraph break; non-blank lines join on a single `\n`.
	expect(thinking[0].text).toBe(
		'First, understand the picture.\n\nThen read the thread.\n1. check status\n2. verify the draft',
	);
});

test('a [thinking] run broken by another event stays two separate blocks', () => {
	const blocks = parseAgentLog(
		makeLines(['[thinking] weighing options', '[tool] Bash(command=ls)', '[thinking] decided']),
	);
	const thinking = blocks.filter((b): b is ThinkingBlock => b.type === 'thinking');
	expect(thinking).toHaveLength(2);
	expect(thinking.map((b) => b.text)).toEqual(['weighing options', 'decided']);
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

test('gives runner lines their own block rather than gluing them into the prose', () => {
	const blocks = parseAgentLog(
		makeLines([
			'I have finished the refactor.',
			'[runner] Starting the project container…',
			'[runner] no work to do',
		]),
	);
	expect(blocks.map((b) => b.type)).toEqual(['text', 'runner']);
	const runner = blocks[1] as RunnerBlock;
	expect(runner.lines.map((l) => l.text)).toEqual([
		'Starting the project container…',
		'no work to do',
	]);
	expect(runner.lines.every((l) => l.container === null)).toBe(true);
});

test('resolves the container the run was given, keeping the full engine id', () => {
	const containerId = '56ccc501e6dd28a4f3b1c09a77e5d4128b6f0a91ce23d7845fa6b0192e3c4d5f';
	const blocks = parseAgentLog(
		makeLines([
			`[runner] ${formatContainerMetaLogLine({
				containerId,
				memoryBytes: 4 * 1024 ** 3,
				diskCeilingBytes: 4 * 1024 ** 3,
			})}`,
		]),
	);
	const runner = blocks[0] as RunnerBlock;
	expect(runner.lines[0].container).toEqual({
		id: containerId,
		details: '4 GB RAM · 4 GB disk',
	});
});

test('separates runner stdout from runner stderr into different blocks', () => {
	const blocks = parseAgentLog(
		makeLines([
			['[runner] Starting the project container…', 'stdout'],
			['[runner] Could not start the project container: timeout', 'stderr'],
		]),
	);
	const runner = blocks.filter((b): b is RunnerBlock => b.type === 'runner');
	expect(runner.map((b) => b.stream)).toEqual(['stdout', 'stderr']);
});
