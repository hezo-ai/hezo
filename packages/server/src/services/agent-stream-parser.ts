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
import { HEZO_MCP_SERVER_NAME } from './mcp-injectors/types';

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
	/**
	 * The run's last human-visible assistant text (its final message), or null
	 * when the run produced none. A run's final message is otherwise delivered to
	 * no one — it is logged, not posted — so the runner uses this to detect a
	 * handoff/@-mention the agent left only in its final message and deliver it as
	 * a real comment (see the handoff-delivery guardrail in `agent-runner.ts`).
	 */
	getFinalAssistantMessage(): string | null;
	/**
	 * How many tools each MCP server contributed to this run, keyed by server
	 * name, or null when the runtime reported nothing usable.
	 *
	 * The same figures the `[session]` banner carries, kept so the runner can
	 * persist them on the run row. `=connected` only ever meant the transport came
	 * up, so an agent suspecting a connector is broken has no first-party way to
	 * check what it actually received — it infers, and a wrong inference has
	 * already outlived several runs by way of a progress summary. This is that
	 * fact, reachable from inside the run through `list_connectors`.
	 *
	 * Null rather than `{}` when the tool array was unreadable or the runtime
	 * emits no such event, so "not reported" stays distinguishable from "reported
	 * zero" — the latter is the actionable one.
	 */
	getMcpToolCounts(): Record<string, number> | null;
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
		// Grok's `streaming-json` emits thought/text/end events and NO token usage;
		// usage is recovered post-run from the `--debug-file` (see the runner and
		// `extractGrokUsageFromDebugLog`), so this parser's getUsage() stays null.
		case AgentRuntime.Grok:
			return createGrokParser();
		// Kimi Code's `stream-json` is role-discriminated JSONL and, like Grok,
		// carries no token usage; usage is recovered post-run from the per-session
		// `wire.jsonl` (see the runner and `extractKimiUsageFromSessionLog`), so this
		// parser's getUsage() stays null.
		case AgentRuntime.Kimi:
			return createKimiParser();
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
		getFinalAssistantMessage: () => null,
		getMcpToolCounts: () => null,
	};
}

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
	getFinalAssistantMessage: () => string | null = () => null,
	getMcpToolCounts: () => Record<string, number> | null = () => null,
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
		getFinalAssistantMessage,
		getMcpToolCounts,
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
		case AgentRuntime.Grok:
			return createGrokChatParser();
		case AgentRuntime.Kimi:
			return createKimiChatParser();
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

/** Per-server entry of the `init` event's MCP startup report. */
interface ClaudeMcpServerStatus {
	name?: string;
	status?: string;
}

interface ClaudeStreamEvent {
	type?: string;
	subtype?: string;
	message?: ClaudeMessage;
	tools?: unknown[];
	mcp_servers?: ClaudeMcpServerStatus[];
	model?: string;
	session_id?: string;
	duration_ms?: number;
	num_turns?: number;
	result?: string;
	is_error?: boolean;
	total_cost_usd?: number;
	usage?: ClaudeUsage;
}

/**
 * Statuses in the `init` report that mean the run will **not** get that
 * server's tools, as opposed to "not yet".
 *
 * Measured against Claude Code 2.1.220 on a live run, and it is not what the
 * event's shape suggests: MCP servers connect **asynchronously, after** `init`
 * is emitted, so a perfectly healthy run reports `pending` there and its `tools`
 * array carries the built-ins only - the CLI even ships a `WaitForMcpServers`
 * tool for an agent to block on. Reading anything-but-`connected` as a failure
 * therefore fails every healthy Claude Code run, which is exactly what the live
 * agent-CLI conformance suite caught before it shipped.
 *
 * An unrecognised status is deliberately **not** a failure, for the same reason:
 * this set is what the CLI is known to emit, and a CLI upgrade that adds a
 * status must not start failing runs on a string nobody has seen.
 */
const CLAUDE_MCP_FAILED_STATUSES = new Set(['failed', 'error', 'needs-auth']);

/**
 * Whether the runtime reported the Hezo MCP server as unusable this session.
 *
 * A Hezo server that failed means the agent has no Hezo tools for the entire
 * run: it cannot read a task, post a comment, or even call `report_no_work`. It
 * then runs to completion against a system prompt that assumes ~73 tools exist,
 * burns its whole budget, and fails as "produced no output" - which reads as a
 * lazy model rather than a dead transport. `tools=25` in the session line was
 * the only tell, and nothing looked at it.
 *
 * **This can only ever rule a server out, never in.** `init` is the sole event
 * carrying the status and it fires before the servers have connected, so
 * `pending` there says nothing either way and no later event restates it. The
 * guard for a server that quietly never connects is the tunnel's own `onClosed`,
 * which is backend-agnostic and needs no cooperation from the runtime.
 *
 * A missing `mcp_servers` array means the runtime told us nothing (an older CLI,
 * or a runtime that does not report it), which is likewise not a failure.
 */
function claudeHezoMcpFailure(servers: ClaudeMcpServerStatus[] | undefined): string | null {
	if (!Array.isArray(servers) || servers.length === 0) return null;
	const hezo = servers.find((s) => s?.name === HEZO_MCP_SERVER_NAME);
	if (!hezo || !CLAUDE_MCP_FAILED_STATUSES.has((hezo.status ?? '').toLowerCase())) return null;
	return (
		`the Hezo MCP server did not connect (status: ${hezo.status ?? 'unknown'}), so this run had ` +
		'no Hezo tools at all - it could not read tasks, post comments, or record any work. ' +
		'The container reaches Hezo only through the run tunnel, so check that the tunnel bound ' +
		'and stayed up for this run.'
	);
}

/**
 * Tool names carried by an `init` event's `tools` array.
 *
 * The CLI types the array loosely and Hezo has only ever needed its length, so
 * accept both plausible shapes (a bare name, or an object carrying one) and skip
 * anything else. A partial read still answers the question this exists for, and a
 * shape change must degrade to "no per-server counts", never to a broken session
 * line.
 */
function initToolNames(tools: unknown[] | undefined): string[] {
	if (!Array.isArray(tools)) return [];
	const names: string[] = [];
	for (const entry of tools) {
		if (typeof entry === 'string') {
			names.push(entry);
			continue;
		}
		const name = (entry as { name?: unknown } | null)?.name;
		if (typeof name === 'string') names.push(name);
	}
	return names;
}

/**
 * How many tools each MCP server contributed, counted by the
 * `mcp__<server>__<tool>` namespace the injector builds (see
 * `mcp-injectors/claude-code.ts`).
 *
 * Matched against the server names the event itself reports rather than by
 * splitting on `__`, so a connector whose own name contains the separator is
 * still counted correctly.
 */
function mcpToolCounts(
	names: readonly string[],
	servers: readonly ClaudeMcpServerStatus[],
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const server of servers) {
		const serverName = server?.name;
		if (!serverName) continue;
		const prefix = `mcp__${serverName}__`;
		counts.set(serverName, names.filter((n) => n.startsWith(prefix)).length);
	}
	return counts;
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
	let finalMessage: string | null = null;
	// Kept past the session line so the runner can persist it on the run row and
	// `list_connectors` can answer, from inside the run, what each connector
	// actually contributed. Stays null when no tool name parsed.
	let mcpCounts: Record<string, number> | null = null;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as ClaudeStreamEvent;
		const out: string[] = [];

		if (event.type === 'system' && event.subtype === 'init') {
			const toolCount = Array.isArray(event.tools) ? event.tools.length : 0;
			modelId = event.model ?? undefined;
			const mcpServers = event.mcp_servers ?? [];
			// The per-server states go in the session line too, so a log read after
			// the fact answers "did it have its tools?" without needing the raw
			// stream - the question a bare `tools=25` left the reader to guess at.
			//
			// The state alone does not answer it, though: `connected` means the
			// session came up, not that the server's tools reached the model. So
			// carry a per-server tool count alongside it, derived from the names.
			// Omitted entirely when no name parsed, rather than printing a
			// misleading zero for every server.
			const toolNames = initToolNames(event.tools);
			const counts = toolNames.length > 0 ? mcpToolCounts(toolNames, mcpServers) : null;
			if (counts) mcpCounts = Object.fromEntries(counts);
			const servers = mcpServers
				.map((s) => {
					const count = s?.name === undefined ? undefined : counts?.get(s.name);
					return `${s?.name ?? '?'}=${s?.status ?? '?'}${count === undefined ? '' : `(${count})`}`;
				})
				.join(' ');
			out.push(
				`[session] model=${modelId ?? 'unknown'} tools=${toolCount}${servers ? ` mcp: ${servers}` : ''}`,
			);
			// Connected but contributing nothing is the shape of a server whose tools
			// never reached the model - a tool list the runtime deferred behind its
			// own search tool, an empty catalogue, or an allowlist that withheld
			// everything. The banner's status would read healthy, so say it outright.
			for (const s of mcpServers) {
				const name = s?.name;
				if (!name || (s?.status ?? '').toLowerCase() !== 'connected') continue;
				if (counts?.get(name) === 0) {
					out.push(
						`[runner] MCP server "${name}" connected but contributed no tools to this run, so the agent cannot call them.`,
					);
				}
			}
			const mcpFailure = claudeHezoMcpFailure(event.mcp_servers);
			if (mcpFailure) {
				// Recorded as the run's terminal error rather than just logged: it is
				// the *cause* of everything that follows, and the runner surfaces it on
				// the run row ahead of the "produced no output" symptom.
				terminalError = mcpFailure;
				out.push(`[runner] ${mcpFailure}`);
			}
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
					if (text) {
						out.push(text);
						// Fallback capture of the run's final message for runs that end
						// without a `result` event; the authoritative value is `result`.
						finalMessage = text;
					}
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
			// `result` is Claude Code's authoritative final assistant message on a
			// clean turn; on an error turn it carries the failure text, so only take
			// it as the run's final message when the result is not an error.
			if (!event.is_error && typeof event.result === 'string' && event.result.trim()) {
				finalMessage = event.result.trim();
			}
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
		() => finalMessage,
		() => mcpCounts,
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
	let finalMessage: string | null = null;

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
			const kind = event.item.type ?? event.item.item_type ?? '';
			if (kind === 'agent_message' || kind === 'assistant_message') {
				const text = (event.item.text ?? event.item.message ?? '').trim();
				if (text) finalMessage = text;
			}
			return renderCodexItem(event.item);
		}

		if (type === 'error') {
			const msg = extractErrorMessage(event.error, event.message);
			return msg ? [`[tool-error] ${msg.replace(/\s+/g, ' ').trim()}`] : [];
		}

		return [];
	};

	return createJsonlParser(
		renderEvent,
		() => usage,
		() => null,
		() => finalMessage,
	);
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
		if (cmd) out.push(`[tool] shell(${cmd})`);
		const output = (item.aggregated_output ?? item.output ?? '').replace(/\s+/g, ' ').trim();
		if (output) {
			const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
			out.push(`${isError ? '[tool-error]' : '[tool-result]'} ${output}`);
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
	let finalMessage: string | null = null;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as GeminiEvent;
		const type = event.type ?? '';

		if (type === 'init') {
			return [`[session] model=${event.model ?? 'gemini'} tools=0`];
		}

		if (type === 'message') {
			if (event.role === 'user') return [];
			const text = (event.content ?? event.text ?? '').trim();
			if (text) finalMessage = text;
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
			return [body ? `${label} ${body}` : label];
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

	return createJsonlParser(
		renderEvent,
		() => usage,
		() => null,
		() => finalMessage,
	);
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
	let finalMessage: string | null = null;

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
			return [`[tool-error] ${errText.replace(/\s+/g, ' ').trim()}`];
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
		if (text) {
			finalMessage = text;
			return [text];
		}

		if (captured && GENERIC_TERMINAL_RE.test(type)) {
			return [`[done] success tokens=${captured.inputTokens}/${captured.outputTokens}`];
		}
		return [];
	};

	return createJsonlParser(
		renderEvent,
		() => usage,
		() => null,
		() => finalMessage,
	);
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
// Grok (`grok -p … --output-format streaming-json`)
//
// Grok's stream is a sequence of `{"type":"thought","data":…}` (reasoning
// chunks), `{"type":"text","data":…}` (assistant text chunks) and a terminal
// `{"type":"end","stopReason":…}`. It carries NO token usage — cost is recovered
// separately from the `--debug-file` (see `extractGrokUsageFromDebugLog`), so
// `getUsage()` here is always null and the runner supplies the real usage.
// ---------------------------------------------------------------------------

interface GrokEvent {
	type?: string;
	data?: string;
	stopReason?: string;
	message?: string;
	sessionId?: string;
}

function createGrokParser(): AgentStreamParser {
	let terminalError: string | null = null;
	let thoughtBuf = '';
	let textBuf = '';
	let finalMessage: string | null = null;

	const flushThought = (out: string[]): void => {
		if (thoughtBuf.trim()) out.push(formatThinking(thoughtBuf));
		thoughtBuf = '';
	};
	const flushText = (out: string[]): void => {
		const t = textBuf.trim();
		if (t) {
			out.push(t);
			// Grok streams assistant text as `text` deltas and has no `result`
			// event, so the flushed buffer IS the run's final message. Capturing
			// it is what makes the runner's handoff-delivery net work here at all
			// — and it matters more on Grok than anywhere else, because Grok is
			// also one of the two runtimes whose hooks cannot host the
			// completeness judge, so the net is its only guardrail.
			finalMessage = t;
		}
		textBuf = '';
	};

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as GrokEvent;
		const type = event.type ?? '';

		if (type === 'thought') {
			thoughtBuf += event.data ?? '';
			return [];
		}
		if (type === 'text') {
			const out: string[] = [];
			flushThought(out);
			textBuf += event.data ?? '';
			return out;
		}
		if (type === 'end') {
			const out: string[] = [];
			flushThought(out);
			flushText(out);
			const status = event.stopReason ? String(event.stopReason) : 'success';
			// No token counts in the stream; usage is filled from the debug file.
			out.push(`[done] ${status}`);
			return out;
		}
		if (type === 'error') {
			const msg = extractErrorMessage(undefined, event.message);
			if (msg) terminalError = classifyRuntimeError(msg) ?? terminalError;
			return msg ? [`[tool-error] ${msg.replace(/\s+/g, ' ').trim()}`] : [];
		}
		return [];
	};

	return createJsonlParser(
		renderEvent,
		() => null,
		() => terminalError,
		() => finalMessage,
	);
}

function createGrokChatParser(): AgentChatParser {
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as GrokEvent;
		// Stream the assistant text into the chat bubble; reasoning is not shown.
		if (event.type === 'text' && event.data) return [{ text: event.data }];
		return [];
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => null };
}

function matchInt(line: string, re: RegExp): number | null {
	const m = line.match(re);
	return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Recover a Grok run's token usage from its `--debug-file` contents.
 *
 * Grok emits no usage on stdout, but its debug log records one
 * `process_conversation_turn` tracing span per turn carrying
 * `input_tokens=` / `output_tokens=` / `cache_read_tokens=` (and `model_id=` /
 * `request_id=`). The span's fields are echoed on several lines within the same
 * span, so we key by `request_id` (last write wins) before summing across turns,
 * then price the buckets the same way the Codex parser does (input_tokens is
 * inclusive of the cached portion — bill `input - cache_read` at the full input
 * rate and `cache_read` at the discounted cache-read rate). Returns null when the
 * log contains no usable span (unpriced ⇒ the caller records $0, fail-low).
 */
export function extractGrokUsageFromDebugLog(
	contents: string,
	price: PriceModelFn = NO_PRICE,
): AgentRunUsage | null {
	const byRequest = new Map<
		string,
		{ input: number; output: number; cacheRead: number; model?: string }
	>();
	let counter = 0;
	for (const line of contents.split('\n')) {
		if (!line.includes('input_tokens=')) continue;
		const input = matchInt(line, /\binput_tokens=(\d+)/);
		if (input === null) continue;
		const output = matchInt(line, /\boutput_tokens=(\d+)/) ?? 0;
		const cacheRead = matchInt(line, /\bcache_read_tokens=(\d+)/) ?? 0;
		const reqMatch = line.match(/\brequest_id="([^"]+)"/);
		const modelMatch = line.match(/\bmodel_id="([^"]+)"/);
		const reqId = reqMatch ? reqMatch[1] : `#${counter++}`;
		byRequest.set(reqId, {
			input,
			output,
			cacheRead,
			model: modelMatch ? modelMatch[1] : undefined,
		});
	}
	if (byRequest.size === 0) return null;

	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let model: string | undefined;
	for (const t of byRequest.values()) {
		input += t.input;
		output += t.output;
		cacheRead += t.cacheRead;
		if (t.model) model = t.model;
	}
	const costCents = price(model, {
		inputTokens: Math.max(0, input - cacheRead),
		cacheReadTokens: cacheRead,
		outputTokens: output,
	});
	return { inputTokens: input, outputTokens: output, costCents };
}

// ---------------------------------------------------------------------------
// Kimi Code (`kimi --output-format stream-json`)
//
// One JSON object per stdout line, discriminated by `role`:
//   {"role":"assistant","content":"…","tool_calls":[{"type":"function","id":"…",
//     "function":{"name":"…","arguments":"…"}}]}
//   {"role":"tool","tool_call_id":"…","content":"…"}
//   {"role":"meta","type":"turn.step.retrying"|"session.resume_hint"|"system.version",…}
//
// Thinking content and tool progress go to STDERR, not this stream, so there is
// no [thinking] rendering here — stderr passes through untouched.
//
// Like Grok, the stream carries NO token usage, so getUsage() stays null and cost
// comes from `extractKimiUsageFromSessionLog` post-run.
// ---------------------------------------------------------------------------

interface KimiToolCall {
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

interface KimiEvent {
	role?: string;
	content?: unknown;
	tool_calls?: KimiToolCall[];
	tool_call_id?: string;
	type?: string;
	version?: string;
	error_name?: string;
	error_message?: string;
	status_code?: number;
	failed_attempt?: number;
	next_attempt?: number;
	max_attempts?: number;
}

/** Kimi writes `content` as a plain string, but tolerate Claude-style blocks. */
function kimiContentText(content: unknown): string {
	if (typeof content === 'string') return content;
	return extractToolResultText(content);
}

function createKimiParser(): AgentStreamParser {
	let terminalError: string | null = null;
	let finalAssistantMessage: string | null = null;

	const renderEvent = (raw: unknown): string[] => {
		const event = raw as KimiEvent;
		const out: string[] = [];

		if (event.role === 'assistant') {
			const text = kimiContentText(event.content).trim();
			if (text) {
				// Every assistant line is a candidate; the last one wins, which is what
				// the runner's handoff-delivery net needs.
				finalAssistantMessage = text;
				out.push(text);
			}
			for (const call of event.tool_calls ?? []) {
				const name = call.function?.name ?? 'tool';
				// `arguments` is a JSON *string* on the wire; parse it so the log renders
				// `name(a=1, b=2)` like every other runtime rather than a quoted blob.
				let args: unknown = call.function?.arguments;
				if (typeof args === 'string') {
					try {
						args = JSON.parse(args);
					} catch {
						// Leave it as the raw string — renderToolInput stringifies it fine.
					}
				}
				out.push(formatToolUse(name, args));
			}
			return out;
		}

		if (event.role === 'tool') {
			const body = kimiContentText(event.content).replace(/\s+/g, ' ').trim();
			return [body ? `[tool-result] ${body}` : '[tool-result]'];
		}

		if (event.role === 'meta') {
			if (event.type === 'turn.step.retrying') {
				// A retry is the only place Kimi surfaces an upstream failure on stdout
				// (402/401 land here), so it is both logged and classified. It is not
				// necessarily fatal — the CLI retries — but if the run then fails, this
				// is the most useful cause to report.
				const msg = extractErrorMessage(undefined, event.error_message ?? event.error_name);
				if (msg) terminalError = classifyRuntimeError(msg) ?? terminalError;
				const attempt =
					event.failed_attempt && event.max_attempts
						? ` (attempt ${event.failed_attempt}/${event.max_attempts})`
						: '';
				return [`[system] retrying after error${attempt}${msg ? `: ${msg}` : ''}`];
			}
			// `session.resume_hint` is a "how to resume this session" convenience for
			// interactive users; it is pure noise in a headless run log. Drop it.
			return [];
		}

		return [];
	};

	return createJsonlParser(
		renderEvent,
		() => null,
		() => terminalError,
		() => finalAssistantMessage,
	);
}

function createKimiChatParser(): AgentChatParser {
	const render = (raw: unknown): AgentChatTurnEvent[] => {
		const event = raw as KimiEvent;
		if (event.role !== 'assistant') return [];
		const text = kimiContentText(event.content);
		return text ? [{ text }] : [];
	};
	const reader = createJsonlEventReader(render);
	return { onStdout: reader.onStdout, flush: reader.flush, getUsage: () => null };
}

/** Numeric field probe tolerant of camelCase and snake_case spellings. */
function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
	for (const key of keys) {
		const v = source[key];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
	}
	return null;
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const v = source[key];
		if (typeof v === 'string' && v.trim()) return v;
	}
	return undefined;
}

const KIMI_INPUT_KEYS = ['inputOther', 'input_other'] as const;
const KIMI_OUTPUT_KEYS = ['output'] as const;
const KIMI_CACHE_READ_KEYS = ['inputCacheRead', 'input_cache_read'] as const;
const KIMI_CACHE_CREATION_KEYS = ['inputCacheCreation', 'input_cache_creation'] as const;
const KIMI_MODEL_KEYS = ['model', 'model_id', 'modelId', 'model_name'] as const;
const KIMI_SCOPE_KEYS = ['scope', 'kind', 'level'] as const;
const KIMI_RECORD_ID_KEYS = ['request_id', 'requestId', 'id'] as const;

/**
 * Recover a Kimi Code run's token usage from its per-session `wire.jsonl`.
 *
 * Kimi Code emits no usage on stdout (see `createKimiParser`), but its session
 * log records usage per API call with the buckets Hezo needs:
 * `inputOther` / `output` / `inputCacheRead` / `inputCacheCreation`.
 *
 * Two hazards this handles:
 *
 *  1. **Turn- vs session-scoped records.** Session-scoped records are *cumulative
 *     totals*, so summing them alongside per-turn records double-counts. When any
 *     scope-tagged turn record is present, only those are summed; otherwise the
 *     last session-scoped record is taken as the authoritative total. Untagged
 *     records are summed, which is the natural reading of a wire log (one record
 *     per request).
 *  2. **Duplicate records.** As with Grok's spans, a record may be echoed; entries
 *     are keyed by request id (last write wins) before summing.
 *
 * Field spellings are probed in both camelCase and snake_case. That is deliberate
 * hedging, not indecision: the CLI ships two engine generations with duplicated
 * logging paths, and the older `kimi-cli` used the snake_case spelling. Accepting
 * both costs nothing and avoids a silent $0 on an upstream version bump.
 *
 * Returns null when the log carries no usable record — the caller then records $0,
 * failing low rather than inventing a number.
 */
export function extractKimiUsageFromSessionLog(
	contents: string,
	price: PriceModelFn = NO_PRICE,
): AgentRunUsage | null {
	interface Rec {
		input: number;
		output: number;
		cacheRead: number;
		cacheCreation: number;
		model?: string;
		sessionScoped: boolean;
	}
	const byId = new Map<string, Rec>();
	let counter = 0;

	for (const line of contents.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		const record = parsed as Record<string, unknown>;

		// The buckets live under `usage` (Kimi Code) or `token_usage` (older
		// kimi-cli). Anything without one of those is not a usage record.
		const rawUsage = (record.usage ?? record.token_usage) as unknown;
		if (!rawUsage || typeof rawUsage !== 'object') continue;
		const usage = rawUsage as Record<string, unknown>;

		const input = pickNumber(usage, KIMI_INPUT_KEYS);
		const output = pickNumber(usage, KIMI_OUTPUT_KEYS);
		const cacheRead = pickNumber(usage, KIMI_CACHE_READ_KEYS);
		const cacheCreation = pickNumber(usage, KIMI_CACHE_CREATION_KEYS);
		// Require at least one recognised bucket, so an unrelated object that
		// happens to carry a `usage` key can't contribute a phantom zero record.
		if (input === null && output === null && cacheRead === null && cacheCreation === null) {
			continue;
		}

		const scope = pickString(record, KIMI_SCOPE_KEYS) ?? pickString(usage, KIMI_SCOPE_KEYS) ?? '';
		const id = pickString(record, KIMI_RECORD_ID_KEYS) ?? `#${counter++}`;
		byId.set(id, {
			input: input ?? 0,
			output: output ?? 0,
			cacheRead: cacheRead ?? 0,
			cacheCreation: cacheCreation ?? 0,
			model: pickString(record, KIMI_MODEL_KEYS) ?? pickString(usage, KIMI_MODEL_KEYS),
			sessionScoped: scope.toLowerCase().includes('session'),
		});
	}
	if (byId.size === 0) return null;

	const all = [...byId.values()];
	const turnScoped = all.filter((r) => !r.sessionScoped);
	// Prefer per-turn records; fall back to the LAST cumulative total, never the
	// sum of cumulative totals.
	const counted = turnScoped.length > 0 ? turnScoped : all.slice(-1);

	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheCreation = 0;
	let model: string | undefined;
	for (const r of counted) {
		input += r.input;
		output += r.output;
		cacheRead += r.cacheRead;
		cacheCreation += r.cacheCreation;
		if (r.model) model = r.model;
	}

	// `inputOther` is the non-cached remainder ("other" than cache), so unlike
	// Codex/Grok it must NOT have the cached portion subtracted out — each bucket
	// is billed at its own rate directly.
	const costCents = price(model, {
		inputTokens: input,
		cacheReadTokens: cacheRead,
		cacheCreationTokens: cacheCreation,
		outputTokens: output,
	});
	return {
		inputTokens: input + cacheRead + cacheCreation,
		outputTokens: output,
		costCents,
	};
}

// ---------------------------------------------------------------------------
// Shared rendering helpers
//
// Content (thinking, tool args, tool results, errors) is preserved in full and
// never truncated; the whole run log is recorded, with only the overall byte cap
// in `log-stream-broker.ts` as a runaway-output backstop.
//
// The persisted log is line-based — each physical line is one event — so tool args
// and tool results collapse all whitespace (newlines included) to a single space;
// an embedded newline there would be mis-parsed as a separate line by the client
// parser (`parse-agent-log.ts`). Thinking is the exception: to keep long reasoning
// readable it KEEPS the model's own line breaks, emitting one `[thinking]`-prefixed
// line per physical line (a blank line becomes a bare `[thinking]`, since
// `splitLogLines` drops empty lines and the prefix keeps them alive). The client
// parser coalesces that consecutive run back into one block, exactly as it already
// does for `[system]` lines. Only horizontal whitespace is collapsed.
// ---------------------------------------------------------------------------

function normalizeContent(content: ClaudeMessage['content']): ClaudeContentBlock[] {
	if (typeof content === 'string') return [{ type: 'text', text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

function formatThinking(text: string): string {
	const normalized = text
		.replace(/\r\n?/g, '\n') // CRLF / lone CR → LF
		.replace(/[^\S\n]+/g, ' ') // collapse spaces/tabs but keep newlines
		.replace(/ *\n */g, '\n') // drop spaces hugging a line break
		.replace(/\n{3,}/g, '\n\n') // cap blank runs at a single blank line
		.trim();
	if (normalized === '') return '[thinking]';
	// One `[thinking]`-prefixed line per physical line (blank lines included) so the
	// model's paragraph/list structure survives the line-based log; the client parser
	// coalesces the consecutive run back into a single block.
	return normalized
		.split('\n')
		.map((line) => (line === '' ? '[thinking]' : `[thinking] ${line}`))
		.join('\n');
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
	return entries.map(([k, v]) => `${k}=${stringifyArg(v)}`).join(', ');
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
	return `${label} ${collapsed}`;
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
