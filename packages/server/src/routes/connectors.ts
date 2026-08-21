import {
	ConnectorTransport,
	getConnectorCapability,
	type McpMethodInfo,
	summarizeMethodAccess,
} from '@hezo/shared';
import { Hono } from 'hono';
import { encrypt } from '../crypto/encryption';
import { trackBackground } from '../lib/background';
import { broadcastConnectorChange } from '../lib/broadcast';
import { validateSecretName } from '../lib/credential-placeholder';
import { buildMeta, parsePagination } from '../lib/pagination';
import { resolveActor } from '../lib/resolve';
import { err, ok } from '../lib/response';
import { isUniqueViolation, withTransaction } from '../lib/sql';
import type { Env } from '../lib/types';
import { logger } from '../logger';
import { requireAdminEquivalent } from '../middleware/auth';
import { resolveConnectorRegistry } from '../services/connector-registry';
import { validateApiConnectorConfig } from '../services/connectors/connections';
import {
	createOrFetchConnector,
	deleteConnector,
	fireCredentialProvidedWakeup,
	markApiKeyActive,
} from '../services/connectors/lifecycle';
import type {
	ConnectorProbeVerdict,
	MethodDiscoveryDeps,
	MethodDiscoveryResult,
} from '../services/connectors/method-discovery';
import { invalidateSecretsVault } from '../services/egress';
import { installLocalMcpById } from '../services/mcp-installer';

const log = logger.child('connectors-route');

// Connectors are scoped by project_id (NULL = global "all projects" scope). The
// project-scoped routes below read/write that project's own connectors plus
// global ones; the un-prefixed routes are the Admin (superuser) surface for
// `/settings/connectors`, which spans every project.
const CONNECTOR_COLUMNS = `id, name, display_name, kind::text AS kind,
        config, oauth_connection_id, api_key_secret_id, project_id, install_status::text AS install_status, install_error,
        skill_id, created_by_task_id, activated_at, revoked_at, auth_error,
        probed_at, probe_error::text AS probe_error,
        enabled_methods, discovered_methods, methods_listed_at,
        requested_access::text AS requested_access,
        created_at, updated_at`;

// Same columns, `mc.`-qualified for queries that JOIN `projects` (whose id/name/
// slug would otherwise collide with the connector's).
const CONNECTOR_COLUMNS_MC = `mc.id, mc.name, mc.display_name, mc.kind::text AS kind,
        mc.config, mc.oauth_connection_id, mc.api_key_secret_id, mc.project_id, mc.install_status::text AS install_status,
        mc.install_error, mc.skill_id, mc.created_by_task_id, mc.activated_at, mc.revoked_at,
        mc.auth_error, mc.probed_at, mc.probe_error::text AS probe_error,
        mc.enabled_methods, mc.discovered_methods, mc.methods_listed_at,
        mc.requested_access::text AS requested_access,
        mc.created_at, mc.updated_at`;

// The credential(s) a connector uses, as a JSON array — its pasted API-key secret
// or the access token of its linked OAuth connection (relation R, symmetric with
// the `connectors` array on GET /credentials). Correlated on the connector row
// aliased `<alias>`; returns `[]` for a connector with no connector-managed auth.
const connectorCredentialsJson = (alias: string): string =>
	`COALESCE((
		SELECT json_agg(json_build_object('id', cs.id, 'name', cs.name) ORDER BY cs.name)
		FROM secrets cs
		WHERE cs.id = ${alias}.api_key_secret_id
		   OR cs.id = (SELECT oc2.access_token_secret_id FROM oauth_connections oc2
		               WHERE oc2.id = ${alias}.oauth_connection_id)
	), '[]'::json) AS credentials`;

// The repos that authenticate through the same OAuth connection as a connector,
// as a JSON array. Deleting the connector leaves these working - git reads
// `repos.oauth_connection_id`, which survives - but strips the connector's MCP
// tools from every subsequent run, and nothing in the run log records which
// connectors a run received. The confirmation dialogs read this so a human is
// told that before the fact rather than discovering it from an agent's wrong
// guess. Correlated on the connector row aliased `<alias>`; `[]` when the
// connector carries no OAuth connection (`NULL = NULL` is not true, so the
// comparison is null-safe on its own).
//
// Deliberately not PROJECT-filtered. A connection can back repos in more than
// one project - migration `018_scope_connections_per_project.sql` leaves exactly
// those global - so scoping this to the caller's project would under-report the
// case with the widest blast radius. (It is not true in reverse: a global
// connection may equally back one project's repos, or none. `repos.ts` accepts a
// global connection for a single project's repo, and the Git page offers it.)
//
// It IS team-filtered, and that is not the same thing. A global connector is
// visible from every project on the instance, including other teams', so an
// unfiltered aggregate handed a project member the repo identifiers and project
// names of teams they cannot otherwise reach - `requireProjectAccessMiddleware`
// answers 403 for those same projects. `teamParam` is the `$N` carrying the
// caller's team, or null for the admin surface (`requireAdminEquivalent`), which
// manages every team's connectors and is meant to see them all. Required rather
// than optional so a new call site has to say which it is.
const connectorLinkedReposJson = (alias: string, teamParam: string | null): string =>
	`COALESCE((
		SELECT json_agg(json_build_object(
			'id', lr.id, 'repo_identifier', lr.repo_identifier,
			'project_id', lr.project_id, 'project_name', lp.name
		) ORDER BY lp.name, lr.repo_identifier)
		FROM repos lr
		JOIN projects lp ON lp.id = lr.project_id
		WHERE lr.oauth_connection_id = ${alias}.oauth_connection_id
		${teamParam ? `AND lp.team_id = ${teamParam}` : ''}
	), '[]'::json) AS linked_repos`;

export const connectorsRoutes = new Hono<Env>();

/** The method-access view of a connector, as both method routes return it. */
interface ConnectorMethodsView {
	connector_id: string;
	kind: string;
	/** The cached `tools/list` catalog, `[]` when never listed. */
	methods: McpMethodInfo[];
	/** Allowlist, or `null` for unrestricted — the distinction is meaningful. */
	enabled_methods: string[] | null;
	methods_listed_at: string | null;
	requested_access: string | null;
	summary: ReturnType<typeof summarizeMethodAccess>;
}

/**
 * Load a connector's method catalog + allowlist.
 *
 * `projectId` scopes the lookup to what that project can see (its own connectors
 * plus globals). Pass `null` for the **admin** surface, which lists connectors
 * across every project and so must not be scoped — the caller is responsible for
 * having enforced `requireAdminEquivalent` first.
 */
async function loadConnectorMethods(
	db: Env['Variables']['db'],
	connectorId: string,
	projectId: string | null,
): Promise<ConnectorMethodsView | null> {
	const result = await db.query<{
		id: string;
		kind: string;
		discovered_methods: McpMethodInfo[] | null;
		enabled_methods: string[] | null;
		methods_listed_at: string | null;
		requested_access: string | null;
	}>(
		`SELECT id, kind::text AS kind, discovered_methods, enabled_methods,
		        methods_listed_at::text AS methods_listed_at,
		        requested_access::text AS requested_access
		 FROM mcp_connections
		 WHERE id = $1 ${projectId === null ? '' : 'AND (project_id = $2 OR project_id IS NULL)'}`,
		projectId === null ? [connectorId] : [connectorId, projectId],
	);
	const row = result.rows[0];
	if (!row) return null;
	const methods = row.discovered_methods ?? [];
	return {
		connector_id: row.id,
		kind: row.kind,
		methods,
		enabled_methods: row.enabled_methods,
		methods_listed_at: row.methods_listed_at,
		requested_access: row.requested_access,
		summary: summarizeMethodAccess(methods, row.enabled_methods),
	};
}

/**
 * Validate a PATCH body. `enabled_methods: null` resets to unrestricted, which
 * is why the field must be present-and-null rather than merely absent — an
 * omitted field would make "reset" indistinguishable from a malformed body.
 */
function parseEnabledMethods(body: unknown): { enabled: string[] | null } | { error: string } {
	if (!body || typeof body !== 'object' || !('enabled_methods' in body)) {
		return { error: 'enabled_methods is required (an array of names, or null for no restriction)' };
	}
	const raw = (body as { enabled_methods: unknown }).enabled_methods;
	if (raw === null) return { enabled: null };
	if (!Array.isArray(raw) || !raw.every((n) => typeof n === 'string' && n.trim().length > 0)) {
		return { error: 'enabled_methods must be an array of non-empty strings, or null' };
	}
	return { enabled: [...new Set(raw as string[])] };
}

/**
 * Names in the allowlist the server does not advertise. Rejecting these turns a
 * typo into a 400 instead of a silently-inert entry that looks enabled in the
 * UI. Skipped when the catalog is empty — the connector's methods have simply
 * never been listed, and refusing every name then would make the route unusable.
 */
function unknownMethodNames(enabled: string[] | null, catalog: McpMethodInfo[] | null): string[] {
	if (enabled === null || !catalog || catalog.length === 0) return [];
	const known = new Set(catalog.map((m) => m.name));
	return enabled.filter((n) => !known.has(n));
}

/** The method-discovery module, loaded on demand: it pulls in the MCP client
 * SDK, which a request that never touches a connector should not pay for. */
const methodDiscovery = () => import('../services/connectors/method-discovery');

/** Run discovery for a connector with the request's own deps. */
async function refreshConnectorMethods(
	deps: MethodDiscoveryDeps,
	connectorId: string,
	trigger: 'connect' | 'create' | 'manual' = 'manual',
): Promise<MethodDiscoveryResult> {
	const { discoverConnectorMethods } = await methodDiscovery();
	return discoverConnectorMethods(deps, connectorId, trigger);
}

/**
 * Probe a just-registered hosted MCP server, and say what it means.
 *
 * Awaited rather than backgrounded: whether the server answers Hezo without a
 * credential is what decides whether the connector reaches an agent run at all,
 * so the person who just registered it gets that answer with the registration
 * instead of discovering it days later in a run log they cannot see.
 *
 * Returns null for a connector kind that has no server to probe.
 */
async function probeOnCreate(
	deps: MethodDiscoveryDeps,
	kind: string,
	connectorId: string,
): Promise<ConnectorProbeVerdict | null> {
	if (kind !== ConnectorTransport.Saas) return null;
	const { describeProbeVerdict } = await methodDiscovery();
	const result = await refreshConnectorMethods(deps, connectorId, 'create').catch(
		(e): MethodDiscoveryResult => ({
			ok: false,
			reason: 'probe_failed',
			detail: (e as Error).message,
			phase: 'handshake',
		}),
	);
	return describeProbeVerdict(result);
}

/** Re-read a connector after a probe, so the response carries the evidence the
 * request just gathered rather than the row as it stood before. */
async function rereadConnector(
	db: Env['Variables']['db'],
	connectorId: string,
): Promise<Record<string, unknown> | null> {
	const r = await db.query(`SELECT ${CONNECTOR_COLUMNS} FROM mcp_connections WHERE id = $1`, [
		connectorId,
	]);
	return (r.rows[0] as Record<string, unknown>) ?? null;
}

// The bundled OAuth-provider descriptors (Google/YouTube, GitHub, …) used to
// populate the generic OAuth-broker form's provider dropdown. Exposes only
// public descriptor data (id, endpoints, scopes, allowed_hosts) — no secrets —
// so any authenticated member may read it. Declared before `/connectors/:id`
// (different verb anyway) so the literal path never falls through to a param.
connectorsRoutes.get('/connectors/oauth-providers', async (c) => {
	return ok(c, resolveConnectorRegistry().oauthProviders);
});

connectorsRoutes.get('/projects/:projectId/connectors', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const { page, perPage, offset } = parsePagination(c);
	const countResult = await db.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM mcp_connections mc
		 WHERE mc.project_id = $1 OR mc.project_id IS NULL`,
		[projectId],
	);
	const total = countResult.rows[0]?.total ?? 0;
	const result = await db.query(
		`SELECT ${CONNECTOR_COLUMNS_MC}, oc.provider_account_label AS oauth_account_label,
		        LOWER(t.identifier) AS created_by_task_identifier, t.title AS created_by_task_title,
		        ${connectorCredentialsJson('mc')},
		        ${connectorLinkedReposJson('mc', '$4')}
		 FROM mcp_connections mc
		 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
		 LEFT JOIN tasks t ON t.id = mc.created_by_task_id
		 WHERE mc.project_id = $1 OR mc.project_id IS NULL
		 ORDER BY mc.name ASC
		 LIMIT $2 OFFSET $3`,
		[projectId, perPage, offset, c.get('teamId') as string],
	);
	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

/**
 * The broken connectors visible from this project, for the health banner.
 *
 * Deliberately not derived from the paginated list above: a connector that broke
 * is the one thing an operator must see immediately, and reading it off page 1
 * of a 50-row page would make that depend on where the row happened to sort. The
 * projection is narrow by design - just enough to name what broke and link to it.
 *
 * "Degraded" is the working-to-broken case specifically (`activated_at` set and
 * an `auth_error` recorded); a connector that never finished its first connect
 * is a setup step the operator already knows about, not a regression, and is not
 * banner-worthy. No MCP twin: agents learn the same thing from `list_connectors`,
 * whose `oauth_status` is derived by the same shared ladder.
 */
connectorsRoutes.get('/projects/:projectId/connectors/health', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const result = await db.query<{ id: string; name: string; display_name: string | null }>(
		`SELECT mc.id, mc.name, mc.display_name
		 FROM mcp_connections mc
		 WHERE (mc.project_id = $1 OR mc.project_id IS NULL)
		   AND mc.revoked_at IS NULL
		   AND mc.activated_at IS NOT NULL
		   AND mc.auth_error IS NOT NULL
		 ORDER BY mc.name ASC
		 LIMIT 50`,
		[projectId],
	);
	return c.json({
		data: { degraded: result.rows, count: result.rows.length },
	});
});

// Admin surface: every connector across all projects, each annotated with its
// owning project (null = global) so `/settings/connectors` can render + filter
// by project.
connectorsRoutes.get('/connectors', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const { page, perPage, offset } = parsePagination(c);
	const countResult = await db.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM mcp_connections mc`,
	);
	const total = countResult.rows[0]?.total ?? 0;
	const result = await db.query(
		`SELECT ${CONNECTOR_COLUMNS_MC}, p.name AS project_name, p.slug AS project_slug,
		        oc.provider_account_label AS oauth_account_label,
		        ${connectorCredentialsJson('mc')},
		        ${connectorLinkedReposJson('mc', null)}
		 FROM mcp_connections mc
		 LEFT JOIN projects p ON p.id = mc.project_id
		 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
		 ORDER BY mc.name ASC
		 LIMIT $1 OFFSET $2`,
		[perPage, offset],
	);
	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

connectorsRoutes.post('/connectors', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		display_name?: string;
		kind: 'saas' | 'api';
		config: Record<string, unknown>;
		project_id?: string | null;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	// The admin surface manages remote (`saas`) MCP servers and direct-REST (`api`)
	// connectors — local (stdio) MCPs carry per-container install state and are
	// managed on the project page only.
	if (body.kind !== ConnectorTransport.Saas && body.kind !== ConnectorTransport.Api) {
		return err(c, 'INVALID_REQUEST', 'connectors must be "saas" (remote MCP url) or "api"', 400);
	}
	let config = body.config;
	if (body.kind === ConnectorTransport.Api) {
		const validated = validateApiConnectorConfig(config);
		if (!validated.ok) return err(c, 'INVALID_REQUEST', validated.error, 400);
		config = validated.config as unknown as Record<string, unknown>;
		// Preserve an OAuth-broker provider preset (the completion UI locks onto it).
		// Merged AFTER validation, which strips unknown keys. Validated against the
		// bundled registry so a bad id can't be persisted.
		const rawProvider = (body.config as { oauth_provider_id?: unknown }).oauth_provider_id;
		if (typeof rawProvider === 'string' && rawProvider.trim()) {
			const providerId = rawProvider.trim();
			if (!resolveConnectorRegistry().oauthProviders.some((p) => p.id === providerId)) {
				return err(c, 'INVALID_REQUEST', `unknown oauth_provider_id=${providerId}`, 400);
			}
			config.oauth_provider_id = providerId;
		}
	} else {
		const url = body.config?.url;
		if (typeof url !== 'string' || !url) {
			return err(c, 'INVALID_REQUEST', 'saas connections require config.url (string)', 400);
		}
	}

	// The admin surface may target a specific project (from the scope dropdown) or
	// create a global "all projects" connector (project_id null). Validate a named
	// project exists; the superuser may act on any.
	const projectId = body.project_id?.trim() || null;
	if (projectId) {
		const proj = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1`, [
			projectId,
		]);
		if (proj.rows.length === 0) return err(c, 'NOT_FOUND', 'project_id not found', 404);
	}

	// Re-adding an existing name in the same scope is a reconfiguration: config is
	// replaced wholesale (dropping any stale config.dcr for a changed URL) and a
	// previous OAuth attempt's auth_error is cleared, so the row starts from a
	// clean slate. The probe evidence goes with it - it was gathered against the
	// old URL, and a row proven public at one address is not proven at another.
	// An active row keeps oauth_connection_id/activated_at. The conflict target
	// names the partial unique index matching the row's scope.
	const conflictTarget = projectId
		? '(project_id, name) WHERE project_id IS NOT NULL'
		: '(name) WHERE project_id IS NULL';
	const result = await db.query(
		`INSERT INTO mcp_connections (name, display_name, kind, config, install_status, project_id)
		 VALUES ($1, $2, $3::mcp_connection_kind, $4::jsonb, 'installed'::mcp_install_status, $5)
		 ON CONFLICT ${conflictTarget} DO UPDATE
		 SET display_name = EXCLUDED.display_name,
		     kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     auth_error = NULL,
		     probed_at = NULL,
		     probe_error = NULL,
		     updated_at = now()
		 RETURNING ${CONNECTOR_COLUMNS}`,
		[
			body.name.trim(),
			body.display_name?.trim() ?? null,
			body.kind,
			JSON.stringify(config),
			projectId,
		],
	);

	const createdRow = result.rows[0] as { id: string; name: string };
	c.get('events').emit({
		type: 'mcp_connection.created',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: createdRow.id,
		name: createdRow.name,
	});
	const probe = await probeOnCreate(
		{ db, masterKeyManager: c.get('masterKeyManager') },
		body.kind,
		createdRow.id,
	);
	return ok(c, { ...(await rereadConnector(db, createdRow.id)), probe }, 201);
});

// Admin surface: re-scope a connector to a different project (or to the global
// "all projects" scope, project_id null). Only the scope is editable here — the
// per-row inline scope picker on `/settings/connectors` posts to this.
connectorsRoutes.patch('/connectors/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');

	const body = await c.req
		.json<{ project_id?: string | null }>()
		.catch(() => ({}) as { project_id?: string | null });
	if (!('project_id' in body)) {
		return err(c, 'INVALID_REQUEST', 'project_id is required', 400);
	}
	// Empty/whitespace collapses to the global scope (project_id null).
	const projectId = body.project_id?.trim() || null;
	if (projectId) {
		const proj = await db.query<{ id: string }>(`SELECT id FROM projects WHERE id = $1`, [
			projectId,
		]);
		if (proj.rows.length === 0) return err(c, 'NOT_FOUND', 'project_id not found', 404);
	}

	let result: Awaited<ReturnType<typeof db.query>>;
	try {
		result = await db.query(
			`UPDATE mcp_connections SET project_id = $2, updated_at = now()
			 WHERE id = $1
			 RETURNING ${CONNECTOR_COLUMNS},
			   (SELECT name FROM projects WHERE id = project_id) AS project_name,
			   (SELECT slug FROM projects WHERE id = project_id) AS project_slug`,
			[id, projectId],
		);
	} catch (e) {
		// Moving into a scope that already holds a connector of the same name trips
		// one of the partial unique indexes (global name / per-project name).
		if (isUniqueViolation(e)) {
			return err(
				c,
				'CONFLICT',
				'a connector with this name already exists in the target scope',
				409,
			);
		}
		throw e;
	}
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);

	const updated = result.rows[0] as { id: string; name: string };
	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: updated.id,
		name: updated.name,
		changeKind: 'scope',
	});
	return ok(c, result.rows[0]);
});

connectorsRoutes.delete('/connectors/:id', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');
	// No linked-repo guard: an admin removing a connector is a deliberate act, and
	// unlike an agent doing it they are told what it costs by the Connectors page.
	const outcome = await deleteConnector(db, id);
	if (outcome.outcome === 'not_found') {
		return err(c, 'NOT_FOUND', 'connector not found', 404);
	}
	c.get('events').emit({
		type: 'mcp_connection.deleted',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: outcome.id,
		name: outcome.name,
	});
	return c.json({ data: null }, 200);
});

connectorsRoutes.get('/projects/:projectId/connectors/:id', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const id = c.req.param('id');
	const result = await db.query(
		`SELECT ${CONNECTOR_COLUMNS_MC}, ${connectorCredentialsJson('mc')},
		        ${connectorLinkedReposJson('mc', '$3')} FROM mcp_connections mc
		 WHERE mc.id = $1 AND (mc.project_id = $2 OR mc.project_id IS NULL)`,
		[id, projectId, c.get('teamId') as string],
	);
	if (result.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	return ok(c, result.rows[0]);
});

/**
 * Method access for one connector: the cached catalog of what the MCP server
 * advertises, plus the allowlist of what this connector actually exposes.
 *
 * `enabled_methods` of `null` means unrestricted, and the API preserves that
 * distinction end to end — it is not shorthand for "every name in the catalog".
 *
 * There is deliberately no MCP-tool counterpart to the write route below. An
 * agent may *narrow* its own access when it registers a connector
 * (`register_connector`'s `access` argument), but letting one widen an
 * allowlist would be a privilege escalation, so editing is human-only. The
 * AGENTS.md parallel-naming rule doesn't apply where only one surface exists.
 */
connectorsRoutes.get('/projects/:projectId/connectors/:id/methods', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const found = await loadConnectorMethods(db, c.req.param('id'), projectId);
	if (!found) return err(c, 'NOT_FOUND', 'connector not found', 404);
	return ok(c, found);
});

connectorsRoutes.patch('/projects/:projectId/connectors/:id/methods', async (c) => {
	const db = c.get('db');
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const id = c.req.param('id');

	const body = await c.req.json().catch(() => ({}));
	const parsed = parseEnabledMethods(body);
	if ('error' in parsed) return err(c, 'INVALID_REQUEST', parsed.error, 400);

	// A global connector is read-only from a project page (matching every other
	// action on it) — it is shared by every project, so its allowlist is edited
	// on the global connectors page instead.
	const existing = await db.query<{ discovered_methods: McpMethodInfo[] | null; name: string }>(
		`SELECT discovered_methods, name FROM mcp_connections WHERE id = $1 AND project_id = $2`,
		[id, projectId],
	);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'connector not found in this project', 404);
	}

	const unknown = unknownMethodNames(parsed.enabled, existing.rows[0].discovered_methods);
	if (unknown.length > 0) {
		return err(
			c,
			'INVALID_REQUEST',
			`not advertised by this server: ${unknown.join(', ')}. Refresh the method list if the server has changed.`,
			400,
		);
	}

	const updated = await db.query(
		`UPDATE mcp_connections SET enabled_methods = $1::jsonb, updated_at = now()
		 WHERE id = $2 RETURNING ${CONNECTOR_COLUMNS}`,
		[parsed.enabled === null ? null : JSON.stringify(parsed.enabled), id],
	);

	broadcastConnectorChange(c, { teamId, projectId }, 'UPDATE', { id, status: 'updated' });
	const actor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId,
		actorType: actor.actorType,
		actorMemberId: actor.actorMemberId,
		connectionId: id,
		name: existing.rows[0].name,
		changeKind: 'method_access',
	});
	return ok(c, updated.rows[0]);
});

connectorsRoutes.post('/projects/:projectId/connectors/:id/methods/refresh', async (c) => {
	const db = c.get('db');
	const projectId = c.get('projectId') as string;
	const id = c.req.param('id');

	const owned = await db.query<{ id: string }>(
		`SELECT id FROM mcp_connections WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
		[id, projectId],
	);
	if (owned.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);

	const result = await refreshConnectorMethods(
		{ db, masterKeyManager: c.get('masterKeyManager') },
		id,
	);
	if (!result.ok) {
		const { describeDiscoveryFailure } = await methodDiscovery();
		return err(c, 'INVALID_REQUEST', describeDiscoveryFailure(result), 400);
	}

	const found = await loadConnectorMethods(db, id, projectId);
	return ok(c, found);
});

// Admin equivalents of the three /methods routes above, for the global
// Connectors page. A **global** ("All projects") connector is read-only from any
// project page — it is shared by every project — so these are the only place its
// allowlist can be edited. They are admin-only for the same reason the
// project-scoped PATCH has no MCP tool: widening method access is a privilege
// decision, never something a run can make for itself.
connectorsRoutes.get('/connectors/:id/methods', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const found = await loadConnectorMethods(c.get('db'), c.req.param('id'), null);
	if (!found) return err(c, 'NOT_FOUND', 'connector not found', 404);
	return ok(c, found);
});

connectorsRoutes.patch('/connectors/:id/methods', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');

	const body = await c.req.json().catch(() => ({}));
	const parsed = parseEnabledMethods(body);
	if ('error' in parsed) return err(c, 'INVALID_REQUEST', parsed.error, 400);

	const existing = await db.query<{ discovered_methods: McpMethodInfo[] | null; name: string }>(
		`SELECT discovered_methods, name FROM mcp_connections WHERE id = $1`,
		[id],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);

	const unknown = unknownMethodNames(parsed.enabled, existing.rows[0].discovered_methods);
	if (unknown.length > 0) {
		return err(
			c,
			'INVALID_REQUEST',
			`not advertised by this server: ${unknown.join(', ')}. Refresh the method list if the server has changed.`,
			400,
		);
	}

	const updated = await db.query(
		`UPDATE mcp_connections SET enabled_methods = $1::jsonb, updated_at = now()
		 WHERE id = $2 RETURNING ${CONNECTOR_COLUMNS}`,
		[parsed.enabled === null ? null : JSON.stringify(parsed.enabled), id],
	);

	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		connectionId: id,
		name: existing.rows[0].name,
		changeKind: 'method_access',
	});
	return ok(c, updated.rows[0]);
});

connectorsRoutes.post('/connectors/:id/methods/refresh', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const id = c.req.param('id');

	const owned = await db.query<{ id: string }>(`SELECT id FROM mcp_connections WHERE id = $1`, [
		id,
	]);
	if (owned.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);

	const result = await refreshConnectorMethods(
		{ db, masterKeyManager: c.get('masterKeyManager') },
		id,
	);
	if (!result.ok) {
		const { describeDiscoveryFailure } = await methodDiscovery();
		return err(c, 'INVALID_REQUEST', describeDiscoveryFailure(result), 400);
	}

	return ok(c, await loadConnectorMethods(db, id, null));
});

connectorsRoutes.post('/projects/:projectId/connectors/:id/revoke', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const id = c.req.param('id');
	const { markRevoked } = await import('../services/connectors/lifecycle');
	const existing = await db.query<{
		name: string;
		oauth_connection_id: string | null;
		api_key_secret_id: string | null;
	}>(
		// Own rows plus global ones. Scoping this to owned rows was tried and
		// reverted: it scopes on `mcp_connections.project_id` while the destruction
		// happens in `oauth_connections`, whose scope is a different column that
		// `PATCH /api/connectors/:id {project_id}` moves independently - so it did
		// not close the cross-project blast radius, and it left a global connection
		// with no revoke surface anywhere. The protection is the dialog naming every
		// repo that breaks, the same choice the delete path makes.
		`SELECT name, oauth_connection_id, api_key_secret_id FROM mcp_connections
		 WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
		[id, projectId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	const row = await markRevoked(db, id);
	// markRevoked already nulled api_key_secret_id (ON DELETE SET NULL would too);
	// purge the pasted-key secret from the vault so a revoke leaves nothing behind.
	if (existing.rows[0].api_key_secret_id) {
		await db
			.query(`DELETE FROM secrets WHERE id = $1`, [existing.rows[0].api_key_secret_id])
			.catch((e) =>
				log.warn('failed to delete api-key secret on revoke', { error: (e as Error).message }),
			);
		invalidateSecretsVault();
	}
	if (existing.rows[0].oauth_connection_id) {
		const { deleteConnection } = await import('../services/oauth/connection-store');
		const masterKeyManager = c.get('masterKeyManager');
		const oauthConnectionId = existing.rows[0].oauth_connection_id;
		await deleteConnection({ db, masterKeyManager }, oauthConnectionId)
			.then(() => {
				const a = resolveActor(db, c.get('auth'), teamId);
				return a.then((actor) =>
					c.get('events').emit({
						type: 'connection.deleted',
						teamId,
						actorType: actor.actorType,
						actorMemberId: actor.actorMemberId,
						connectionId: oauthConnectionId,
						provider: existing.rows[0].name,
					}),
				);
			})
			.catch((e) =>
				log.warn('failed to delete oauth_connection on revoke', { error: (e as Error).message }),
			);
	}
	broadcastConnectorChange(c, { teamId, projectId }, 'UPDATE', {
		id,
		status: 'revoked',
	});
	const revokeActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId,
		actorType: revokeActor.actorType,
		actorMemberId: revokeActor.actorMemberId,
		connectionId: id,
		name: existing.rows[0].name,
		changeKind: 'revoked',
	});
	return ok(c, row);
});

/**
 * Derive a stable, grammar-valid vault secret name for a connector's pasted API
 * key. A project-scoped connector's key is qualified with the first 5 hex chars
 * of its project UUID (`MCP_<base>_<PROJFRAG>`) so two connectors of the same
 * type in different projects get distinctly-named credentials — the name is the
 * only project signal, since credentials themselves stay global. A global
 * ("all projects") connector's key is unqualified (`MCP_<base>`). Deriving from
 * (connector name, project) keeps re-pastes upserting the same secret; connector
 * names are unique within a scope, so the base never collides in-scope.
 */
function apiKeySecretName(connectorName: string, projectId: string | null): string {
	const frag = projectId ? projectId.replace(/-/g, '').slice(0, 5).toUpperCase() : '';
	let base = connectorName
		.toUpperCase()
		.replace(/[^A-Z0-9_]/g, '_')
		.replace(/^[^A-Z]+/, '');
	if (base.length === 0) base = 'KEY';
	// Cap so total `MCP_<base>[_<frag>]` stays within the 64-char grammar limit.
	const tail = frag ? 1 + frag.length : 0;
	base = base.slice(0, 64 - 'MCP_'.length - tail);
	return frag ? `MCP_${base}_${frag}` : `MCP_${base}`;
}

/**
 * Attach a pasted API key to a connector whose provider exposes no OAuth. Covers
 * both a `saas` MCP whose server takes a bearer/API key (e.g. Typefully) and an
 * `api` connector (a direct REST API with no MCP server). The key is encrypted
 * into the vault, scoped by allowed_hosts (the saas MCP host, or the api
 * connector's `allowed_hosts` / `base_url` host), and referenced from the
 * connector via api_key_secret_id. The raw key NEVER touches the agent run — a
 * saas descriptor emits a `__HEZO_SECRET_*__` placeholder and an api connector
 * surfaces the same placeholder via `list_connectors`; the egress proxy
 * substitutes at request time (AGENTS.md red line). Response-driven
 * (security-sensitive).
 */
connectorsRoutes.post('/projects/:projectId/connectors/:id/api-key', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');
	const id = c.req.param('id');

	const body = await c.req
		.json<{ value?: string; header?: string; scheme?: string }>()
		.catch(() => ({}) as { value?: string; header?: string; scheme?: string });
	const value = typeof body.value === 'string' ? body.value.trim() : '';
	if (!value) return err(c, 'INVALID_REQUEST', 'value is required', 400);

	// Scoped load: the connector must belong to this project (or be global).
	const existing = await db.query<{
		id: string;
		name: string;
		kind: string;
		config: Record<string, unknown>;
		revoked_at: string | null;
		created_by_task_id: string | null;
		project_id: string | null;
	}>(
		`SELECT id, name, kind::text AS kind, config, revoked_at::text AS revoked_at, created_by_task_id, project_id
		 FROM mcp_connections
		 WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
		[id, projectId],
	);
	if (existing.rows.length === 0) return err(c, 'NOT_FOUND', 'connector not found', 404);
	const conn = existing.rows[0];
	// A revoked connector is restored in place: pasting a key is a fresh reconnect
	// rather than an error. markApiKeyActive below clears revoked_at and re-stamps
	// activated_at as part of attaching the new key.
	//
	// Determine the host(s) the pasted key is scoped to. For a `saas` MCP the key
	// rides an HTTP header on the MCP endpoint, so it's scoped to that url's host.
	// For an `api` connector (direct REST) it's scoped to the config's
	// `allowed_hosts` (falling back to the `base_url` host). Local (stdio) rows
	// authenticate via request_credential, not this route.
	let allowedHosts: string[];
	if (conn.kind === ConnectorTransport.Saas) {
		const url = typeof conn.config?.url === 'string' ? (conn.config.url as string) : '';
		try {
			allowedHosts = [new URL(url).host.toLowerCase()];
		} catch {
			return err(c, 'INVALID_REQUEST', 'connector has no valid MCP server url', 400);
		}
	} else if (conn.kind === ConnectorTransport.Api) {
		const cfgHosts = Array.isArray(conn.config?.allowed_hosts)
			? (conn.config.allowed_hosts as unknown[]).filter(
					(h): h is string => typeof h === 'string' && h.trim().length > 0,
				)
			: [];
		if (cfgHosts.length > 0) {
			allowedHosts = [...new Set(cfgHosts.map((h) => h.trim().toLowerCase()))];
		} else {
			const baseUrl =
				typeof conn.config?.base_url === 'string' ? (conn.config.base_url as string) : '';
			try {
				allowedHosts = [new URL(baseUrl).host.toLowerCase()];
			} catch {
				return err(c, 'INVALID_REQUEST', 'connector has no valid base_url', 400);
			}
		}
	} else {
		return err(c, 'INVALID_REQUEST', 'API-key auth applies to saas or api connectors', 400);
	}

	const encryptionKey = masterKeyManager.getKey();
	if (!encryptionKey) return err(c, 'LOCKED', 'Master key not available', 503);

	// Header/scheme override (the form's "Advanced" disclosure) — a saas concept:
	// which header the placeholder rides in on the MCP descriptor. Default to
	// `Authorization` / `Bearer ` — covers most MCP servers incl. Typefully. An
	// explicit empty scheme lets a provider take the raw key (e.g. `X-API-Key`).
	// An `api` connector already carries its placement/name/scheme in `config.auth`
	// (there is no MCP descriptor), so no `config.apiKey` is written for it.
	const header =
		conn.kind === ConnectorTransport.Saas &&
		typeof body.header === 'string' &&
		body.header.trim().length > 0
			? body.header.trim()
			: undefined;
	const scheme =
		conn.kind === ConnectorTransport.Saas && typeof body.scheme === 'string'
			? body.scheme
			: undefined;
	const apiKeyConfig =
		header !== undefined || scheme !== undefined
			? { ...(header !== undefined ? { header } : {}), ...(scheme !== undefined ? { scheme } : {}) }
			: null;

	const secretName = apiKeySecretName(conn.name, conn.project_id);
	const nameCheck = validateSecretName(secretName);
	if (!nameCheck.valid) {
		return err(c, 'INVALID_REQUEST', `derived secret name invalid: ${nameCheck.error}`, 500);
	}

	const updated = await withTransaction(db, async () => {
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts)
			 VALUES ($1, $2, 'api_token'::secret_category, $3::text[])
			 ON CONFLICT (name) DO UPDATE
			   SET encrypted_value = EXCLUDED.encrypted_value,
			       category = EXCLUDED.category,
			       allowed_hosts = EXCLUDED.allowed_hosts,
			       updated_at = now()
			 RETURNING id`,
			[secretName, encrypt(value, encryptionKey), allowedHosts],
		);
		return markApiKeyActive(db, conn.id, secret.rows[0].id, apiKeyConfig);
	});
	invalidateSecretsVault();
	if (!updated) return err(c, 'NOT_FOUND', 'connector not found', 404);

	broadcastConnectorChange(c, { teamId, projectId }, 'UPDATE', {
		id: conn.id,
		status: 'active',
	});
	const actor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.updated',
		teamId,
		actorType: actor.actorType,
		actorMemberId: actor.actorMemberId,
		connectionId: conn.id,
		name: conn.name,
		changeKind: 'api_key_set',
	});
	// Resume the agent that requested this connector (if any), like OAuth connect.
	await fireCredentialProvidedWakeup(db, {
		id: conn.id,
		created_by_task_id: conn.created_by_task_id,
	});

	// Same post-activation step as the OAuth path: list the server's methods now
	// that the key works, applying any read-only access the requesting agent
	// asked for. Backgrounded so a slow third-party server can't stall the paste.
	trackBackground(
		refreshConnectorMethods(
			{ db, masterKeyManager: c.get('masterKeyManager') },
			conn.id,
			'connect',
		).catch((e) =>
			log.warn('method discovery failed after api-key connect', {
				connectorId: conn.id,
				error: (e as Error).message,
			}),
		),
	);

	return ok(c, updated);
});

connectorsRoutes.post('/projects/:projectId/connectors', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');

	const body = await c.req.json<{
		name: string;
		kind: 'saas' | 'local' | 'api';
		config: Record<string, unknown>;
		oauth_connection_id?: string | null;
	}>();

	if (!body.name?.trim()) {
		return err(c, 'INVALID_REQUEST', 'name is required', 400);
	}
	if (
		body.kind !== ConnectorTransport.Saas &&
		body.kind !== ConnectorTransport.Local &&
		body.kind !== ConnectorTransport.Api
	) {
		return err(c, 'INVALID_REQUEST', 'kind must be "saas", "local", or "api"', 400);
	}
	let config = body.config;
	if (body.kind === ConnectorTransport.Saas) {
		const url = body.config?.url;
		if (typeof url !== 'string' || !url) {
			return err(c, 'INVALID_REQUEST', 'saas connections require config.url (string)', 400);
		}
	} else if (body.kind === ConnectorTransport.Api) {
		const validated = validateApiConnectorConfig(config);
		if (!validated.ok) return err(c, 'INVALID_REQUEST', validated.error, 400);
		config = validated.config as unknown as Record<string, unknown>;
		// Preserve an OAuth-broker provider preset (the completion UI locks onto it).
		// Merged AFTER validation, which strips unknown keys; validated against the
		// bundled registry so a bad id can't be persisted.
		const rawProvider = (body.config as { oauth_provider_id?: unknown }).oauth_provider_id;
		if (typeof rawProvider === 'string' && rawProvider.trim()) {
			const providerId = rawProvider.trim();
			if (!resolveConnectorRegistry().oauthProviders.some((p) => p.id === providerId)) {
				return err(c, 'INVALID_REQUEST', `unknown oauth_provider_id=${providerId}`, 400);
			}
			config.oauth_provider_id = providerId;
		}
	} else if (typeof body.config?.command !== 'string' || !body.config.command) {
		return err(c, 'INVALID_REQUEST', 'local connections require config.command (string)', 400);
	}

	if (body.oauth_connection_id) {
		// Only an oauth connection visible to this project (its own or global) may
		// be linked — never another project's.
		const ownership = await db.query<{ id: string }>(
			`SELECT id FROM oauth_connections
			 WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
			[body.oauth_connection_id, projectId],
		);
		if (ownership.rows.length === 0) {
			return err(c, 'NOT_FOUND', 'oauth_connection_id not found', 404);
		}
	}

	// Only local (stdio) MCPs need an installer pass; saas and api are usable at
	// once (api is a direct REST call — nothing to install).
	const initialStatus = body.kind === ConnectorTransport.Local ? 'pending' : 'installed';
	// A re-point drops the probe evidence with the config it was gathered
	// against: a server proven public at one URL is not proven at another.
	const result = await db.query(
		`INSERT INTO mcp_connections (name, kind, config, oauth_connection_id, install_status, project_id)
		 VALUES ($1, $2::mcp_connection_kind, $3::jsonb, $4, $5::mcp_install_status, $6)
		 ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL DO UPDATE
		 SET kind = EXCLUDED.kind,
		     config = EXCLUDED.config,
		     oauth_connection_id = EXCLUDED.oauth_connection_id,
		     install_status = EXCLUDED.install_status,
		     install_error = NULL,
		     probed_at = NULL,
		     probe_error = NULL,
		     updated_at = now()
		 RETURNING ${CONNECTOR_COLUMNS}`,
		[
			body.name.trim(),
			body.kind,
			JSON.stringify(config),
			body.oauth_connection_id ?? null,
			initialStatus,
			projectId,
		],
	);

	const inserted = result.rows[0] as Record<string, unknown>;
	broadcastConnectorChange(c, { teamId, projectId }, 'INSERT', inserted);

	const createActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.created',
		teamId,
		actorType: createActor.actorType,
		actorMemberId: createActor.actorMemberId,
		connectionId: inserted.id as string,
		name: inserted.name as string,
	});

	// Kick off install for local MCPs against any running container of the
	// team that created it. install_status is advisory under a global catalog.
	if (body.kind === ConnectorTransport.Local) {
		trackBackground(
			kickoffLocalInstall(c, teamId, inserted.id as string).catch((e) =>
				log.warn('local mcp install kickoff failed', { error: (e as Error).message }),
			),
		);
	}

	const probe = await probeOnCreate(
		{ db, masterKeyManager: c.get('masterKeyManager') },
		body.kind,
		inserted.id as string,
	);
	return ok(c, { ...(await rereadConnector(db, inserted.id as string)), probe }, 201);
});

async function kickoffLocalInstall(
	c: import('hono').Context<Env>,
	teamId: string,
	rowId: string,
): Promise<void> {
	const db = c.get('db');
	const docker = c.get('docker');

	const candidates = await db.query<{ id: string; container_id: string | null }>(
		`SELECT id, container_id FROM projects
		 WHERE team_id = $1 AND container_id IS NOT NULL AND container_status = 'running'`,
		[teamId],
	);

	for (const project of candidates.rows) {
		if (!project.container_id) continue;
		try {
			const result = await installLocalMcpById(
				{ db, docker, containerId: project.container_id, teamId, projectId: project.id },
				rowId,
			);
			if (result) {
				broadcastConnectorChange(c, { teamId, projectId: project.id }, 'UPDATE', {
					id: rowId,
					install_status: result.status,
					install_error: result.error ?? null,
				});
			}
		} catch (e) {
			log.warn('local mcp install per-project failed', {
				project: project.id,
				error: (e as Error).message,
			});
		}
	}
}

/**
 * Idempotently materialize a connector row from the capability registry.
 * Used by the UI's "Connect <provider>" buttons (project settings page,
 * connectors page) so the user never has to manually create the row before
 * starting auth. Same shape as the `register_connector` MCP tool, just
 * keyed on the registry id instead of free-form input.
 */
connectorsRoutes.post('/projects/:projectId/connectors/ensure', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const body = (await c.req.json().catch(() => ({}))) as { provider_id?: string };
	const providerId = body.provider_id?.trim();
	if (!providerId) return err(c, 'INVALID_REQUEST', 'provider_id is required', 400);
	const capability = getConnectorCapability(providerId);
	if (!capability)
		return err(c, 'NOT_FOUND', `no registered capability for provider_id=${providerId}`, 404);
	if (!capability.mcpServer.url)
		return err(c, 'INVALID_REQUEST', `provider ${providerId} has no MCP server url`, 400);

	const { row, alreadyExisted } = await createOrFetchConnector(db, {
		name: capability.id,
		displayName: capability.displayName,
		mcpUrl: capability.mcpServer.url,
		mcpTransport: capability.mcpServer.transport,
		mcpHeaders: capability.mcpServer.headers,
		providerId: capability.id,
		projectId,
	});
	if (!alreadyExisted) {
		broadcastConnectorChange(c, { teamId, projectId }, 'INSERT', { id: row.id });
		const ensureActor = await resolveActor(db, c.get('auth'), teamId);
		c.get('events').emit({
			type: 'mcp_connection.created',
			teamId,
			actorType: ensureActor.actorType,
			actorMemberId: ensureActor.actorMemberId,
			connectionId: row.id as string,
			name: row.name as string,
		});
	}
	// Backgrounded, unlike the two create routes: this response is one step in
	// starting an OAuth flow the user just clicked, and the callback re-runs
	// discovery anyway. Blocking it on a third-party round trip would only slow
	// the redirect they are waiting for.
	trackBackground(
		probeOnCreate({ db, masterKeyManager: c.get('masterKeyManager') }, row.kind, row.id).catch(
			(e) => log.warn('connector probe after ensure failed', { error: (e as Error).message }),
		),
	);
	return ok(c, row);
});

connectorsRoutes.delete('/projects/:projectId/connectors/:id', async (c) => {
	const teamId = c.get('teamId') as string;
	const projectId = c.get('projectId') as string;
	const db = c.get('db');
	const id = c.req.param('id');

	// A project may only delete its own connectors, never a global or another
	// project's. No linked-repo guard: a human may legitimately want the MCP tools
	// gone while git keeps working, and the Connectors page names what it costs.
	const outcome = await deleteConnector(db, id, { projectId });
	if (outcome.outcome === 'not_found') {
		return err(c, 'NOT_FOUND', 'MCP connection not found', 404);
	}
	broadcastConnectorChange(c, { teamId, projectId }, 'DELETE', { id });
	const deleteActor = await resolveActor(db, c.get('auth'), teamId);
	c.get('events').emit({
		type: 'mcp_connection.deleted',
		teamId,
		actorType: deleteActor.actorType,
		actorMemberId: deleteActor.actorMemberId,
		connectionId: outcome.id,
		name: outcome.name,
	});
	return c.json({ data: null }, 200);
});
