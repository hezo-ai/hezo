import { z } from 'zod';
import { toSlug } from '../lib/slug';
import registryData from './connector-registry.json';

/**
 * Curated connector registry: a bundled, hand-authored JSON of connection
 * patterns, per-service recipes, and OAuth providers. It is the source of the
 * virtual `connector-recipes` skill agents consult before wiring up an external
 * service, so they reach for a hosted MCP or a direct `api` connector (secrets
 * stay `__HEZO_SECRET_*__` placeholders) instead of a desktop-model integration
 * that would need an interactive browser flow or write a token file to disk.
 *
 * The JSON is a *static* asset checked into the repo (not a generated bundle),
 * so a plain `import` inlines it under tsc (resolveJsonModule) and embeds it in
 * the compiled binary via `bun build --compile`.
 */

// The reserved slug for the virtual skill. It is NOT a DB row — every skill
// surface special-cases this slug (manifest, get_skill, the read-only view) and
// rejects creating/editing/deleting it.
export const CONNECTOR_RECIPES_SLUG = 'connector-recipes';

// Credential kinds mirror @hezo/shared CredentialKind so the registry can only
// name a kind the vault actually understands.
const credentialKindSchema = z.enum([
	'api_key',
	'oauth_token',
	'github_pat',
	'webhook_secret',
	'ssh_private_key',
	'other',
]);

const patternSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	description: z.string().min(1),
});

const credentialSchema = z.object({
	name: z.string().min(1),
	kind: credentialKindSchema,
	allowed_hosts: z.array(z.string()),
});

const serviceRecipeSchema = z.object({
	service: z.string().min(1),
	category: z.string().min(1),
	transport: z.enum(['mcp', 'api']),
	endpoint: z.string(),
	credentials: z.array(credentialSchema),
	docs_url: z.string().optional(),
	notes: z.string().optional(),
});

const oauthProviderSchema = z.object({
	id: z.string().min(1),
	authorize_url: z.string().optional(),
	device_code_url: z.string().optional(),
	token_url: z.string().min(1),
	scopes: z.array(z.string()),
	client_type: z.string().optional(),
	allowed_hosts: z.array(z.string()),
});

const connectorRegistrySchema = z.object({
	patterns: z.array(patternSchema).min(1),
	services: z.array(serviceRecipeSchema).min(1),
	oauthProviders: z.array(oauthProviderSchema).min(1),
});

export type Pattern = z.infer<typeof patternSchema>;
export type ServiceRecipe = z.infer<typeof serviceRecipeSchema>;
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;
export type ConnectorRegistry = z.infer<typeof connectorRegistrySchema>;

export interface VirtualSkill {
	slug: string;
	name: string;
	description: string;
	content: string;
}

let cached: ConnectorRegistry | null = null;

/**
 * The single accessor for the connector registry. Every consumer MUST go
 * through here — this is the seam where a future GitHub-refresh override would
 * slot in (e.g. a DB-stored fetched registry that supersedes the bundled JSON),
 * without touching any caller. Validates with zod and throws on a malformed
 * registry so a bad edit fails loudly at load rather than silently degrading a
 * run's manifest.
 */
export function resolveConnectorRegistry(): ConnectorRegistry {
	if (cached) return cached;
	cached = connectorRegistrySchema.parse(registryData);
	return cached;
}

/** True when a proposed skill slug/name would collide with the reserved virtual skill. */
export function isConnectorRecipesSlug(slug: string | null | undefined): boolean {
	return toSlug(String(slug ?? '')) === CONNECTOR_RECIPES_SLUG;
}

/**
 * Build the virtual `connector-recipes` skill from the registry: a positive,
 * MCP-or-API-first guide (no blocklist). Rendered as markdown — a patterns
 * section, a compact per-service table, then a block per OAuth provider.
 */
export function buildConnectorRecipesSkill(
	registry: ConnectorRegistry = resolveConnectorRegistry(),
): VirtualSkill {
	const lines: string[] = [];

	lines.push('# Connecting external services — recipes');
	lines.push('');
	lines.push(
		"Consult this before connecting an external service or requesting a credential. Prefer, in order: (1) a hosted MCP server via register_connector, (2) a direct REST API via an `api` connector, before anything else. Both keep every secret as a `__HEZO_SECRET_<NAME>__` placeholder that the egress proxy substitutes at request time, scoped to allowed_hosts — the raw value never enters the run. Avoid any integration that would need an interactive browser/localhost OAuth callback in the run or write a credential/token file to disk; use a host-side flow (device flow or host-completed auth-code) instead. Once connected and you can drive the service, persist what you learned as a skill via create_skill — scoped to match the connector's reach — and update the same skill as you learn more, so teammates never re-derive the integration.",
	);
	lines.push('');

	lines.push('## Connection patterns');
	lines.push('');
	for (const p of registry.patterns) {
		lines.push(`### ${p.title} (${p.id})`);
		lines.push('');
		lines.push(p.description);
		lines.push('');
	}

	lines.push('## Service recipes');
	lines.push('');
	lines.push(
		'| Service | Category | Transport | Endpoint | Credential (kind) | allowed_hosts | Docs |',
	);
	lines.push('| --- | --- | --- | --- | --- | --- | --- |');
	for (const s of registry.services) {
		const cred = s.credentials.map((c) => `${c.name} (${c.kind})`).join('; ');
		const hosts = s.credentials.flatMap((c) => c.allowed_hosts).join(', ');
		const docs = s.docs_url ? s.docs_url : '';
		lines.push(
			`| ${s.service} | ${s.category} | ${s.transport} | ${s.endpoint} | ${cred || '—'} | ${hosts || '—'} | ${docs} |`,
		);
	}
	lines.push('');
	// Per-service notes carry the pattern to follow for the tricky ones.
	const withNotes = registry.services.filter((s) => s.notes);
	if (withNotes.length > 0) {
		lines.push('### Service notes');
		lines.push('');
		for (const s of withNotes) {
			lines.push(`- **${s.service}**: ${s.notes}`);
		}
		lines.push('');
	}

	lines.push('## Discovering a server URL and skill file');
	lines.push('');
	lines.push(
		'- Most providers publish their MCP server URL on a docs page (e.g. `https://www.<vendor>.com/docs/mcp-server` or `https://docs.<vendor>.com/mcp`). Given a vendor name without a URL, `WebSearch` for `"<vendor> MCP server"` or fetch their docs page directly.',
	);
	lines.push(
		'- An "agent skill file" is markdown a vendor publishes describing how to use their MCP. Try in order: the vendor\'s docs page (often the skill file content IS the docs page); common GitHub paths like `https://raw.githubusercontent.com/<vendor>/mcp-server/{main,master}/{AGENTS,SKILL,README}.md`; then the server\'s own `tools/list` once the connector is active.',
	);
	lines.push(
		"- `fetch_skill_file` is not mandatory. If you cannot find one, register the connector anyway: the MCP server's `tools/list` is the authoritative source of what tools exist, and once auth completes those tools appear as `mcp__<connector_name>__<tool>`.",
	);
	lines.push('');

	lines.push('## Connector status');
	lines.push('');
	lines.push(
		'After `register_connector`, or on any `list_connectors` row, the field that tells you whether the MCP is **usable** is `oauth_status`. Not `install_status`, which tracks local-package install for stdio MCPs and is meaningless for SaaS.',
	);
	lines.push('');
	lines.push('| `oauth_status` | Meaning | What to do |');
	lines.push('| --- | --- | --- |');
	lines.push(
		'| `active` | Connected, or a public server Hezo probed and found answering with no credential; tools appear as `mcp__<connector_name>__<tool>` | Use them. Active but no tools at all is a bug worth flagging, not a reason to re-ask the human to connect |',
	);
	lines.push(
		'| `pending` | Not reaching runs yet: the human has not clicked Connect, or no probe has yet found the server answering without a credential | Do not repost the ask; the connect_required comment is still live |',
	);
	lines.push('| `failed` | An attempt errored | Read `auth_error` and surface it to the human |');
	lines.push(
		'| `degraded` | It worked and has stopped; the stored token no longer refreshes | Not fixable from inside the run. Escalate, then carry on with what the task can still achieve |',
	);
	lines.push('| `revoked` | A human explicitly disconnected | Do not auto-reconnect; ask first |');
	lines.push(
		'| `none` | Not a hosted MCP server at all: a local stdio server, or an `api` REST connector | Nothing to connect. For `api`, read the `api_auth` block instead |',
	);
	lines.push('');
	lines.push(
		'- **A hosted server carrying no credential reaches runs only while Hezo can reach it.** `probed_at` is when it was last checked and `probe_error` is why that check failed (`auth_required`, `unreachable`), or null when it answered. A server that starts demanding auth drops out of runs at the next check rather than failing inside one. A connector whose auth is a `__HEZO_SECRET_<NAME>__` header is exempt: the egress proxy substitutes it at request time, which no server-side check can reproduce.',
	);
	lines.push(
		"- **Before reporting that a connector's tools are missing, check `tools_this_run` on its `list_connectors` row.** It measures *your own run* - how many of that connector's tools the runtime handed you - rather than guessing. A non-zero count means they are present, so search your tool list again under the `mcp__<connector_name>__<tool>` naming, which is not always what the vendor's docs call them. `0` means it connected and contributed nothing callable, a real fault worth escalating. `null` means nothing measured it.",
	);
	lines.push(
		'- **Never assert a connector is broken without reading `tools_this_run` or calling `test_connector` first.** An unverified claim, once written into a progress summary, gets repeated by later runs as established fact and the team works around a problem that was never there.',
	);
	lines.push(
		'- If the tools are missing while `oauth_status` is `active`, call `test_connector(connector_id)`. It resolves the stored token server-side and pings the MCP URL directly, bypassing the container, and tells you whether the token is still valid against the provider or the fault is in the container/proxy chain.',
	);
	lines.push('');

	lines.push('## Record the service as a skill once the connector works');
	lines.push('');
	lines.push(
		'- **Getting a connector working earns knowledge the whole team needs.** Once you can drive the service - auth pattern, base URL or MCP tools, the endpoints that matter, pagination, rate limits, quirks, queries that returned real data - record it with `create_skill`, and update that same slug and scope whenever a later run teaches you more.',
	);
	lines.push(
		'- **Check for an existing public skill first.** Run the finding-new-skills flow for the service (`npx skills find "<service>"`, plus the vendor skill-file discovery above). If a good public skill exists, persist it into the catalog rather than writing a duplicate.',
	);
	lines.push(
		"- **Match the skill's scope to the connector's reach.** A connector shared with every project gets a `global` skill; a project-scoped connector gets a `project` skill. Connectors you register yourself are project-scoped, so default to `project`.",
	);
	lines.push(
		'- **Layer project specifics; do not fork the general skill.** When a persisted skill already covers the service, capture what is specific to this project as a separate project-scoped skill that references the general one by slug.',
	);
	lines.push('');

	lines.push('## OAuth providers');
	lines.push('');
	for (const o of registry.oauthProviders) {
		lines.push(`### ${o.id}`);
		lines.push('');
		if (o.client_type) lines.push(`- Client type: ${o.client_type}`);
		if (o.authorize_url) lines.push(`- Authorize URL: ${o.authorize_url}`);
		if (o.device_code_url) lines.push(`- Device code URL: ${o.device_code_url}`);
		lines.push(`- Token URL: ${o.token_url}`);
		lines.push(`- Scopes: ${o.scopes.join(', ') || '—'}`);
		lines.push(`- allowed_hosts: ${o.allowed_hosts.join(', ') || '—'}`);
		lines.push('');
	}

	return {
		slug: CONNECTOR_RECIPES_SLUG,
		name: 'Connector Recipes',
		description:
			'MCP-or-API-first recipes for connecting external services and requesting credentials without leaking secrets into a run.',
		content: lines.join('\n').trim(),
	};
}
