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
		'Consult this before connecting an external service or requesting a credential. Prefer, in order: (1) a hosted MCP server via register_connector, (2) a direct REST API via an `api` connector, before anything else. Both keep every secret as a `__HEZO_SECRET_<NAME>__` placeholder that the egress proxy substitutes at request time, scoped to allowed_hosts — the raw value never enters the run. Avoid any integration that would need an interactive browser/localhost OAuth callback in the run or write a credential/token file to disk; use a host-side flow (device flow or host-completed auth-code) instead.',
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
