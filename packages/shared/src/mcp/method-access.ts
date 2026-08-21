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
/**
 * A git repo that authenticates through the same OAuth connection as a
 * connector. Projected by the server onto connector and oauth-connection rows,
 * rendered by the web confirmation dialogs, and returned to agents by
 * `list_connectors` - one shape so the three cannot drift.
 *
 * Its presence is what makes removing a connector consequential: git reads
 * `repos.oauth_connection_id` and keeps working, while every MCP tool the
 * connector carried disappears from the next run with nothing recording it.
 */
export interface LinkedRepo {
	id: string;
	repo_identifier: string;
	project_id: string;
	project_name: string;
}

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
function splitWords(name: string): string[] {
	return name
		.replace(/[_\-.\s]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim()
		.split(' ')
		.filter(Boolean)
		.map((word) => word.toLowerCase());
}

/**
 * Verbs that mark a shared token as the tool's own action rather than a vendor
 * name. The mirror of the read-prefix refusal in {@link sharedVendorPrefix}.
 *
 * Load-bearing once a single tool can imply a namespace: with one tool there is
 * nothing to cross-check the token against, so `update_view` would strip
 * `update` and classify on `view` - a read prefix - marking a write tool
 * read-only. That is the one direction this module promises never to fail in,
 * so a token that is plainly a mutation is refused instead. A vendor genuinely
 * called `post` or `run` loses its namespace and classifies as write, which is
 * the safe way round.
 */
const WRITE_VERB_PREFIXES = [
	'create',
	'update',
	'delete',
	'remove',
	'set',
	'add',
	'put',
	'patch',
	'post',
	'write',
	'send',
	'reset',
	'clear',
	'drop',
	'insert',
	'upsert',
	'move',
	'rename',
	'archive',
	'publish',
	'cancel',
	'run',
	'execute',
	'start',
	'stop',
];

/**
 * The vendor namespace every tool in a catalog is prefixed with, or null when
 * there is no such prefix.
 *
 * Many servers name every tool after themselves - `typefully_list_drafts`,
 * `typefully_get_me` - which puts the vendor where the verb should be and makes
 * the prefix table classify the whole server as write. Detecting the shared
 * token here lets classification look at the word that actually carries the
 * verb.
 *
 * Deliberately conservative. It requires **every** tool to share the token (a
 * partial match is a coincidence, not a namespace), and refuses a token that is
 * itself a read-only prefix - a server whose tools are all `list_*` is naming
 * them consistently, and stripping that would discard the only signal the
 * heuristic has - or a plain mutation verb, per {@link WRITE_VERB_PREFIXES}.
 *
 * A single tool can imply a namespace. The whole-catalog view is weaker evidence
 * at one tool than at ten, which is what the two refusals above are carrying:
 * they reject the tokens where a one-tool guess would go wrong, and a vendor
 * name is not among them.
 */
function sharedVendorPrefix(tools: readonly McpToolDescriptor[]): string | null {
	if (tools.length === 0) return null;
	let shared: string | null = null;
	for (const tool of tools) {
		const words = splitWords(tool.name);
		// A single-word name has no room for a namespace plus a verb, so the
		// catalog as a whole is not namespaced.
		if (words.length < 2) return null;
		const first = words[0] ?? '';
		if (shared === null) shared = first;
		else if (shared !== first) return null;
	}
	if (shared === null) return null;
	if (READ_ONLY_PREFIXES.includes(shared)) return null;
	if (WRITE_VERB_PREFIXES.includes(shared)) return null;
	return shared;
}

/**
 * Classify one advertised tool. The server's `readOnlyHint` wins whenever it is
 * set (either way); otherwise the leading word decides and `inferred` is set.
 *
 * `namespace`, when given, is a vendor prefix shared across the whole catalog
 * (see {@link sharedVendorPrefix}); the word after it is what gets tested.
 * Callers holding one tool omit it and get the historic behaviour.
 */
export function classifyMcpMethod(
	tool: McpToolDescriptor,
	namespace?: string | null,
): McpMethodInfo {
	const declared = tool.annotations?.readOnlyHint;
	if (typeof declared === 'boolean') {
		return {
			name: tool.name,
			...(tool.description ? { description: tool.description } : {}),
			readOnly: declared,
			inferred: false,
		};
	}
	const words = splitWords(tool.name);
	const verb = (namespace && words[0] === namespace ? words[1] : words[0]) ?? '';
	return {
		name: tool.name,
		...(tool.description ? { description: tool.description } : {}),
		readOnly: READ_ONLY_PREFIXES.includes(verb),
		inferred: true,
	};
}

/** Classify a whole `tools/list` payload, preserving the server's ordering. */
export function classifyMcpMethods(tools: readonly McpToolDescriptor[]): McpMethodInfo[] {
	const namespace = sharedVendorPrefix(tools);
	return tools.map((tool) => classifyMcpMethod(tool, namespace));
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
