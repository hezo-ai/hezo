/**
 * Converts per-runtime machine-readable stdout event streams into friendly,
 * human-readable log lines suitable for the run log viewer.
 *
 * Today only Claude Code's `--output-format stream-json --verbose` is
 * structured; other runtimes stream plain text and pass through unchanged.
 *
 * The parser is stateful per run: `onChunk` buffers partial stdout bytes,
 * splits on newlines, attempts `JSON.parse`, and emits rendered lines.
 * Anything that fails to parse falls through verbatim.
 *
 * The parser also observes the terminal `result` event and exposes the
 * captured token usage and cost via `getUsage()` so the runner can persist
 * it on the heartbeat_run row.
 */
import { AgentRuntime } from '@hezo/shared';

export interface AgentRunUsage {
	inputTokens: number;
	outputTokens: number;
	costCents: number;
}

export interface AgentStreamParser {
	onStdout(chunk: string): string;
	onStderr(chunk: string): string;
	flush(): string;
	getUsage(): AgentRunUsage | null;
}

export function createAgentStreamParser(runtime: AgentRuntime): AgentStreamParser {
	switch (runtime) {
		case AgentRuntime.ClaudeCode:
			return createClaudeCodeParser();
		default:
			return createPassthroughParser();
	}
}

function createPassthroughParser(): AgentStreamParser {
	return {
		onStdout: (chunk) => chunk,
		onStderr: (chunk) => chunk,
		flush: () => '',
		getUsage: () => null,
	};
}

interface ClaudeContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	name?: string;
	input?: unknown;
	content?: unknown;
	tool_use_id?: string;
	is_error?: boolean;
}

interface ClaudeMessage {
	role?: string;
	content?: ClaudeContentBlock[] | string;
}

interface ClaudeUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

interface ClaudeStreamEvent {
	type?: string;
	subtype?: string;
	message?: ClaudeMessage;
	tools?: unknown[];
	model?: string;
	session_id?: string;
	duration_ms?: number;
	num_turns?: number;
	result?: string;
	is_error?: boolean;
	total_cost_usd?: number;
	usage?: ClaudeUsage;
}

const MAX_LINE_LEN = 500;

function createClaudeCodeParser(): AgentStreamParser {
	let buffer = '';
	let usage: AgentRunUsage | null = null;

	const renderEvent = (event: ClaudeStreamEvent): string[] => {
		const out: string[] = [];

		if (event.type === 'system' && event.subtype === 'init') {
			const toolCount = Array.isArray(event.tools) ? event.tools.length : 0;
			const model = event.model ?? 'unknown';
			out.push(`[session] model=${model} tools=${toolCount}`);
			return out;
		}

		if (event.type === 'assistant' && event.message) {
			const blocks = normalizeContent(event.message.content);
			for (const block of blocks) {
				if (block.type === 'thinking') {
					out.push(formatThinking(block.thinking ?? ''));
				} else if (block.type === 'tool_use') {
					out.push(formatToolUse(block.name ?? 'unknown', block.input));
				} else if (block.type === 'text') {
					const text = (block.text ?? '').trim();
					if (text) out.push(text);
				}
			}
			return out;
		}

		if (event.type === 'user' && event.message) {
			const blocks = normalizeContent(event.message.content);
			for (const block of blocks) {
				if (block.type === 'tool_result') {
					out.push(formatToolResult(block));
				}
			}
			return out;
		}

		if (event.type === 'result') {
			const u = event.usage ?? {};
			const input =
				(u.input_tokens ?? 0) +
				(u.cache_creation_input_tokens ?? 0) +
				(u.cache_read_input_tokens ?? 0);
			const output = u.output_tokens ?? 0;
			const costUsd = event.total_cost_usd ?? 0;
			usage = {
				inputTokens: input,
				outputTokens: output,
				costCents: Math.round(costUsd * 100),
			};
			const duration = event.duration_ms ?? 0;
			const turns = event.num_turns ?? 0;
			const status = event.is_error ? 'error' : (event.subtype ?? 'success');
			out.push(
				`[done] ${status} turns=${turns} duration=${duration}ms tokens=${input}/${output} cost=$${costUsd.toFixed(4)}`,
			);
			return out;
		}

		return out;
	};

	const consumeLine = (line: string): string => {
		const trimmed = line.trimEnd();
		if (trimmed === '') return '';
		let event: ClaudeStreamEvent;
		try {
			event = JSON.parse(trimmed) as ClaudeStreamEvent;
		} catch {
			return `${trimmed}\n`;
		}
		const rendered = renderEvent(event);
		if (rendered.length === 0) return '';
		return `${rendered.join('\n')}\n`;
	};

	return {
		onStdout(chunk: string): string {
			buffer += chunk;
			const parts = buffer.split('\n');
			buffer = parts.pop() ?? '';
			let out = '';
			for (const line of parts) out += consumeLine(line);
			return out;
		},
		onStderr: (chunk) => chunk,
		flush(): string {
			if (buffer === '') return '';
			const remainder = buffer;
			buffer = '';
			return consumeLine(remainder);
		},
		getUsage: () => usage,
	};
}

function normalizeContent(content: ClaudeMessage['content']): ClaudeContentBlock[] {
	if (typeof content === 'string') return [{ type: 'text', text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

function formatThinking(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length === 0) return '[thinking]';
	return `[thinking] ${truncate(collapsed, MAX_LINE_LEN)}`;
}

function formatToolUse(name: string, input: unknown): string {
	const rendered = renderToolInput(input);
	return rendered ? `[tool] ${name}(${rendered})` : `[tool] ${name}()`;
}

function renderToolInput(input: unknown): string {
	if (input === null || input === undefined) return '';
	if (typeof input !== 'object') return String(input);
	const entries = Object.entries(input as Record<string, unknown>);
	if (entries.length === 0) return '';
	const preview = entries.map(([k, v]) => `${k}=${truncate(stringifyArg(v), 80)}`).join(', ');
	return truncate(preview, MAX_LINE_LEN);
}

function stringifyArg(value: unknown): string {
	if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function formatToolResult(block: ClaudeContentBlock): string {
	const label = block.is_error ? '[tool-error]' : '[tool-result]';
	const body = extractToolResultText(block.content);
	const collapsed = body.replace(/\s+/g, ' ').trim();
	if (collapsed === '') return label;
	return `${label} ${truncate(collapsed, MAX_LINE_LEN)}`;
}

function extractToolResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === 'string') return part;
				if (part && typeof part === 'object') {
					const p = part as Record<string, unknown>;
					if (typeof p.text === 'string') return p.text;
				}
				return '';
			})
			.filter(Boolean)
			.join(' ');
	}
	return '';
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
