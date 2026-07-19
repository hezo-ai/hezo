import { SecretCategory } from '@hezo/shared';
import { Hono } from 'hono';
import { validateSecretName } from '../lib/credential-placeholder';
import { buildMeta, parsePagination } from '../lib/pagination';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireAdminEquivalent } from '../middleware/auth';

/** Trim, lowercase, and drop empties so the egress allowlist match (which
 * lowercases the request host) sees clean entries. Mirrors the normalization
 * the request_credential fulfillment path applies, so both creation routes
 * store hosts identically. */
function normalizeAllowedHosts(hosts: unknown): string[] {
	if (!Array.isArray(hosts)) return [];
	return hosts.map((h) => String(h).trim().toLowerCase()).filter((h) => h.length > 0);
}

export const secretsRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Credentials are instance-global: one set of secrets shared with every team's
// egress (bounded per-secret by allowed_hosts). The Admin (superuser) manages
// them here. There is no team or project scope.
// ---------------------------------------------------------------------------

secretsRoutes.get('/credentials', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const { page, perPage, offset } = parsePagination(c);

	const countResult = await db.query<{ total: number }>(
		`SELECT count(*)::int AS total FROM secrets`,
	);
	const total = countResult.rows[0]?.total ?? 0;

	// Per-secret egress usage is no longer tracked (egress requests aren't
	// audited), so the usage columns are constant placeholders kept only for
	// response-shape stability.
	const result = await db.query(
		`SELECT s.id, s.name, s.category,
		        s.allowed_hosts, s.allow_all_hosts, s.allow_body_substitution, s.created_at, s.updated_at,
		        NULL::timestamptz AS last_used_at,
		        0 AS use_count,
		        NULL::text AS last_host,
		        COALESCE((
		            SELECT json_agg(json_build_object(
		                'id', mc.id, 'name', mc.name, 'display_name', mc.display_name,
		                'project_id', mc.project_id, 'project_slug', p.slug
		            ) ORDER BY mc.name)
		            FROM mcp_connections mc
		            LEFT JOIN projects p ON p.id = mc.project_id
		            WHERE mc.api_key_secret_id = s.id
		               OR mc.oauth_connection_id IN (
		                    SELECT oc.id FROM oauth_connections oc WHERE oc.access_token_secret_id = s.id
		               )
		        ), '[]'::json) AS connectors
		 FROM secrets s
		 ORDER BY s.name ASC
		 LIMIT $1 OFFSET $2`,
		[perPage, offset],
	);
	return c.json({ data: result.rows, meta: buildMeta(page, perPage, total) });
});

secretsRoutes.post('/secrets', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const body = await c.req.json<{
		name: string;
		value: string;
		category?: string;
		allowed_hosts?: string[];
		allow_all_hosts?: boolean;
		allow_body_substitution?: boolean;
	}>();

	if (!body.name?.trim() || !body.value) {
		return err(c, 'INVALID_REQUEST', 'name and value are required', 400);
	}

	// Enforce the canonical name grammar at creation. A name the egress proxy
	// can't match (lowercase, hyphenated, leading digit/underscore, >64 chars)
	// would store a secret that no placeholder could ever reference — a silent
	// footgun where the agent's request leaves the placeholder literal and auth
	// fails with no error. Same validation request_credential applies.
	const name = body.name.trim();
	const nameValidation = validateSecretName(name);
	if (!nameValidation.valid) {
		return err(c, 'INVALID_REQUEST', nameValidation.error, 400);
	}

	const key = masterKeyManager.getKey();
	if (!key) {
		return err(c, 'LOCKED', 'Server must be unlocked to manage secrets', 401);
	}

	const { encrypt } = await import('../crypto/encryption');
	const encryptedValue = encrypt(body.value, key);
	const allowedHosts = normalizeAllowedHosts(body.allowed_hosts);
	const allowAllHosts = !!body.allow_all_hosts;
	const allowBodySubstitution = !!body.allow_body_substitution;

	const result = await db.query(
		`INSERT INTO secrets (name, encrypted_value, category, allowed_hosts, allow_all_hosts, allow_body_substitution)
		 VALUES ($1, $2, $3::secret_category, $4, $5, $6)
		 ON CONFLICT (name) DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value,
		     category = EXCLUDED.category,
		     allowed_hosts = EXCLUDED.allowed_hosts,
		     allow_all_hosts = EXCLUDED.allow_all_hosts,
		     allow_body_substitution = EXCLUDED.allow_body_substitution,
		     updated_at = now()
		 RETURNING id, name, category, allowed_hosts, allow_all_hosts, allow_body_substitution, created_at, updated_at`,
		[
			name,
			encryptedValue,
			body.category ?? SecretCategory.Other,
			allowedHosts,
			allowAllHosts,
			allowBodySubstitution,
		],
	);
	const created = result.rows[0] as { id: string; name: string };
	c.get('events').emit({
		type: 'secret.created',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		secretId: created.id,
		name: created.name,
	});
	return ok(c, result.rows[0], 201);
});

secretsRoutes.patch('/secrets/:secretId', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const secretId = c.req.param('secretId');
	const masterKeyManager = c.get('masterKeyManager');

	const existing = await db.query('SELECT id FROM secrets WHERE id = $1', [secretId]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	const body = await c.req.json<{
		value?: string;
		category?: string;
		allowed_hosts?: string[];
		allow_all_hosts?: boolean;
		allow_body_substitution?: boolean;
	}>();

	const sets: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (body.value !== undefined) {
		const key = masterKeyManager.getKey();
		if (!key) {
			return err(c, 'LOCKED', 'Server must be unlocked to manage secrets', 401);
		}
		const { encrypt } = await import('../crypto/encryption');
		sets.push(`encrypted_value = $${idx}`);
		params.push(encrypt(body.value, key));
		idx++;
	}
	if (body.category !== undefined) {
		sets.push(`category = $${idx}::secret_category`);
		params.push(body.category);
		idx++;
	}
	if (body.allowed_hosts !== undefined) {
		if (!Array.isArray(body.allowed_hosts)) {
			return err(c, 'INVALID_REQUEST', 'allowed_hosts must be an array of strings', 400);
		}
		sets.push(`allowed_hosts = $${idx}`);
		params.push(normalizeAllowedHosts(body.allowed_hosts));
		idx++;
	}
	if (body.allow_all_hosts !== undefined) {
		sets.push(`allow_all_hosts = $${idx}`);
		params.push(!!body.allow_all_hosts);
		idx++;
	}
	if (body.allow_body_substitution !== undefined) {
		sets.push(`allow_body_substitution = $${idx}`);
		params.push(!!body.allow_body_substitution);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, existing.rows[0]);
	}

	params.push(secretId);
	const result = await db.query(
		`UPDATE secrets SET ${sets.join(', ')} WHERE id = $${idx}
		 RETURNING id, name, category, allowed_hosts, allow_all_hosts, allow_body_substitution, created_at, updated_at`,
		params,
	);
	const updated = result.rows[0] as { id: string; name: string };
	c.get('events').emit({
		type: 'secret.updated',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		secretId: updated.id,
		name: updated.name,
	});
	return ok(c, result.rows[0]);
});

secretsRoutes.delete('/secrets/:secretId', async (c) => {
	const denied = requireAdminEquivalent(c);
	if (denied) return denied;
	const db = c.get('db');
	const secretId = c.req.param('secretId');

	// A credential in use by one or more connectors (its pasted API key, or the
	// access token of a connector's OAuth connection) cannot be deleted — removing
	// it would silently break the connector's auth. Delete the connector first.
	// (The UI also disables the control; this is the authoritative guard.)
	const inUse = await db.query<{ c: number }>(
		`SELECT count(*)::int AS c FROM mcp_connections mc
		 WHERE mc.api_key_secret_id = $1
		    OR mc.oauth_connection_id IN (
		         SELECT oc.id FROM oauth_connections oc WHERE oc.access_token_secret_id = $1
		    )`,
		[secretId],
	);
	if (inUse.rows[0].c > 0) {
		return err(c, 'IN_USE', 'Credential is in use by one or more connectors', 409);
	}

	const result = await db.query<{ id: string; name: string }>(
		'DELETE FROM secrets WHERE id = $1 RETURNING id, name',
		[secretId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}
	c.get('events').emit({
		type: 'secret.deleted',
		teamId: null,
		actorType: 'admin',
		actorMemberId: null,
		secretId: result.rows[0].id,
		name: result.rows[0].name,
	});
	return c.json({ data: null }, 200);
});
