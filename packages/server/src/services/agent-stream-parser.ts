/**
 * Converts per-runtime machine-readable stdout event streams into friendly,
 * human-readable log lines suitable for the run log viewer.
 *
 * Every supported runtime is driven in a newline-delimited JSON (JSONL)
 * streaming mode (see `RUNTIME_STREAM_ARGS`): Claude Code's
 * `--output-format stream-json`, Codex's `exec --json`, and Gemini's
 * `--output-format stream-json`. Each parser is stateful per run: `onStdout`
 * buffers partial bytes, splits on newlines, attempts `JSON.parse`, and emits
 * rendered lines. Anything that fails to parse falls through verbatim; valid
 * events of an unknown type are dropped so raw JSON never reaches the log.
 *
 * Each parser also observes its runtime's terminal event (Claude/Gemini
 * `result`, Codex `turn.completed`) and exposes the captured token usage via
 * `getUsage()` so the runner can persist it on the heartbeat_run row. The
 * emitted `[done] … tokens=<in>/<out>` line matches the contract the web
 * client parses in `parse-agent-log.ts`, so the log viewer's Done block shows
 * tokens uniformly across runtimes.
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
		case AgentRuntime.Codex:
			return createCodexParser();
		case AgentRuntime.Gemini:
			return createGeminiParser();
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

const MAX_LINE_LEN = 500;

/**
 * Shared JSONL line processor. Buffers partial stdout bytes, splits on
 * newlines, and runs each complete line through `renderEvent`. Lines that
 * fail `JSON.parse` fall through verbatim; `renderEvent` returns `[]` to drop
 * an event. `getUsage` is supplied by the caller, which captures usage in a
 * closure as it renders the terminal event.
 */
function createJsonlParser(
	renderEvent: (event: unknown) => string[],
	getUsage: () => AgentRunUsage | null,
): AgentStreamParser {
	let buffer = '';

	const consumeLine = (line: string): string => {
		const trimmed = line.trimEnd();
		if (trimmed === '') return '';
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
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
		getUsage,
	};
}

// ---------------------------------------------------------------------------
// Chat parser
//
// The CEO chat needs the assistant's *message text* (rendered into a chat
// bubble), not the log viewer's tool/thinking trace. This parallel parser
// reuses each runtime's stream-json event knowledge but yields structured
// turn events: assistant text blocks to append, optional tool-activity hints
// for a "working…" indicator, and the terminal usage. Runs against the same
// `--output-format stream-json` output as the log parser, so it is uniform
// across claude/codex/gemini with no per-runtime persistent protocol.
// ---------------------------------------------------------------------------

export interface AgentChatTurnEvent {
	/** Assistant message text to append to the streaming bubble. */
	text?: string;
	/** Brief, human-readable tool activity (e.g. for a subtle status line). */
	toolActivity?: string;
}

export interface AgentChatParser {
	onStdout(chunk: string): AgentChatTurnEvent[];
	flush(): AgentChatTurnEvent[];
	getUsage(): AgentRunUsage | null;
}

/** Generic JSONL reader: buffers partial bytes, parses each line, maps to T[]. */
function createJsonlEventReader<T>(render: (event: unknown) => T[]): {
	onStdout(chunk: string): T[];
	flush(): T[];
} {
	let buffer = '';
	const consume = (line: string): T[] => {
		const trimmed = line.trimEnd();
		if (trimmed === '') return [];
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			return [];
		}
		return render(event);
	};
	return {
		onStdout(chunk: string): T[] {
			buffer += chunk;
			const parts = buffer.split('\n');
			buffer = parts.pop() ?? '';
			const out: T[] = [];
			for (const line of parts) out.push(...consume(line));
			return out;
		},
		flush(): T[] {
			if (buffer === '') return [];
			const remainder = buffer;
			buffer = '';
			return consume(remainder);
		},
	};
}

export function createAgentChatParser(runtime: AgentRuntime): AgentChatParser {
	switch (runtime) {
		case AgentRuntime.ClaudeCode:
			return createClaudeChatParser();
		case AgentRuntime.Codex:
			return createCodexChatParser();
		case AgentRuntime.Gemini:
			return createGeminiChatParser();
		default:
			return { onStdout: () => [], flush: () => [], getUsage: () => null };
	}
}

function createClaudeChatParser(): AgentChatParser {
	let usage: AgentRunUsage | null = null;
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as ClaudeStreamEvent;
		const out: AgentChatTurnEvent[] = [];
		if (event.type === 'assistant' && event.message) {
			for (const block of normalizeContent(event.message.content)) {
				if (block.type === 'text') {
					const text = block.text ?? '';
					if (text.trim()) out.push({ text });
				} else if (block.type === 'tool_use') {
					out.push({ toolActivity: block.name ?? 'tool' });
				}
			}
			return out;
		}
		if (event.type === 'result') {
			const u = event.usage ?? {};
			usage = {
				inputTokens:
					(u.input_tokens ?? 0) +
					(u.cache_creation_input_tokens ?? 0) +
					(u.cache_read_input_tokens ?? 0),
				outputTokens: u.output_tokens ?? 0,
				costCents: Math.round((event.total_cost_usd ?? 0) * 100),
			};
		}
		return out;
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => usage };
}

function createCodexChatParser(): AgentChatParser {
	let usage: AgentRunUsage | null = null;
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as CodexEvent;
		const type = event.type ?? '';
		if (type === 'turn.completed' || type === 'turn.failed') {
			const u = event.usage ?? {};
			usage = {
				inputTokens: u.input_tokens ?? 0,
				outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0),
				costCents: 0,
			};
			return [];
		}
		if (type === 'item.completed' && event.item) {
			const item = event.item;
			const kind = item.type ?? item.item_type ?? '';
			if (kind === 'agent_message' || kind === 'assistant_message') {
				const text = item.text ?? item.message ?? '';
				return text.trim() ? [{ text }] : [];
			}
			if (kind === 'command_execution') return [{ toolActivity: 'shell' }];
			if (kind === 'mcp_tool_call' || kind === 'tool_call') {
				return [{ toolActivity: item.name ?? 'tool' }];
			}
		}
		return [];
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => usage };
}

function createGeminiChatParser(): AgentChatParser {
	let usage: AgentRunUsage | null = null;
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as GeminiEvent;
		const type = event.type ?? '';
		if (type === 'message') {
			if (event.role === 'user') return [];
			const text = event.content ?? event.text ?? '';
			return text.trim() ? [{ text }] : [];
		}
		if (type === 'tool_use') return [{ toolActivity: event.name ?? 'tool' }];
		if (type === 'result') {
			const { input, output } = sumGeminiTokens(event.stats);
			usage = { inputTokens: input, outputTokens: output, costCents: 0 };
		}
		return [];
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => usage };
}

// ---------------------------------------------------------------------------
// Claude Code (`--output-format stream-json --verbose`)
// ---------------------------------------------------------------------------

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

function createClaudeCodeParser(): AgentStreamParser {
	let usage: AgentRunUsage | null = null;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as ClaudeStreamEvent;
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

	return createJsonlParser(renderEvent, () => usage);
}

// ---------------------------------------------------------------------------
// Codex (`codex exec --json`)
// ---------------------------------------------------------------------------

interface CodexUsage {
	input_tokens?: number;
	cached_input_tokens?: number;
	output_tokens?: number;
	reasoning_output_tokens?: number;
}

interface CodexItem {
	type?: string;
	item_type?: string;
	text?: string;
	message?: string;
	command?: string;
	aggregated_output?: string;
	output?: string;
	exit_code?: number;
	name?: string;
	arguments?: unknown;
	args?: unknown;
}

interface CodexEvent {
	type?: string;
	model?: string;
	message?: string;
	item?: CodexItem;
	usage?: CodexUsage;
	error?: { message?: string } | string;
}

function createCodexParser(): AgentStreamParser {
	let usage: AgentRunUsage | null = null;
	let turns = 0;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as CodexEvent;
		const type = event.type ?? '';

		if (type === 'thread.started') {
			return [`[session] model=${event.model ?? 'codex'} tools=0`];
		}

		// A turn wraps one user→assistant exchange (tool calls included), so a
		// single `codex exec` emits one terminal turn event. Codex reports the
		// turn's totals on `turn.completed`; the last one seen wins.
		if (type === 'turn.completed' || type === 'turn.failed') {
			turns += 1;
			const u = event.usage ?? {};
			const input = u.input_tokens ?? 0;
			const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
			usage = { inputTokens: input, outputTokens: output, costCents: 0 };
			const status = type === 'turn.failed' ? 'error' : 'success';
			return [`[done] ${status} turns=${turns} tokens=${input}/${output}`];
		}

		if (type === 'item.completed' && event.item) {
			return renderCodexItem(event.item);
		}

		if (type === 'error') {
			const msg = extractErrorMessage(event.error, event.message);
			return msg ? [`[tool-error] ${truncate(msg.replace(/\s+/g, ' ').trim(), MAX_LINE_LEN)}`] : [];
		}

		return [];
	};

	return createJsonlParser(renderEvent, () => usage);
}

function renderCodexItem(item: CodexItem): string[] {
	const kind = item.type ?? item.item_type ?? '';

	if (kind === 'reasoning') {
		const text = (item.text ?? '').trim();
		return text ? [formatThinking(text)] : [];
	}

	if (kind === 'agent_message' || kind === 'assistant_message') {
		const text = (item.text ?? item.message ?? '').trim();
		return text ? [text] : [];
	}

	if (kind === 'command_execution') {
		const out: string[] = [];
		const cmd = (item.command ?? '').replace(/\s+/g, ' ').trim();
		if (cmd) out.push(`[tool] shell(${truncate(cmd, MAX_LINE_LEN)})`);
		const output = (item.aggregated_output ?? item.output ?? '').replace(/\s+/g, ' ').trim();
		if (output) {
			const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
			out.push(`${isError ? '[tool-error]' : '[tool-result]'} ${truncate(output, MAX_LINE_LEN)}`);
		}
		return out;
	}

	if (kind === 'mcp_tool_call' || kind === 'tool_call') {
		return [formatToolUse(item.name ?? 'tool', item.arguments ?? item.args)];
	}

	return [];
}

// ---------------------------------------------------------------------------
// Gemini (`--output-format stream-json`)
// ---------------------------------------------------------------------------

interface GeminiTokens {
	prompt?: number;
	candidates?: number;
	thoughts?: number;
	total?: number;
	cached?: number;
	tool?: number;
}

interface GeminiModelStats {
	tokens?: GeminiTokens;
}

interface GeminiStats {
	models?: Record<string, GeminiModelStats>;
}

interface GeminiEvent {
	type?: string;
	model?: string;
	role?: string;
	content?: string;
	text?: string;
	name?: string;
	input?: unknown;
	args?: unknown;
	output?: unknown;
	result?: unknown;
	is_error?: boolean;
	stats?: GeminiStats;
	message?: string;
	error?: { message?: string } | string;
}

function createGeminiParser(): AgentStreamParser {
	let usage: AgentRunUsage | null = null;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as GeminiEvent;
		const type = event.type ?? '';

		if (type === 'init') {
			return [`[session] model=${event.model ?? 'gemini'} tools=0`];
		}

		if (type === 'message') {
			if (event.role === 'user') return [];
			const text = (event.content ?? event.text ?? '').trim();
			return text ? [text] : [];
		}

		if (type === 'tool_use') {
			return [formatToolUse(event.name ?? 'tool', event.input ?? event.args)];
		}

		if (type === 'tool_result') {
			const body = extractToolResultText(event.output ?? event.result)
				.replace(/\s+/g, ' ')
				.trim();
			const label = event.is_error ? '[tool-error]' : '[tool-result]';
			return [body ? `${label} ${truncate(body, MAX_LINE_LEN)}` : label];
		}

		if (type === 'result') {
			const { input, output } = sumGeminiTokens(event.stats);
			usage = { inputTokens: input, outputTokens: output, costCents: 0 };
			const status = event.error ? 'error' : 'success';
			return [`[done] ${status} tokens=${input}/${output}`];
		}

		if (type === 'error') {
			const msg = extractErrorMessage(event.error, event.message);
			return msg ? [msg.replace(/\s+/g, ' ').trim()] : [];
		}

		return [];
	};

	return createJsonlParser(renderEvent, () => usage);
}

/**
 * Sum token usage across every model Gemini reports. `prompt` is the full
 * input (the `cached` count is a subset of it, not additive); billed output is
 * the generated `candidates` plus reasoning `thoughts` tokens.
 */
function sumGeminiTokens(stats: GeminiStats | undefined): { input: number; output: number } {
	let input = 0;
	let output = 0;
	for (const model of Object.values(stats?.models ?? {})) {
		const t = model.tokens;
		if (!t) continue;
		input += t.prompt ?? 0;
		output += (t.candidates ?? 0) + (t.thoughts ?? 0);
	}
	return { input, output };
}

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

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

function extractErrorMessage(
	error: { message?: string } | string | undefined,
	fallback?: string,
): string {
	if (typeof error === 'string' && error) return error;
	if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
	return typeof fallback === 'string' ? fallback : '';
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max - 1)}…`;
}
