/**
 * The enforcement leg of per-connector MCP method access.
 *
 * A disabled method is also hidden from `hezo-mcp search`, so an agent never sees
 * one it cannot call — but that is advisory. The CLI is written into the
 * container and an agent has a shell, so nothing there can be a boundary. The
 * restriction is therefore enforced here, on the way out of the container, where
 * it holds regardless of what made the call.
 *
 * This is the sole enforcement point since connectors left the runtimes' MCP
 * config. It used to share the job with per-adapter `includeTools` /
 * `permissions.deny` keys, which covered only the three runtimes that have such
 * a key at all.
 *
 * This module is the decision alone — no I/O, no proxy state — so the rules can
 * be tested directly.
 */

/** A JSON-RPC method name that carries a tool invocation. */
const TOOLS_CALL = 'tools/call';

export type McpGuardVerdict =
	| { blocked: false }
	| { blocked: true; method: string; reason: 'not_enabled' }
	| { blocked: true; method: null; reason: 'unparseable' };

/**
 * Decide whether a request body to a restricted MCP host may be forwarded.
 *
 * Only `tools/call` is inspected. Everything else in the protocol — `initialize`,
 * `tools/list`, `ping`, notifications, responses — passes through: the guard's
 * job is to stop a *call* to a withheld tool, not to police the transport. A
 * `tools/list` that still advertises a disabled tool is harmless precisely
 * because the call it would enable is blocked here.
 *
 * **Fails closed.** A body that cannot be parsed as JSON-RPC is blocked rather
 * than forwarded. This is only ever reached for a host whose connector carries
 * an allowlist, so the blast radius is one restricted connector — and forwarding
 * something we could not read would make the allowlist advisory.
 */
export function shouldBlockMcpRequest(
	bodyText: string,
	enabled: ReadonlySet<string>,
): McpGuardVerdict {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return { blocked: true, method: null, reason: 'unparseable' };
	}

	// JSON-RPC permits a batch: an array of messages in one body. One disabled
	// call in the batch rejects the whole request — the messages share a body, so
	// there is no way to forward the rest without also forwarding that one.
	const messages = Array.isArray(parsed) ? parsed : [parsed];
	if (messages.length === 0) return { blocked: false };

	for (const message of messages) {
		if (!isRecord(message)) return { blocked: true, method: null, reason: 'unparseable' };
		if (message.method !== TOOLS_CALL) continue;

		const params = message.params;
		// A tools/call whose tool name we cannot read is not forwardable: we would
		// be letting through precisely the message shape the guard exists to check.
		if (!isRecord(params) || typeof params.name !== 'string') {
			return { blocked: true, method: null, reason: 'unparseable' };
		}
		if (!enabled.has(params.name)) {
			return { blocked: true, method: params.name, reason: 'not_enabled' };
		}
	}

	return { blocked: false };
}

/**
 * The error an agent sees when it calls a withheld method.
 *
 * Named and explicit on purpose: "this tool exists but is disabled for this
 * connector" is actionable (ask the operator, or use a read-only equivalent),
 * whereas a bare 403 reads as a broken credential and invites a retry loop.
 */
export function mcpMethodBlockedMessage(
	verdict: Extract<McpGuardVerdict, { blocked: true }>,
	connectorName: string,
): string {
	if (verdict.reason === 'unparseable') {
		return (
			`Blocked by Hezo: this request to the "${connectorName}" MCP server could not be ` +
			`inspected, and that server has a restricted method allowlist. Send one JSON-RPC ` +
			`message (or a batch) as an uncompressed application/json body with a Content-Length.`
		);
	}
	return (
		`Blocked by Hezo: the "${verdict.method}" method is not enabled for the ` +
		`"${connectorName}" connector. An operator chose which of this server's methods ` +
		`agents may call; ask them to enable it from the connector's Settings if you need it.`
	);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}
