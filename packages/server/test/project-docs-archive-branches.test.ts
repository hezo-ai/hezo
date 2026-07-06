import { DocumentStatus } from '@hezo/shared';
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
	mintAgentToken,
} from './helpers/app';

// The PATCH validation / archive lifecycle branches of the project-docs routes:
// exactly-one-field enforcement, archived read-only conflicts (PUT / status /
// restore), un-archive, and the agent DELETE ban.

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;

function docReq(filename: string, init?: RequestInit & { body?: string }) {
	return app.request(`/api/projects/${projectId}/docs/${filename}`, {
		...init,
		headers: { ...authHeader(token), 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
	});
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Docs Archive Co' });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Docs Archive Project' });
	projectId = (await projectRes.json()).data.id;

	const created = await docReq('guide.md', {
		method: 'PUT',
		body: JSON.stringify({ content: '# Guide\n\nOriginal content.' }),
	});
	expect(created.status).toBe(200);
});

afterAll(async () => {
	await safeClose(db);
});

describe('PATCH field validation', () => {
	it('400s when both status and archived are provided', async () => {
		const res = await docReq('guide.md', {
			method: 'PATCH',
			body: JSON.stringify({ status: DocumentStatus.Approved, archived: true }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/exactly one/i);
	});

	it('400s when neither status nor archived is provided', async () => {
		const res = await docReq('guide.md', { method: 'PATCH', body: JSON.stringify({}) });
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/exactly one/i);
	});

	it('400s when archived is not a boolean', async () => {
		const res = await docReq('guide.md', {
			method: 'PATCH',
			body: JSON.stringify({ archived: 'yes' }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message).toMatch(/boolean/);
	});

	it('404s when archiving a doc that does not exist', async () => {
		const res = await docReq('missing.md', {
			method: 'PATCH',
			body: JSON.stringify({ archived: true }),
		});
		expect(res.status).toBe(404);
	});
});

describe('archived docs are read-only until restored', () => {
	it('archives the doc via PATCH', async () => {
		const res = await docReq('guide.md', {
			method: 'PATCH',
			body: JSON.stringify({ archived: true }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.data.archived_at).not.toBeNull();
		expect(body.data.filename).toBe('guide.md');
	});

	it('409s a PUT against the archived doc (no silent resurrection)', async () => {
		const res = await docReq('guide.md', {
			method: 'PUT',
			body: JSON.stringify({ content: 'sneaky edit' }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
		// Content untouched.
		const read = await docReq('guide.md');
		expect((await read.json()).data.content).toBe('# Guide\n\nOriginal content.');
	});

	it('409s a status flip on the archived doc', async () => {
		const res = await docReq('guide.md', {
			method: 'PATCH',
			body: JSON.stringify({ status: DocumentStatus.Approved }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
	});

	it('409s a revision restore on the archived doc', async () => {
		const res = await app.request(`/api/projects/${projectId}/docs/guide.md/restore`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ revision_number: 1 }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).error.code).toBe('CONFLICT');
	});

	it('un-archives via PATCH and becomes editable again', async () => {
		const res = await docReq('guide.md', {
			method: 'PATCH',
			body: JSON.stringify({ archived: false }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).data.archived_at).toBeNull();

		const edit = await docReq('guide.md', {
			method: 'PUT',
			body: JSON.stringify({ content: '# Guide\n\nEdited after restore.' }),
		});
		expect(edit.status).toBe(200);
		expect((await edit.json()).data.content).toBe('# Guide\n\nEdited after restore.');
	});
});

describe('DELETE /docs/:filename', () => {
	it('403s an agent (agents archive, only the admin deletes)', async () => {
		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'captain' LIMIT 1`,
			[teamId],
		);
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			teamId,
			null,
			{ projectId },
		);

		const res = await app.request(`/api/projects/${projectId}/docs/guide.md`, {
			method: 'DELETE',
			headers: authHeader(agentToken),
		});
		expect(res.status).toBe(403);
		expect((await res.json()).error.message).toMatch(/archive instead/);

		// Still there.
		const read = await docReq('guide.md');
		expect(read.status).toBe(200);
	});
});
