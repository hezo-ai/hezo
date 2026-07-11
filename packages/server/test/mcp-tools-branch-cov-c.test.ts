import { createServer, type Server } from 'node:http';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	encrypt,
	mintAgentToken,
} from './helpers/app';

// Branch-coverage tests for packages/server/src/mcp/tools.ts (part C):
// project assets, project docs, skills (incl. fetch_skill_file), MCP
// connections (add/list/remove/test_connector), and register_connector.

let app: Hono<Env>;
let db: Db;
let token: string; // superuser admin
let masterKeyManager: MasterKeyManager;

let teamId: string;
let captainId: string;
let projectSlug: string;
let projectId: string;
let taskId: string;

let httpServer: Server;
let httpUrl: string; // 200 OK server
let http401Server: Server;
let http401Url: string; // 401 + WWW-Authenticate server
let closedPortUrl: string; // nothing listening

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Branch Cov Assets' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Assets Project' });
	const pData = (await projectRes.json()).data;
	projectId = pData.id;
	projectSlug = pData.slug;

	captainId = (
		await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain'`,
			[teamId],
		)
	).rows[0].id;

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Asset Task', assignee_id: captainId }),
	});
	taskId = (await taskRes.json()).data.id;

	httpServer = createServer((req, res) => {
		if (req.url?.includes('missing')) {
			res.statusCode = 404;
			res.end('not here');
			return;
		}
		if (req.url?.includes('chunked')) {
			// No content-length: forces the post-read size check.
			res.setHeader('content-type', 'text/markdown');
			res.setHeader('transfer-encoding', 'chunked');
			res.write('x'.repeat(200 * 1024));
			res.end('y'.repeat(100 * 1024));
			return;
		}
		if (req.url?.includes('huge')) {
			res.setHeader('content-type', 'text/markdown');
			res.end('x'.repeat(257 * 1024));
			return;
		}
		if (req.url?.includes('boom')) {
			res.statusCode = 500;
			res.end('kaboom');
			return;
		}
		res.setHeader('content-type', 'application/json');
		res.end('{"ok":true}');
	});
	await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	httpUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;

	http401Server = createServer((_req, res) => {
		res.statusCode = 401;
		res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="https://example.com"');
		res.end('unauthorized');
	});
	await new Promise<void>((resolve) => http401Server.listen(0, '127.0.0.1', resolve));
	http401Url = `http://127.0.0.1:${(http401Server.address() as { port: number }).port}`;

	// Reserve a port then free it, so nothing is listening there.
	const tmp = createServer(() => {});
	await new Promise<void>((resolve) => tmp.listen(0, '127.0.0.1', resolve));
	const freePort = (tmp.address() as { port: number }).port;
	await new Promise<void>((resolve) => tmp.close(() => resolve()));
	closedPortUrl = `http://127.0.0.1:${freePort}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	await new Promise<void>((resolve) => http401Server.close(() => resolve()));
	await safeClose(db);
});

async function call(
	tokenStr: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(tokenStr), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result?: { content: Array<{ text: string }> };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { error: text };
	}
}

const admin = (toolName: string, args: Record<string, unknown> = {}) =>
	call(token, toolName, { project: projectSlug, ...args });

describe('project assets', () => {
	it('write_project_asset validates type and size, then writes', async () => {
		const badType = await admin('write_project_asset', {
			filename: 'binary.exe',
			content: 'nope',
		});
		expect(String(badType.error)).toContain('text-based');

		const tooBig = await admin('write_project_asset', {
			filename: 'big.txt',
			content: 'x'.repeat(10 * 1024 * 1024 + 1),
		});
		expect(tooBig.error).toBe('Asset exceeds 10 MB.');

		const ok = await admin('write_project_asset', {
			filename: 'report.html',
			content: '<h1>Hello</h1>',
		});
		expect(ok.error).toBeUndefined();
		const row = await db.query(
			'SELECT id FROM assets WHERE project_id = $1 AND original_filename = $2',
			[projectId, 'report.html'],
		);
		expect(row.rows.length).toBe(1);
	});

	it('archive lifecycle gates writes and reads', async () => {
		await admin('write_project_asset', { filename: 'old.txt', content: 'old contents' });
		const archived = await admin('archive_project_asset', { filename: 'old.txt' });
		expect(archived.archived).toBe(true);
		expect(archived.changed).toBe(true);

		// Idempotent re-archive.
		const again = await admin('archive_project_asset', { filename: 'old.txt' });
		expect(again.changed).toBe(false);

		// Writing over an archived path is refused.
		const overwrite = await admin('write_project_asset', {
			filename: 'old.txt',
			content: 'new',
		});
		expect(String(overwrite.error)).toContain('archived');

		// Reading with the default filter refuses; filter archived allows.
		const blocked = await admin('read_project_asset', { filename: 'old.txt' });
		expect(String(blocked.error)).toContain('archived');
		const viaFilter = await admin('read_project_asset', {
			filename: 'old.txt',
			filter: 'archived',
		});
		expect(viaFilter.content).toBe('old contents');
		expect(viaFilter.archived).toBe(true);

		const restored = await admin('unarchive_project_asset', { filename: 'old.txt' });
		expect(restored.archived).toBe(false);
		expect(restored.changed).toBe(true);
	});

	it('read_project_asset covers missing, filter-mismatch, and binary branches', async () => {
		const missing = await admin('read_project_asset', { filename: 'ghost.txt' });
		expect(String(missing.error)).toContain('not found');

		await admin('write_project_asset', { filename: 'live.txt', content: 'live' });
		const mismatch = await admin('read_project_asset', {
			filename: 'live.txt',
			filter: 'archived',
		});
		expect(String(mismatch.error)).toContain("filter is 'archived'");

		// A binary asset comes back as a signed URL, not inline content.
		await db.query(
			`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename)
			 VALUES ($1, $2, $3, 'image/png', 4, 'abcd', 'pic.png')`,
			[crypto.randomUUID(), teamId, projectId],
		);
		const binary = (await admin('read_project_asset', { filename: 'pic.png' })) as {
			binary: boolean;
			url: string;
		};
		expect(binary.binary).toBe(true);
		expect(binary.url).toContain('/api/assets/');
	});

	it('move_project_asset renames and refuses collisions', async () => {
		await admin('write_project_asset', { filename: 'move-me.txt', content: 'mv' });
		await admin('write_project_asset', { filename: 'occupied.txt', content: 'here' });

		const samePath = await admin('move_project_asset', {
			from: 'move-me.txt',
			to: 'move-me.txt',
		});
		expect(samePath.error).toBe('Source and destination are the same path.');

		const badExt = await admin('move_project_asset', { from: 'move-me.txt', to: 'move-me.md' });
		expect(String(badExt.error)).toContain('extension');

		const missing = await admin('move_project_asset', { from: 'ghost.txt', to: 'g2.txt' });
		expect(String(missing.error)).toContain('not found');

		const collision = await admin('move_project_asset', {
			from: 'move-me.txt',
			to: 'occupied.txt',
		});
		expect(String(collision.error)).toContain('already exists');

		const moved = await admin('move_project_asset', {
			from: 'move-me.txt',
			to: 'archive/moved.txt',
		});
		expect(moved.error).toBeUndefined();
		const read = await admin('read_project_asset', { filename: 'archive/moved.txt' });
		expect(read.content).toBe('mv');
	});

	it('copy_project_asset copies and refuses bad sources/destinations', async () => {
		await admin('write_project_asset', { filename: 'src.txt', content: 'copy me' });

		const missing = await admin('copy_project_asset', { from: 'ghost.txt', to: 'g.txt' });
		expect(String(missing.error)).toContain('not found');

		await admin('write_project_asset', { filename: 'arch-src.txt', content: 'x' });
		await admin('archive_project_asset', { filename: 'arch-src.txt' });
		const archivedSrc = await admin('copy_project_asset', {
			from: 'arch-src.txt',
			to: 'y.txt',
		});
		expect(String(archivedSrc.error)).toContain('archived');

		const copied = await admin('copy_project_asset', { from: 'src.txt', to: 'dup.txt' });
		expect(copied.error).toBeUndefined();
		const read = await admin('read_project_asset', { filename: 'dup.txt' });
		expect(read.content).toBe('copy me');

		const collision = await admin('copy_project_asset', { from: 'src.txt', to: 'dup.txt' });
		expect(String(collision.error)).toContain('already exists');
	});

	it('list_project_assets filters by archive state', async () => {
		const all = (await admin('list_project_assets', { filter: 'all' })) as {
			files: Array<{ filename: string; archived: boolean }>;
		};
		expect(all.files.map((f) => f.filename)).toContain('arch-src.txt');
		const active = (await admin('list_project_assets', {})) as {
			files: Array<{ filename: string }>;
		};
		expect(active.files.map((f) => f.filename)).not.toContain('arch-src.txt');
		const archivedOnly = (await admin('list_project_assets', { filter: 'archived' })) as {
			files: Array<{ filename: string }>;
		};
		expect(archivedOnly.files.map((f) => f.filename)).toContain('arch-src.txt');
	});
});

describe('project docs', () => {
	it('write/read/archive lifecycle branches', async () => {
		const nonMd = await admin('write_project_doc', { filename: 'spec.txt', content: 'x' });
		expect(String(nonMd.error)).toContain('markdown');

		const wrote = await admin('write_project_doc', {
			filename: 'spec.md',
			content: '# Spec\n\nBody.',
		});
		expect(wrote.error).toBeUndefined();

		// Active doc read with filter archived errors.
		const mismatch = await admin('read_project_doc', { filename: 'spec.md', filter: 'archived' });
		expect(String(mismatch.error)).toContain("filter is 'archived'");

		const archived = await admin('archive_project_doc', { filename: 'spec.md' });
		expect(archived.archived).toBe(true);

		// An archived doc refuses writes.
		const writeArchived = await admin('write_project_doc', {
			filename: 'spec.md',
			content: 'new',
		});
		expect(String(writeArchived.error)).toContain('archived');

		// Default-filter read refuses; unarchive restores.
		const blocked = await admin('read_project_doc', { filename: 'spec.md' });
		expect(String(blocked.error)).toContain('archived');
		const restored = await admin('unarchive_project_doc', { filename: 'spec.md' });
		expect(restored.archived).toBe(false);
		const read = await admin('read_project_doc', { filename: 'spec.md' });
		expect(read.content).toContain('Body.');
	});

	it('list_project_docs returns the doc listing', async () => {
		const r = await admin('list_project_docs', {});
		expect(r.error).toBeUndefined();
	});
});

describe('skills', () => {
	it('list_skills / get_skill / create_skill branches', async () => {
		const created = await admin('create_skill', {
			name: 'Tagged Skill',
			slug: 'tagged-skill',
			content: '# Tagged\n\nBody one.',
			tags: 'infra, deploy',
		});
		expect(created.created).toBe(true);

		// Upsert path: same slug, new content records a revision.
		const updated = await admin('create_skill', {
			name: 'Tagged Skill',
			slug: 'tagged-skill',
			content: '# Tagged\n\nBody two.',
			description: 'A tagged skill.',
			tags: 'infra',
		});
		expect(updated.skill_id).toBe(created.skill_id);

		const all = (await admin('list_skills', {})) as { skills: Array<{ slug: string }> };
		expect(all.skills.map((s) => s.slug)).toContain('tagged-skill');

		const byTag = (await admin('list_skills', { tags: 'infra' })) as {
			skills: Array<{ slug: string }>;
		};
		expect(byTag.skills.map((s) => s.slug)).toContain('tagged-skill');
		const noMatch = (await admin('list_skills', { tags: 'zzz' })) as { skills: unknown[] };
		expect(noMatch.skills).toEqual([]);

		const got = (await admin('get_skill', { slug: 'tagged-skill' })) as { content: string };
		expect(got.content).toContain('Body two.');
		const missing = await admin('get_skill', { slug: 'no-such-skill' });
		expect(missing.error).toBe('Skill not found');
	});

	it('fetch_skill_file covers URL validation and fetch failure branches', async () => {
		const invalid = await admin('fetch_skill_file', { url: 'not a url' });
		expect(invalid.error).toBe('Invalid URL');

		const scheme = await admin('fetch_skill_file', { url: 'ftp://example.com/x.md' });
		expect(scheme.error).toBe('Only http/https URLs are allowed');

		const refused = await admin('fetch_skill_file', { url: `${closedPortUrl}/x.md` });
		expect(String(refused.error)).toContain('Fetch failed:');

		const notFound = await admin('fetch_skill_file', { url: `${httpUrl}/missing.md` });
		expect(notFound.error).toBe('Fetch failed: HTTP 404');

		const huge = await admin('fetch_skill_file', { url: `${httpUrl}/huge.md` });
		expect(huge.error).toBe('Response too large (>256KB)');

		// A chunked response has no content-length, so the size check happens
		// only after the body is read.
		const chunked = await admin('fetch_skill_file', { url: `${httpUrl}/chunked.md` });
		expect(chunked.error).toBe('Response too large (>256KB)');
	});

	it('fetch_skill_file stores and re-fetches a skill idempotently', async () => {
		const first = (await admin('fetch_skill_file', {
			url: `${httpUrl}/docs/agent-skill.md`,
			title: 'Agent Skill',
		})) as { skill_id: string; slug: string; reused: boolean };
		expect(first.skill_id).toBeDefined();
		expect(first.reused).toBe(false);
		expect(first.slug).toContain('agent-skill');

		const second = (await admin('fetch_skill_file', {
			url: `${httpUrl}/docs/agent-skill.md`,
		})) as { skill_id: string; reused: boolean };
		expect(second.skill_id).toBe(first.skill_id);
		expect(second.reused).toBe(true);

		const row = await db.query<{ auto_load: boolean }>(
			'SELECT auto_load FROM skills WHERE id = $1',
			[first.skill_id],
		);
		expect(row.rows[0].auto_load).toBe(true);
	});
});

describe('mcp connections', () => {
	it('add_mcp_connection validates config per kind and upserts', async () => {
		const saasNoUrl = await admin('add_mcp_connection', {
			name: 'bad-saas',
			kind: 'saas',
			config: {},
		});
		expect(saasNoUrl.error).toBe('saas connections require config.url (string)');

		const localNoCmd = await admin('add_mcp_connection', {
			name: 'bad-local',
			kind: 'local',
			config: {},
		});
		expect(localNoCmd.error).toBe('local connections require config.command (string)');

		const saas = await admin('add_mcp_connection', {
			name: 'probe-saas',
			kind: 'saas',
			config: { url: `${httpUrl}/mcp` },
		});
		expect(saas.install_status).toBe('installed');

		const local = await admin('add_mcp_connection', {
			name: 'probe-local',
			kind: 'local',
			config: { command: 'echo' },
		});
		expect(local.install_status).toBe('pending');

		// Upsert on name.
		const saasAgain = await admin('add_mcp_connection', {
			name: 'probe-saas',
			kind: 'saas',
			config: { url: `${httpUrl}/mcp2` },
		});
		expect(saasAgain.id).toBe(saas.id);
	});

	it('list_mcp_connections derives oauth_status', async () => {
		const r = (await admin('list_mcp_connections', {})) as unknown as Array<{
			name: string;
			kind: string;
			oauth_status: string;
		}>;
		const local = r.find((c) => c.name === 'probe-local');
		expect(local?.oauth_status).toBe('none');
		const saas = r.find((c) => c.name === 'probe-saas');
		expect(saas?.kind).toBe('saas');
	});

	it('test_connector covers not-found, non-saas, and missing-url branches', async () => {
		const missing = await admin('test_connector', { connector_id: crypto.randomUUID() });
		expect(missing.error).toBe('connector not found');

		const localRow = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-local'`,
		);
		const localTest = await admin('test_connector', { connector_id: localRow.rows[0].id });
		expect(String(localTest.error)).toContain('kind=local');

		const noUrl = await db.query<{ id: string }>(
			`INSERT INTO mcp_connections (name, kind, config, install_status)
			 VALUES ('no-url-saas', 'saas'::mcp_connection_kind, '{}'::jsonb, 'installed'::mcp_install_status)
			 RETURNING id`,
		);
		const noUrlTest = await admin('test_connector', { connector_id: noUrl.rows[0].id });
		expect(noUrlTest.error).toBe('connector has no mcp url');
	});

	it('test_connector probes upstream without a token (200 and 401 hints)', async () => {
		const saasRow = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-saas'`,
		);
		const ok = (await admin('test_connector', { connector_id: saasRow.rows[0].id })) as {
			ok: boolean;
			status: number;
			hint: string;
		};
		expect(ok.ok).toBe(true);
		expect(ok.hint).toContain('Token valid against upstream');

		await admin('add_mcp_connection', {
			name: 'probe-401',
			kind: 'saas',
			config: { url: `${http401Url}/mcp` },
		});
		const row401 = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-401'`,
		);
		const denied = (await admin('test_connector', { connector_id: row401.rows[0].id })) as {
			ok: boolean;
			status: number;
			hint: string;
			www_authenticate: string | null;
		};
		expect(denied.status).toBe(401);
		expect(denied.hint).toContain('No token sent');
		expect(denied.www_authenticate).toContain('Bearer');

		await admin('add_mcp_connection', {
			name: 'probe-down',
			kind: 'saas',
			config: { url: `${closedPortUrl}/mcp` },
		});
		const downRow = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-down'`,
		);
		const down = (await admin('test_connector', { connector_id: downRow.rows[0].id })) as {
			ok: boolean;
			error: string;
		};
		expect(down.ok).toBe(false);
		expect(down.error).toContain('network probe failed');

		// A non-401 upstream failure yields the generic status hint.
		await admin('add_mcp_connection', {
			name: 'probe-500',
			kind: 'saas',
			config: { url: `${httpUrl}/boom` },
		});
		const row500 = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-500'`,
		);
		const boom = (await admin('test_connector', { connector_id: row500.rows[0].id })) as {
			ok: boolean;
			status: number;
			hint: string;
		};
		expect(boom.ok).toBe(false);
		expect(boom.status).toBe(500);
		expect(boom.hint).toContain('Upstream returned 500');
	});

	it('test_connector decrypts and sends an OAuth token', async () => {
		const key = masterKeyManager.getKey();
		expect(key).not.toBeNull();
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, allowed_hosts)
			 VALUES ('PROBE_OAUTH_TOKEN', $1, '{127.0.0.1}') RETURNING id`,
			[encrypt('tok-secret-value-123', key!)],
		);
		const oauth = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id, scopes)
			 VALUES ('probe', 'acct-1', 'Probe Account', $1, '{read}') RETURNING id`,
			[secret.rows[0].id],
		);
		await admin('add_mcp_connection', {
			name: 'probe-oauth',
			kind: 'saas',
			config: { url: `${http401Url}/mcp` },
		});
		await db.query(
			`UPDATE mcp_connections SET oauth_connection_id = $1 WHERE name = 'probe-oauth'`,
			[oauth.rows[0].id],
		);
		const row = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-oauth'`,
		);
		const r = (await admin('test_connector', { connector_id: row.rows[0].id })) as {
			status: number;
			secret_name: string;
			token_prefix: string;
			token_length: number;
			hint: string;
		};
		expect(r.status).toBe(401);
		expect(r.secret_name).toBe('PROBE_OAUTH_TOKEN');
		expect(r.token_prefix).toBe('tok-secr');
		expect(r.token_length).toBe('tok-secret-value-123'.length);
		expect(r.hint).toContain('Token rejected by upstream');
	});

	it('remove_mcp_connection deletes or errors', async () => {
		const gone = await admin('remove_mcp_connection', { id: crypto.randomUUID() });
		expect(gone.error).toBe('MCP connection not found');

		const row = await db.query<{ id: string }>(
			`SELECT id FROM mcp_connections WHERE name = 'probe-down'`,
		);
		const removed = await admin('remove_mcp_connection', { id: row.rows[0].id });
		expect(removed.removed).toBe(true);
		const check = await db.query(`SELECT id FROM mcp_connections WHERE name = 'probe-down'`);
		expect(check.rows.length).toBe(0);
	});
});

describe('register_connector', () => {
	it('creates a pending connector, posts a connect comment, and is idempotent', async () => {
		const { token: at } = await mintAgentToken(db, masterKeyManager, captainId, teamId, taskId);
		const args = {
			task_id: taskId,
			display_name: 'Cov Connector',
			mcp_url: `${httpUrl}/mcp`,
			mcp_transport: 'http' as const,
		};
		const first = (await call(at, 'register_connector', args)) as {
			connector_id: string;
			status: string;
			comment_id: string;
		};
		expect(first.status).toBe('pending');
		expect(first.comment_id).toBeDefined();

		const comment = await db.query<{ content: Record<string, unknown> }>(
			'SELECT content FROM task_comments WHERE id = $1',
			[first.comment_id],
		);
		expect(comment.rows[0].content.connector_id).toBe(first.connector_id);

		const second = (await call(at, 'register_connector', args)) as {
			connector_id: string;
			comment_id: string;
		};
		expect(second.connector_id).toBe(first.connector_id);
		expect(second.comment_id).toBe(first.comment_id);
	});

	it('rejects a display name that produces an empty slug', async () => {
		const { token: at } = await mintAgentToken(db, masterKeyManager, captainId, teamId, taskId);
		const r = await call(at, 'register_connector', {
			task_id: taskId,
			display_name: '!!!',
			mcp_url: `${httpUrl}/mcp`,
		});
		expect(r.error).toBe('display_name produced an empty slug');
	});

	it('an already-active connector short-circuits without a comment', async () => {
		const { token: at } = await mintAgentToken(db, masterKeyManager, captainId, teamId, taskId);
		const first = (await call(at, 'register_connector', {
			task_id: taskId,
			display_name: 'Active Connector',
			mcp_url: `${httpUrl}/mcp`,
		})) as { connector_id: string };
		// `active` requires both an oauth connection and an activation stamp.
		const key = masterKeyManager.getKey();
		const secret = await db.query<{ id: string }>(
			`INSERT INTO secrets (name, encrypted_value, allowed_hosts)
			 VALUES ('ACTIVE_CONN_TOKEN', $1, '{127.0.0.1}') RETURNING id`,
			[encrypt('tok-active', key!)],
		);
		const oauth = await db.query<{ id: string }>(
			`INSERT INTO oauth_connections (provider, provider_account_id, provider_account_label, access_token_secret_id)
			 VALUES ('active-conn', 'acct-2', 'Active Account', $1) RETURNING id`,
			[secret.rows[0].id],
		);
		await db.query(
			`UPDATE mcp_connections SET activated_at = now(), oauth_connection_id = $2 WHERE id = $1`,
			[first.connector_id, oauth.rows[0].id],
		);
		const again = (await call(at, 'register_connector', {
			task_id: taskId,
			display_name: 'Active Connector',
			mcp_url: `${httpUrl}/mcp`,
		})) as { status: string; reused: boolean };
		expect(again.status).toBe('active');
		expect(again.reused).toBe(true);
	});
});
