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
import { AgentRuntime, type CostTokens } from '@hezo/shared';

export interface AgentRunUsage {
	inputTokens: number;
	outputTokens: number;
	costCents: number;
}

/**
 * Computes a run's cost in cents from its token buckets, looked up against the
 * runtime pricing table (see `services/pricing`). Injected by the runner so the
 * parser stays a pure stream transform; defaults to `0` when no pricing is
 * wired (standalone use / tests that don't exercise cost).
 */
export type PriceModelFn = (model: string | undefined, tokens: CostTokens) => number;

const NO_PRICE: PriceModelFn = () => 0;

export interface AgentStreamParser {
	onStdout(chunk: string): string;
	onStderr(chunk: string): string;
	flush(): string;
	getUsage(): AgentRunUsage | null;
	/**
	 * The run's terminal error reason, captured from the runtime's own error
	 * event (e.g. a provider billing/auth rejection), or null when the run
	 * carried no such failure. Lets the runner surface *why* a run failed on the
	 * heartbeat_run row instead of leaving the reason buried in the log.
	 */
	getTerminalError(): string | null;
}

/**
 * Maps a runtime's terminal error message to a concise, operator-actionable
 * reason. Recognises the common provider failure modes — exhausted credit/quota
 * and rejected authentication — so a failed run states the cause; falls back to
 * the runtime's own message for anything else.
 */
export function classifyRuntimeError(raw: string | undefined | null): string | null {
	const text = (raw ?? '').trim();
	if (!text) return null;
	const lower = text.toLowerCase();
	if (
		/402|insufficient\s+balance|insufficient\s+(funds|credit|quota)|payment\s+required|billing|exceeded your current quota/.test(
			lower,
		)
	) {
		return `AI provider rejected the request for lack of credit/quota — top up or switch the team's provider credential. (${text})`;
	}
	if (
		/401|authentication|unauthorized|invalid api key|invalid x-api-key|not logged in/.test(lower)
	) {
		return `AI provider authentication failed — check the team's provider credential. (${text})`;
	}
	return text;
}

export function createAgentStreamParser(
	runtime: AgentRuntime,
	price: PriceModelFn = NO_PRICE,
): AgentStreamParser {
	switch (runtime) {
		case AgentRuntime.ClaudeCode:
			return createClaudeCodeParser(price);
		case AgentRuntime.Codex:
			return createCodexParser(price);
		case AgentRuntime.Gemini:
			return createGeminiParser(price);
		// OpenCode (`run --format json`) emits JSONL but with shapes that vary
		// across versions and aren't fully documented. The generic parser is
		// lenient — it renders recognizable assistant text / tool activity and
		// captures token usage from whatever terminal event carries it, dropping
		// anything it doesn't recognize so the log stays clean. Tighten into a
		// bespoke parser once a real run's events are captured (see PR notes).
		case AgentRuntime.OpenCode:
			return createGenericJsonlParser(price);
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
		getTerminalError: () => null,
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
	getTerminalError: () => string | null = () => null,
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
		getTerminalError,
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

export function createAgentChatParser(
	runtime: AgentRuntime,
	price: PriceModelFn = NO_PRICE,
): AgentChatParser {
	switch (runtime) {
		case AgentRuntime.ClaudeCode:
			return createClaudeChatParser(price);
		case AgentRuntime.Codex:
			return createCodexChatParser(price);
		case AgentRuntime.Gemini:
			return createGeminiChatParser(price);
		case AgentRuntime.OpenCode:
			return createGenericChatParser(price);
		default:
			return { onStdout: () => [], flush: () => [], getUsage: () => null };
	}
}

function createClaudeChatParser(price: PriceModelFn): AgentChatParser {
	let usage: AgentRunUsage | null = null;
	let modelId: string | undefined;
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as ClaudeStreamEvent;
		const out: AgentChatTurnEvent[] = [];
		if (event.type === 'system' && event.subtype === 'init') {
			modelId = event.model ?? undefined;
			return out;
		}
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
			const regularInput = u.input_tokens ?? 0;
			const cacheCreation = u.cache_creation_input_tokens ?? 0;
			const cacheRead = u.cache_read_input_tokens ?? 0;
			const output = u.output_tokens ?? 0;
			// Same policy as the run parser: the runtime's own dollar figure is
			// ignored; cost comes from the pricing table over the token buckets.
			usage = {
				inputTokens: regularInput + cacheCreation + cacheRead,
				outputTokens: output,
				costCents: price(modelId, {
					inputTokens: regularInput,
					cacheCreationTokens: cacheCreation,
					cacheReadTokens: cacheRead,
					outputTokens: output,
				}),
			};
		}
		return out;
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => usage };
}

function createCodexChatParser(price: PriceModelFn): AgentChatParser {
	let usage: AgentRunUsage | null = null;
	let modelId: string | undefined;
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as CodexEvent;
		const type = event.type ?? '';
		if (type === 'thread.started') {
			modelId = event.model ?? undefined;
			return [];
		}
		if (type === 'turn.completed' || type === 'turn.failed') {
			const u = event.usage ?? {};
			const input = u.input_tokens ?? 0;
			const cached = u.cached_input_tokens ?? 0;
			const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
			usage = {
				inputTokens: input,
				outputTokens: output,
				costCents: price(modelId, {
					inputTokens: Math.max(0, input - cached),
					cacheReadTokens: cached,
					outputTokens: output,
				}),
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

function createGeminiChatParser(price: PriceModelFn): AgentChatParser {
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
			usage = {
				inputTokens: input,
				outputTokens: output,
				costCents: priceGeminiModels(event.stats, price),
			};
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
	usage?: ClaudeUsage;
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

function createClaudeCodeParser(price: PriceModelFn): AgentStreamParser {
	let usage: AgentRunUsage | null = null;
	let modelId: string | undefined;
	let terminalError: string | null = null;
	// Running token totals, accumulated from each assistant turn's `message.usage`,
	// so a run interrupted before its terminal `result` event (e.g. a server
	// restart mid-run) still reports the tokens it burned. Each assistant message
	// carries that API call's usage; Claude Code's final `result.usage` is the sum
	// across turns, so the running total converges to it and is replaced by the
	// authoritative figure once `result` lands.
	const run = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
	let sawResult = false;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as ClaudeStreamEvent;
		const out: string[] = [];

		if (event.type === 'system' && event.subtype === 'init') {
			const toolCount = Array.isArray(event.tools) ? event.tools.length : 0;
			modelId = event.model ?? undefined;
			out.push(`[session] model=${modelId ?? 'unknown'} tools=${toolCount}`);
			return out;
		}

		if (event.type === 'assistant' && event.message) {
			const mu = event.message.usage;
			if (mu && !sawResult) {
				run.input += mu.input_tokens ?? 0;
				run.cacheCreation += mu.cache_creation_input_tokens ?? 0;
				run.cacheRead += mu.cache_read_input_tokens ?? 0;
				run.output += mu.output_tokens ?? 0;
				usage = {
					inputTokens: run.input + run.cacheCreation + run.cacheRead,
					outputTokens: run.output,
					costCents: price(modelId, {
						inputTokens: run.input,
						cacheCreationTokens: run.cacheCreation,
						cacheReadTokens: run.cacheRead,
						outputTokens: run.output,
					}),
				};
			}
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
			sawResult = true;
			const u = event.usage ?? {};
			const regularInput = u.input_tokens ?? 0;
			const cacheCreation = u.cache_creation_input_tokens ?? 0;
			const cacheRead = u.cache_read_input_tokens ?? 0;
			// Displayed aggregate keeps every input token; cost prices the buckets
			// separately (cache read ~0.1x, cache creation ~1.25x of base input).
			const input = regularInput + cacheCreation + cacheRead;
			const output = u.output_tokens ?? 0;
			// The runtime's own dollar figure (total_cost_usd) is ignored — it's a
			// client-side estimate from the CLI's rate card, which is the wrong
			// provider's for third-party Anthropic-compatible endpoints. Cost always
			// comes from the pricing table over the reported token buckets.
			const costCents = price(modelId, {
				inputTokens: regularInput,
				cacheCreationTokens: cacheCreation,
				cacheReadTokens: cacheRead,
				outputTokens: output,
			});
			usage = { inputTokens: input, outputTokens: output, costCents };
			const duration = event.duration_ms ?? 0;
			const turns = event.num_turns ?? 0;
			const status = event.is_error ? 'error' : (event.subtype ?? 'success');
			if (event.is_error) terminalError = classifyRuntimeError(event.result) ?? terminalError;
			out.push(
				`[done] ${status} turns=${turns} duration=${duration}ms tokens=${input}/${output} cost=$${(costCents / 100).toFixed(4)}`,
			);
			return out;
		}

		return out;
	};

	return createJsonlParser(
		renderEvent,
		() => usage,
		() => terminalError,
	);
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

function createCodexParser(price: PriceModelFn): AgentStreamParser {
	let usage: AgentRunUsage | null = null;
	let turns = 0;
	let modelId: string | undefined;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as CodexEvent;
		const type = event.type ?? '';

		if (type === 'thread.started') {
			modelId = event.model ?? undefined;
			return [`[session] model=${modelId ?? 'codex'} tools=0`];
		}

		// A turn wraps one user→assistant exchange (tool calls included), so a
		// single `codex exec` emits one terminal turn event. Codex reports the
		// turn's totals on `turn.completed`; the last one seen wins.
		if (type === 'turn.completed' || type === 'turn.failed') {
			turns += 1;
			const u = event.usage ?? {};
			const input = u.input_tokens ?? 0;
			const cached = u.cached_input_tokens ?? 0;
			const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
			// `input_tokens` already includes `cached_input_tokens`; price the cached
			// portion at the (discounted) cache-read rate, the rest at full input.
			usage = {
				inputTokens: input,
				outputTokens: output,
				costCents: price(modelId, {
					inputTokens: Math.max(0, input - cached),
					cacheReadTokens: cached,
					outputTokens: output,
				}),
			};
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

function createGeminiParser(price: PriceModelFn): AgentStreamParser {
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
			const costCents = priceGeminiModels(event.stats, price);
			usage = { inputTokens: input, outputTokens: output, costCents };
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

/**
 * Price each model Gemini reports separately and sum the cents. `cached` is a
 * subset of `prompt` billed at the cache-read rate; the rest of `prompt` is
 * full-rate input, and billed output is `candidates` + reasoning `thoughts`.
 */
function priceGeminiModels(stats: GeminiStats | undefined, price: PriceModelFn): number {
	let cents = 0;
	for (const [modelId, model] of Object.entries(stats?.models ?? {})) {
		const t = model.tokens;
		if (!t) continue;
		const prompt = t.prompt ?? 0;
		const cached = t.cached ?? 0;
		const output = (t.candidates ?? 0) + (t.thoughts ?? 0);
		cents += price(modelId, {
			inputTokens: Math.max(0, prompt - cached),
			cacheReadTokens: cached,
			outputTokens: output,
		});
	}
	return cents;
}

// ---------------------------------------------------------------------------
// Generic JSONL parser (OpenCode)
//
// This CLI emits JSONL whose event shapes vary by version and aren't fully
// documented, so rather than guess a single rigid schema this parser probes a
// broad set of conventional field names. It renders assistant text, tool
// activity, thinking, and errors when recognizable, and captures token usage
// from whatever terminal event carries it. Unknown events are dropped so the
// log stays clean. Replace with a bespoke parser once a real run is captured.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === 'object' && !Array.isArray(v);
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'string' && v.trim()) return v;
	}
	return undefined;
}

function firstNumber(obj: Record<string, unknown>, keys: readonly string[]): number {
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
	}
	return 0;
}

/** Pull assistant-visible text out of a loosely-typed event. */
function extractGenericText(event: Record<string, unknown>): string {
	const role = typeof event.role === 'string' ? event.role : undefined;
	if (role === 'user' || role === 'tool') return '';

	const direct = firstString(event, ['text', 'content', 'response', 'output_text']);
	if (direct) return direct.trim();

	for (const nestedKey of ['delta', 'part', 'message']) {
		const nested = event[nestedKey];
		if (typeof nested === 'string' && nested.trim()) return nested.trim();
		if (isRecord(nested)) {
			const nestedRole = typeof nested.role === 'string' ? nested.role : undefined;
			if (nestedRole === 'user' || nestedRole === 'tool') continue;
			const text = firstString(nested, ['text', 'content']);
			if (text) return text.trim();
			if (Array.isArray(nested.content)) {
				const joined = (nested.content as unknown[])
					.map((b) => (isRecord(b) && typeof b.text === 'string' ? b.text : ''))
					.filter(Boolean)
					.join(' ')
					.trim();
				if (joined) return joined;
			}
		}
	}
	return '';
}

/** Detect a tool-call event and return its display name, or null. */
function extractGenericTool(event: Record<string, unknown>, type: string): string | null {
	const looksToolish = /tool|function|command|bash|shell/.test(type.toLowerCase());
	const name = firstString(event, ['name', 'tool', 'tool_name', 'function']);
	const part = isRecord(event.part) ? event.part : undefined;
	const partName = part ? firstString(part, ['name', 'tool', 'tool_name']) : undefined;
	if (looksToolish || name || partName) return name ?? partName ?? 'tool';
	return null;
}

/** Find a token-usage object on the event and normalize it. */
function extractGenericUsage(
	event: Record<string, unknown>,
	price: PriceModelFn,
	modelId: string | undefined,
): AgentRunUsage | null {
	const u = [event.usage, event.tokens, event.stats].find(isRecord);
	if (!u) return null;
	const input = firstNumber(u, ['input_tokens', 'prompt_tokens', 'prompt', 'input']);
	const cached = firstNumber(u, ['cached_input_tokens', 'cache_read_input_tokens', 'cached']);
	const output =
		firstNumber(u, ['output_tokens', 'completion_tokens', 'candidates', 'output']) +
		firstNumber(u, ['reasoning_output_tokens', 'thoughts']);
	if (input === 0 && output === 0) return null;
	const costCents = price(modelId, {
		inputTokens: Math.max(0, input - cached),
		cacheReadTokens: cached,
		outputTokens: output,
	});
	return { inputTokens: input, outputTokens: output, costCents };
}

const GENERIC_TERMINAL_RE = /complete|finish|result|done|stop|\bend\b/i;

function createGenericJsonlParser(price: PriceModelFn): AgentStreamParser {
	let usage: AgentRunUsage | null = null;
	let modelId: string | undefined;

	const renderEvent = (raw: unknown): string[] => {
		if (!isRecord(raw)) return [];
		const event = raw;
		const type = typeof event.type === 'string' ? event.type : '';
		const model = firstString(event, ['model']);
		if (model) modelId = model;

		const captured = extractGenericUsage(event, price, modelId);
		if (captured) usage = captured;

		const errText = extractErrorMessage(
			event.error as { message?: string } | string | undefined,
			typeof event.message === 'string' ? event.message : undefined,
		);
		if (/error|fail/i.test(type) && errText) {
			return [`[tool-error] ${truncate(errText.replace(/\s+/g, ' ').trim(), MAX_LINE_LEN)}`];
		}

		if (/reason|think/i.test(type)) {
			const t = firstString(event, ['text', 'content', 'thinking']);
			return t ? [formatThinking(t)] : [];
		}

		const toolName = extractGenericTool(event, type);
		if (toolName) {
			return [formatToolUse(toolName, event.input ?? event.arguments ?? event.args)];
		}

		const text = extractGenericText(event);
		if (text) return [text];

		if (captured && GENERIC_TERMINAL_RE.test(type)) {
			return [`[done] success tokens=${captured.inputTokens}/${captured.outputTokens}`];
		}
		return [];
	};

	return createJsonlParser(renderEvent, () => usage);
}

function createGenericChatParser(price: PriceModelFn): AgentChatParser {
	let usage: AgentRunUsage | null = null;
	let modelId: string | undefined;
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		if (!isRecord(raw)) return [];
		const event = raw;
		const type = typeof event.type === 'string' ? event.type : '';
		const model = firstString(event, ['model']);
		if (model) modelId = model;
		const captured = extractGenericUsage(event, price, modelId);
		if (captured) usage = captured;
		const toolName = extractGenericTool(event, type);
		if (toolName) return [{ toolActivity: toolName }];
		const text = extractGenericText(event);
		return text ? [{ text }] : [];
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => usage };
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
