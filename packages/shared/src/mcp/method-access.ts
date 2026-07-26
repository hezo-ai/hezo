/**
 * Read-only vs write classification for the methods (tools) a remote MCP server
 * advertises, and the counting used everywhere a method allowlist is displayed.
 *
 * A connector's allowlist is stored as `mcp_connections.enabled_methods`, where
 * **null means "no allowlist" — every method is enabled**. That distinction is
 * load-bearing: a connector left unrestricted picks up methods the server adds
 * later, whereas a restricted one treats an unknown new method as disabled until
 * an operator enables it. Nothing here ever substitutes "all the names we happen
 * to know right now" for null.
 *
 * Both the server (discovery, the egress-proxy guard, `list_connectors`) and the
 * web (the card summary and the methods dialog) classify and count, so it lives
 * in `@hezo/shared` and there is exactly one implementation of each rule.
 */

/** The shape of one entry in an MCP `tools/list` response that we care about. */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	/**
	 * Tool behaviour hints from the MCP spec. `readOnlyHint` is the server's own
	 * declaration that a tool does not modify its environment; when present it is
	 * authoritative and the name heuristic is not consulted.
	 */
	annotations?: {
		readOnlyHint?: boolean;
	};
}

/** A classified method, as cached on the connector and rendered in the dialog. */
export interface McpMethodInfo {
	name: string;
	description?: string;
	/** True when this method only reads. Drives which category it lands in. */
	readOnly: boolean;
	/**
	 * True when `readOnly` came from the name heuristic rather than the server's
	 * own `readOnlyHint`. Surfaced in the UI so an operator can tell a guess from
	 * a declaration before trusting it with a security decision.
	 */
	inferred: boolean;
}

/**
 * Name prefixes that mark a method as read-only when the server declares no
 * `readOnlyHint`. Deliberately a prefix allowlist rather than a
 * "does it look mutating?" denylist: an unrecognised name falls through to
 * *write*, so the heuristic can only ever be too strict, never too permissive.
 * Being wrong in the strict direction costs an operator one checkbox; being
 * wrong the other way silently hands an agent a delete.
 */
const READ_ONLY_PREFIXES = [
	'get',
	'list',
	'search',
	'read',
	'fetch',
	'find',
	'query',
	'describe',
	'view',
	'show',
	'count',
	'check',
	'inspect',
	'preview',
	'export',
	'download',
];

/**
 * Split a method name into lowercase words so one prefix table covers every
 * casing convention in the wild: `list_issues`, `listIssues`, `list-issues`,
 * `ListIssues` all yield `['list', 'issues']`.
 */
function leadingWord(name: string): string {
	const spaced = name
		.replace(/[_\-.\s]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim();
	const first = spaced.split(' ')[0] ?? '';
	return first.toLowerCase();
}

/**
 * Classify one advertised tool. The server's `readOnlyHint` wins whenever it is
 * set (either way); otherwise the leading word decides and `inferred` is set.
 */
export function classifyMcpMethod(tool: McpToolDescriptor): McpMethodInfo {
	const declared = tool.annotations?.readOnlyHint;
	if (typeof declared === 'boolean') {
		return {
			name: tool.name,
			...(tool.description ? { description: tool.description } : {}),
			readOnly: declared,
			inferred: false,
		};
	}
	return {
		name: tool.name,
		...(tool.description ? { description: tool.description } : {}),
		readOnly: READ_ONLY_PREFIXES.includes(leadingWord(tool.name)),
		inferred: true,
	};
}

/** Classify a whole `tools/list` payload, preserving the server's ordering. */
export function classifyMcpMethods(tools: readonly McpToolDescriptor[]): McpMethodInfo[] {
	return tools.map(classifyMcpMethod);
}

/** Whether a connector restricts its methods at all. */
export type MethodAccessMode = 'all' | 'restricted';

export interface MethodAccessSummary {
	mode: MethodAccessMode;
	total: number;
	enabled: number;
	readOnlyTotal: number;
	readOnlyEnabled: number;
	writeTotal: number;
	writeEnabled: number;
	/** Enabled methods that write. Zero on a catalog-backed read-only connector. */
	writeDisabled: number;
}

/**
 * The single source of truth for every method count shown anywhere — the card
 * badge, the dialog's category headers, and the `method_access` block
 * `list_connectors` returns to agents. Computed in one place so those three can
 * never disagree.
 *
 * `enabled` of `null` means no allowlist, i.e. every catalogued method is on.
 */
export function summarizeMethodAccess(
	catalog: readonly McpMethodInfo[],
	enabled: readonly string[] | null,
): MethodAccessSummary {
	const allowed = enabled === null ? null : new Set(enabled);
	const isOn = (m: McpMethodInfo) => allowed === null || allowed.has(m.name);

	const readOnly = catalog.filter((m) => m.readOnly);
	const write = catalog.filter((m) => !m.readOnly);
	const readOnlyEnabled = readOnly.filter(isOn).length;
	const writeEnabled = write.filter(isOn).length;

	return {
		mode: enabled === null ? 'all' : 'restricted',
		total: catalog.length,
		enabled: readOnlyEnabled + writeEnabled,
		readOnlyTotal: readOnly.length,
		readOnlyEnabled,
		writeTotal: write.length,
		writeEnabled,
		writeDisabled: write.length - writeEnabled,
	};
}

/**
 * The allowlist an agent's `access: 'read'` request resolves to: every read-only
 * method in the catalog. Applied once, when the connector's methods are first
 * listed after it activates.
 */
export function readOnlyMethodNames(catalog: readonly McpMethodInfo[]): string[] {
	return catalog.filter((m) => m.readOnly).map((m) => m.name);
}

/**
 * Whether a connector is restricted to reading only — every catalogued write
 * method disabled, and at least one write method existing to disable. Drives the
 * "Read-only" badge on the card; a connector with no write methods at all is not
 * meaningfully "read-only", it is just unrestricted.
 */
export function isReadOnlyRestricted(
	catalog: readonly McpMethodInfo[],
	enabled: readonly string[] | null,
): boolean {
	if (enabled === null) return false;
	const s = summarizeMethodAccess(catalog, enabled);
	return s.writeTotal > 0 && s.writeEnabled === 0;
}
