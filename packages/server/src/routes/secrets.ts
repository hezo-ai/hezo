import { SecretCategory, wsRoom } from '@hezo/shared';
import { Hono } from 'hono';
import { broadcastChange } from '../lib/broadcast';
import { err, ok } from '../lib/response';
import type { Env } from '../lib/types';
import { requireSuperuser } from '../middleware/auth';

export const secretsRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// Instance-level credentials (team_id NULL) are shared with every team's
// egress (still bounded by allowed_hosts). The Admin (superuser) manages them
// here; the per-team reads below surface them read-only so a team can see which
// inherited placeholders it may emit. Project scope never applies at the
// instance level, so project_id is always NULL for these rows.
// ---------------------------------------------------------------------------

secretsRoutes.get('/credentials', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');

	// Usage stats aggregate across every team's egress audit, since an instance
	// credential can be used by any team.
	const result = await db.query(
		`SELECT s.id, s.team_id, s.project_id, s.name, s.category,
		        s.allowed_hosts, s.allow_all_hosts, s.created_at, s.updated_at,
		        NULL AS project_name,
		        usage.last_used_at,
		        usage.use_count,
		        usage.last_host
		 FROM secrets s
		 LEFT JOIN LATERAL (
		     SELECT max(al.created_at) AS last_used_at,
		            count(*)::int AS use_count,
		            (SELECT al2.details->>'host'
		             FROM audit_log al2
		             WHERE al2.entity_type = 'egress_request'
		               AND al2.details->'secret_names_used' ? s.name
		             ORDER BY al2.created_at DESC LIMIT 1) AS last_host
		     FROM audit_log al
		     WHERE al.entity_type = 'egress_request'
		       AND al.details->'secret_names_used' ? s.name
		 ) usage ON TRUE
		 WHERE s.team_id IS NULL
		 ORDER BY usage.last_used_at DESC NULLS LAST, s.name ASC`,
	);
	return ok(c, result.rows);
});

secretsRoutes.post('/secrets', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const body = await c.req.json<{
		name: string;
		value: string;
		category?: string;
		allowed_hosts?: string[];
		allow_all_hosts?: boolean;
	}>();

	if (!body.name?.trim() || !body.value) {
		return err(c, 'INVALID_REQUEST', 'name and value are required', 400);
	}

	const key = masterKeyManager.getKey();
	if (!key) {
		return err(c, 'LOCKED', 'Server must be unlocked to manage secrets', 401);
	}

	const { encrypt } = await import('../crypto/encryption');
	const encryptedValue = encrypt(body.value, key);
	const allowedHosts = Array.isArray(body.allowed_hosts) ? body.allowed_hosts : [];
	const allowAllHosts = !!body.allow_all_hosts;

	const result = await db.query(
		`INSERT INTO secrets (team_id, project_id, name, encrypted_value, category, allowed_hosts, allow_all_hosts)
		 VALUES (NULL, NULL, $1, $2, $3::secret_category, $4, $5)
		 ON CONFLICT (name) WHERE team_id IS NULL DO UPDATE
		 SET encrypted_value = EXCLUDED.encrypted_value,
		     category = EXCLUDED.category,
		     allowed_hosts = EXCLUDED.allowed_hosts,
		     allow_all_hosts = EXCLUDED.allow_all_hosts,
		     updated_at = now()
		 RETURNING id, team_id, project_id, name, category, allowed_hosts, allow_all_hosts, created_at, updated_at`,
		[
			body.name.trim(),
			encryptedValue,
			body.category ?? SecretCategory.Other,
			allowedHosts,
			allowAllHosts,
		],
	);
	return ok(c, result.rows[0], 201);
});

secretsRoutes.patch('/secrets/:secretId', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const secretId = c.req.param('secretId');
	const masterKeyManager = c.get('masterKeyManager');

	const existing = await db.query('SELECT id FROM secrets WHERE id = $1 AND team_id IS NULL', [
		secretId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	const body = await c.req.json<{
		value?: string;
		category?: string;
		allowed_hosts?: string[];
		allow_all_hosts?: boolean;
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
		params.push(body.allowed_hosts);
		idx++;
	}
	if (body.allow_all_hosts !== undefined) {
		sets.push(`allow_all_hosts = $${idx}`);
		params.push(!!body.allow_all_hosts);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, existing.rows[0]);
	}

	params.push(secretId);
	const result = await db.query(
		`UPDATE secrets SET ${sets.join(', ')} WHERE id = $${idx} AND team_id IS NULL
		 RETURNING id, team_id, project_id, name, category, allowed_hosts, allow_all_hosts, created_at, updated_at`,
		params,
	);
	return ok(c, result.rows[0]);
});

secretsRoutes.delete('/secrets/:secretId', async (c) => {
	const denied = requireSuperuser(c);
	if (denied) return denied;
	const db = c.get('db');
	const secretId = c.req.param('secretId');

	const result = await db.query(
		'DELETE FROM secrets WHERE id = $1 AND team_id IS NULL RETURNING id',
		[secretId],
	);
	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}
	return c.json({ data: null }, 200);
});

/**
 * Augmented secrets list joined with the most recent egress-request audit
 * row that named each secret. `last_used_at` is null for secrets that have
 * never been substituted on an outbound request — useful for spotting
 * stale credentials safe to revoke.
 */
secretsRoutes.get('/teams/:teamId/credentials', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');

	const result = await db.query(
		`SELECT s.id, s.team_id, s.project_id, s.name, s.category,
		        s.allowed_hosts, s.allow_all_hosts, s.created_at, s.updated_at,
		        p.name AS project_name,
		        usage.last_used_at,
		        usage.use_count,
		        usage.last_host
		 FROM secrets s
		 LEFT JOIN projects p ON p.id = s.project_id
		 LEFT JOIN LATERAL (
		     SELECT max(al.created_at) AS last_used_at,
		            count(*)::int AS use_count,
		            (SELECT al2.details->>'host'
		             FROM audit_log al2
		             WHERE al2.team_id = $1
		               AND al2.entity_type = 'egress_request'
		               AND al2.details->'secret_names_used' ? s.name
		             ORDER BY al2.created_at DESC LIMIT 1) AS last_host
		     FROM audit_log al
		     WHERE al.team_id = $1
		       AND al.entity_type = 'egress_request'
		       AND al.details->'secret_names_used' ? s.name
		 ) usage ON TRUE
		 WHERE (s.team_id = $1 OR s.team_id IS NULL)
		 ORDER BY usage.last_used_at DESC NULLS LAST, s.name ASC`,
		[teamId],
	);
	return ok(c, result.rows);
});

secretsRoutes.get('/teams/:teamId/secrets', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const projectId = c.req.query('project_id');

	let query = `
    SELECT s.id, s.team_id, s.project_id, s.name, s.category,
           s.allowed_hosts, s.allow_all_hosts, s.created_at, s.updated_at,
           p.name AS project_name,
           (SELECT count(*) FROM secret_grants sg WHERE sg.secret_id = s.id AND sg.revoked_at IS NULL)::int AS grant_count
    FROM secrets s
    LEFT JOIN projects p ON p.id = s.project_id
    WHERE (s.team_id = $1 OR s.team_id IS NULL)`;
	const params: unknown[] = [teamId];

	if (projectId) {
		query += ` AND s.project_id = $2`;
		params.push(projectId);
	}

	query += ' ORDER BY s.name ASC';
	const result = await db.query(query, params);
	return ok(c, result.rows);
});

secretsRoutes.post('/teams/:teamId/secrets', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const masterKeyManager = c.get('masterKeyManager');

	const body = await c.req.json<{
		name: string;
		value: string;
		project_id?: string;
		category?: string;
		allowed_hosts?: string[];
		allow_all_hosts?: boolean;
	}>();

	if (!body.name?.trim() || !body.value) {
		return err(c, 'INVALID_REQUEST', 'name and value are required', 400);
	}

	const key = masterKeyManager.getKey();
	if (!key) {
		return err(c, 'LOCKED', 'Server must be unlocked to manage secrets', 401);
	}

	const { encrypt } = await import('../crypto/encryption');
	const encryptedValue = encrypt(body.value, key);

	const allowedHosts = Array.isArray(body.allowed_hosts) ? body.allowed_hosts : [];
	const allowAllHosts = !!body.allow_all_hosts;

	const result = await db.query(
		`INSERT INTO secrets (team_id, project_id, name, encrypted_value, category, allowed_hosts, allow_all_hosts)
     VALUES ($1, $2, $3, $4, $5::secret_category, $6, $7)
     RETURNING id, team_id, project_id, name, category, allowed_hosts, allow_all_hosts, created_at, updated_at`,
		[
			teamId,
			body.project_id ?? null,
			body.name.trim(),
			encryptedValue,
			body.category ?? SecretCategory.Other,
			allowedHosts,
			allowAllHosts,
		],
	);

	broadcastChange(
		c,
		wsRoom.team(teamId),
		'secrets',
		'INSERT',
		result.rows[0] as Record<string, unknown>,
	);
	return ok(c, result.rows[0], 201);
});

secretsRoutes.patch('/teams/:teamId/secrets/:secretId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const secretId = c.req.param('secretId');
	const masterKeyManager = c.get('masterKeyManager');

	const existing = await db.query('SELECT id FROM secrets WHERE id = $1 AND team_id = $2', [
		secretId,
		teamId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	const body = await c.req.json<{
		value?: string;
		category?: string;
		allowed_hosts?: string[];
		allow_all_hosts?: boolean;
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
		params.push(body.allowed_hosts);
		idx++;
	}

	if (body.allow_all_hosts !== undefined) {
		sets.push(`allow_all_hosts = $${idx}`);
		params.push(!!body.allow_all_hosts);
		idx++;
	}

	if (sets.length === 0) {
		return ok(c, existing.rows[0]);
	}

	params.push(secretId);
	const result = await db.query(
		`UPDATE secrets SET ${sets.join(', ')} WHERE id = $${idx}
     RETURNING id, team_id, project_id, name, category, allowed_hosts, allow_all_hosts, created_at, updated_at`,
		params,
	);

	return ok(c, result.rows[0]);
});

secretsRoutes.delete('/teams/:teamId/secrets/:secretId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const secretId = c.req.param('secretId');

	const existing = await db.query('SELECT id FROM secrets WHERE id = $1 AND team_id = $2', [
		secretId,
		teamId,
	]);
	if (existing.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	await db.query('DELETE FROM secrets WHERE id = $1', [secretId]);
	broadcastChange(c, wsRoom.team(teamId), 'secrets', 'DELETE', { id: secretId });
	return c.json({ data: null }, 200);
});

secretsRoutes.get('/teams/:teamId/secrets/:secretId/grants', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const secretId = c.req.param('secretId');

	const result = await db.query(
		`SELECT sg.id, sg.secret_id, sg.member_id AS agent_id, sg.scope, sg.granted_at, sg.revoked_at,
            ma.title AS agent_title
     FROM secret_grants sg
     JOIN secrets s ON s.id = sg.secret_id
     LEFT JOIN member_agents ma ON ma.id = sg.member_id
     WHERE sg.secret_id = $1 AND s.team_id = $2
     ORDER BY sg.granted_at DESC`,
		[secretId, teamId],
	);
	return ok(c, result.rows);
});

secretsRoutes.post('/teams/:teamId/secrets/:secretId/grants', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const secretId = c.req.param('secretId');

	const secretCheck = await db.query('SELECT id FROM secrets WHERE id = $1 AND team_id = $2', [
		secretId,
		teamId,
	]);
	if (secretCheck.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Secret not found', 404);
	}

	const body = await c.req.json<{
		agent_id: string;
		scope?: string;
	}>();

	if (!body.agent_id) {
		return err(c, 'INVALID_REQUEST', 'agent_id is required', 400);
	}

	const result = await db.query(
		`INSERT INTO secret_grants (secret_id, member_id, scope)
     VALUES ($1, $2, $3::grant_scope)
     ON CONFLICT (secret_id, member_id) DO UPDATE SET revoked_at = NULL
     RETURNING *`,
		[secretId, body.agent_id, body.scope ?? 'single'],
	);

	return ok(c, result.rows[0], 201);
});

secretsRoutes.delete('/teams/:teamId/secret-grants/:grantId', async (c) => {
	const teamId = c.get('teamId') as string;
	const db = c.get('db');
	const grantId = c.req.param('grantId');

	const result = await db.query(
		`UPDATE secret_grants sg SET revoked_at = now()
     FROM secrets s
     WHERE sg.id = $1 AND sg.secret_id = s.id AND s.team_id = $2
     RETURNING sg.*`,
		[grantId, teamId],
	);

	if (result.rows.length === 0) {
		return err(c, 'NOT_FOUND', 'Grant not found', 404);
	}

	return ok(c, result.rows[0]);
});
