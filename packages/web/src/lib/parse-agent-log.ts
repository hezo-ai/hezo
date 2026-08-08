/**
 * Client-side parser that turns the flattened, prefixed agent-run log lines
 * (produced server-side by `agent-stream-parser.ts`) into structured blocks the
 * Formatted log view can render.
 *
 * The server discards the original stream-json and persists prefixed, per-line
 * text (`[session]`, `[thinking]`, `[tool] Name(args)`, `[tool-result]`,
 * `[tool-error]`, `[done]`, plus bare prose and `$ command` lines). A single
 * thinking block spans several consecutive `[thinking]` lines — the server keeps
 * the model's own line breaks for readability — which we coalesce back into one
 * block (as we do for `[system]`). There is no correlation id between a tool call
 * and its result — Claude emits N parallel `[tool]` lines and then N
 * `[tool-result]`/`[tool-error]` lines in the same order, so we pair them FIFO via
 * a queue of pending tool blocks.
 */

import { parseContainerMetaLogLine } from '@hezo/shared';

/** Minimal shape of a log line; structurally compatible with `LogViewerLine`. */
export interface AgentLogLine {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

export type ToolStatus = 'pending' | 'success' | 'error';

export interface SessionBlock {
	type: 'session';
	id: number;
	model: string;
	toolCount: number | null;
}

export interface TextBlock {
	type: 'text';
	id: number;
	text: string;
	stream: 'stdout' | 'stderr';
}

export interface ThinkingBlock {
	type: 'thinking';
	id: number;
	text: string;
}

export interface CommandBlock {
	type: 'command';
	id: number;
	text: string;
}

export interface ToolBlock {
	type: 'tool';
	id: number;
	name: string;
	argsPreview: string;
	result: string | null;
	status: ToolStatus;
}

/** A `[tool-result]`/`[tool-error]` that arrived with no pending tool to pair with. */
export interface ResultBlock {
	type: 'result';
	id: number;
	text: string;
	isError: boolean;
}

export interface DoneBlock {
	type: 'done';
	id: number;
	status: string;
	turns: number | null;
	durationMs: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	costUsd: number | null;
}

/** Operational/lifecycle status lines from the run host (repo sync, worktree setup, …). */
export interface SystemBlock {
	type: 'system';
	id: number;
	lines: string[];
	stream: 'stdout' | 'stderr';
}

/** One `[runner]` line, with the container it names resolved when it names one. */
export interface RunnerLine {
	id: number;
	/** The line as written, rendered verbatim unless `container` is set. */
	text: string;
	/**
	 * Set only on the line naming the run's container. The id is the full engine
	 * id - what the container's page is keyed on - and the viewer shortens it.
	 */
	container: { id: string; details: string } | null;
}

/**
 * Lifecycle lines from the run host itself (claiming a container, requeuing,
 * failing to start).
 *
 * A block of its own rather than the prose fall-through, which is where these
 * used to land: the fall-through coalesces consecutive lines into one markdown
 * document, and a single newline is a softbreak there, so a runner line was
 * rendered as a clause appended to whatever the agent had last said.
 */
export interface RunnerBlock {
	type: 'runner';
	id: number;
	lines: RunnerLine[];
	stream: 'stdout' | 'stderr';
}

export type LogBlock =
	| SessionBlock
	| TextBlock
	| ThinkingBlock
	| CommandBlock
	| ToolBlock
	| ResultBlock
	| DoneBlock
	| SystemBlock
	| RunnerBlock;

/** Strip a `[prefix]` token and the single following space, if present. */
function stripPrefix(text: string, prefix: string): string {
	const rest = text.slice(prefix.length);
	return rest.startsWith(' ') ? rest.slice(1) : rest;
}

function parseSession(id: number, text: string): SessionBlock {
	const model = /\bmodel=(\S+)/.exec(text)?.[1] ?? 'unknown';
	const toolMatch = /\btools=(\d+)/.exec(text)?.[1];
	return { type: 'session', id, model, toolCount: toolMatch ? Number(toolMatch) : null };
}

function parseTool(id: number, text: string): ToolBlock {
	const body = stripPrefix(text, '[tool]');
	const open = body.indexOf('(');
	let name = body;
	let argsPreview = '';
	if (open !== -1) {
		name = body.slice(0, open);
		argsPreview = body.slice(open + 1);
		if (argsPreview.endsWith(')')) argsPreview = argsPreview.slice(0, -1);
	}
	return {
		type: 'tool',
		id,
		name: name.trim(),
		argsPreview: argsPreview.trim(),
		result: null,
		status: 'pending',
	};
}

function parseDone(id: number, text: string): DoneBlock {
	const status = /^\[done\]\s+(\S+)/.exec(text)?.[1] ?? 'done';
	const turns = /\bturns=(\d+)/.exec(text)?.[1];
	const duration = /\bduration=(\d+)ms/.exec(text)?.[1];
	const tokens = /\btokens=(\d+)\/(\d+)/.exec(text);
	const cost = /\bcost=\$([\d.]+)/.exec(text)?.[1];
	return {
		type: 'done',
		id,
		status,
		turns: turns ? Number(turns) : null,
		durationMs: duration ? Number(duration) : null,
		inputTokens: tokens ? Number(tokens[1]) : null,
		outputTokens: tokens ? Number(tokens[2]) : null,
		costUsd: cost ? Number(cost) : null,
	};
}

export function parseAgentLog(lines: AgentLogLine[]): LogBlock[] {
	const blocks: LogBlock[] = [];
	const pendingTools: ToolBlock[] = [];
	let textBuf: { id: number; parts: string[]; stream: 'stdout' | 'stderr' } | null = null;

	const flushText = () => {
		if (!textBuf) return;
		blocks.push({
			type: 'text',
			id: textBuf.id,
			text: textBuf.parts.join('\n'),
			stream: textBuf.stream,
		});
		textBuf = null;
	};

	for (const line of lines) {
		const text = line.text;

		if (text.startsWith('[session]')) {
			flushText();
			blocks.push(parseSession(line.id, text));
			continue;
		}
		if (text.startsWith('[thinking]')) {
			flushText();
			const body = stripPrefix(text, '[thinking]');
			// The server emits one `[thinking]` line per physical line of the model's
			// reasoning (blank lines included) to preserve its paragraph/list structure;
			// coalesce a consecutive run back into a single block, joined on newlines.
			const tail = blocks[blocks.length - 1];
			if (tail && tail.type === 'thinking') {
				tail.text += `\n${body}`;
			} else {
				blocks.push({ type: 'thinking', id: line.id, text: body });
			}
			continue;
		}
		if (text.startsWith('[tool] ')) {
			flushText();
			const tool = parseTool(line.id, text);
			blocks.push(tool);
			pendingTools.push(tool);
			continue;
		}
		if (text.startsWith('[tool-result]') || text.startsWith('[tool-error]')) {
			flushText();
			const isError = text.startsWith('[tool-error]');
			const body = stripPrefix(text, isError ? '[tool-error]' : '[tool-result]');
			const target = pendingTools.shift();
			if (target) {
				target.result = body;
				target.status = isError ? 'error' : 'success';
			} else {
				blocks.push({ type: 'result', id: line.id, text: body, isError });
			}
			continue;
		}
		if (text.startsWith('[done]')) {
			flushText();
			blocks.push(parseDone(line.id, text));
			continue;
		}
		if (text.startsWith('[system]')) {
			flushText();
			const body = stripPrefix(text, '[system]');
			const tail = blocks[blocks.length - 1];
			if (tail && tail.type === 'system' && tail.stream === line.stream) {
				tail.lines.push(body);
			} else {
				blocks.push({ type: 'system', id: line.id, lines: [body], stream: line.stream });
			}
			continue;
		}
		if (text.startsWith('[runner]')) {
			flushText();
			const body = stripPrefix(text, '[runner]');
			const meta = parseContainerMetaLogLine(body);
			const entry: RunnerLine = {
				id: line.id,
				text: body,
				container: meta ? { id: meta.containerId, details: meta.details } : null,
			};
			const tail = blocks[blocks.length - 1];
			if (tail && tail.type === 'runner' && tail.stream === line.stream) {
				tail.lines.push(entry);
			} else {
				blocks.push({ type: 'runner', id: line.id, lines: [entry], stream: line.stream });
			}
			continue;
		}
		if (text.startsWith('$ ')) {
			flushText();
			blocks.push({ type: 'command', id: line.id, text: text.slice(2) });
			continue;
		}

		// Bare prose / preamble — coalesce consecutive same-stream lines into one
		// block so multi-line markdown (lists, etc.) renders as a single document.
		if (textBuf && textBuf.stream !== line.stream) flushText();
		if (!textBuf) textBuf = { id: line.id, parts: [], stream: line.stream };
		textBuf.parts.push(text);
	}

	flushText();
	return blocks;
}
