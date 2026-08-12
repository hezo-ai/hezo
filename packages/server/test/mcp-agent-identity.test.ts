import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, mintAgentToken } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectSlug: string;
let captainId: string;
let engineerId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const res = await app.request('/api/projects', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Identity Tools Co',
			description: 'Build the app.',
			marketplace_slug: 'software-development',
		}),
	});
	const project = (await res.json()).data as { slug: string; team_id: string };
	projectSlug = project.slug;
	teamId = project.team_id;

	const agents = await db.query<{ id: string; slug: string }>(
		`SELECT ma.id, ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug IN ($2, 'engineer')`,
		[teamId, CAPTAIN_AGENT_SLUG],
	);
	captainId = agents.rows.find((a) => a.slug === CAPTAIN_AGENT_SLUG)!.id;
	engineerId = agents.rows.find((a) => a.slug === 'engineer')!.id;
});

afterAll(async () => {
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
	if (body.error) return { error: body.error.message };
	const text = body.result?.content?.[0]?.text ?? '{}';
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { error: text };
	}
}

async function nameOf(slug: string): Promise<string | null> {
	const r = await db.query<{ human_name: string | null }>(
		`SELECT ma.human_name FROM member_agents ma JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $2`,
		[teamId, slug],
	);
	return r.rows[0]?.human_name ?? null;
}

/**
 * The setup pass is what gives a bespoke hire a name and a face, and it runs as
 * the Captain or the CEO. These tools are how it does that, so the rules that
 * protect mention handles have to hold when an agent is the caller, not only
 * when the admin is.
 */
describe('set_agent_name', () => {
	it('lets the Captain name a teammate', async () => {
		const t = await mintAgentToken(db, masterKeyManager, captainId, teamId);
		const r = await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: 'qa-engineer',
			name: 'Wren',
		});
		expect(r).toMatchObject({ updated: true, name: 'Wren' });
		expect(await nameOf('qa-engineer')).toBe('Wren');
	});

	it('clears a name with an empty string', async () => {
		const t = await mintAgentToken(db, masterKeyManager, captainId, teamId);
		const r = await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: 'qa-engineer',
			name: '',
		});
		expect(r).toMatchObject({ updated: true, name: null });
		expect(await nameOf('qa-engineer')).toBeNull();
	});

	it('refuses a name another teammate already answers to', async () => {
		const t = await mintAgentToken(db, masterKeyManager, captainId, teamId);
		// Nobody arrives named, so the collision has to be created first.
		await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: 'engineer',
			name: 'Max',
		});
		const r = await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: 'qa-engineer',
			name: 'Max',
		});
		expect(String(r.error)).toContain('already taken');
	});

	it('refuses to name the Captain', async () => {
		const t = await mintAgentToken(db, masterKeyManager, captainId, teamId);
		const r = await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: CAPTAIN_AGENT_SLUG,
			name: 'Skip',
		});
		expect(String(r.error)).toContain('role');
	});

	it('is refused to an agent that does not coordinate the team', async () => {
		const t = await mintAgentToken(db, masterKeyManager, engineerId, teamId);
		const r = await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: 'qa-engineer',
			name: 'Nope',
		});
		expect(String(r.error)).toContain('Captain');
	});

	it('errors on an unknown agent', async () => {
		const t = await mintAgentToken(db, masterKeyManager, captainId, teamId);
		const r = await call(t.token, 'set_agent_name', {
			project: projectSlug,
			agent_id: 'no-such-agent',
			name: 'Ghost',
		});
		expect(String(r.error)).toContain('not found');
	});
});

describe('generate_agent_avatar', () => {
	it('gives the agent a different face, keeping the outfit tied to its role', async () => {
		const before = await db.query<{ avatar_spec: { seed: string; style: string } }>(
			`SELECT ma.avatar_spec FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'ui-designer'`,
			[teamId],
		);
		const t = await mintAgentToken(db, masterKeyManager, captainId, teamId);
		const r = await call(t.token, 'generate_agent_avatar', {
			project: projectSlug,
			agent_id: 'ui-designer',
		});
		expect(r).toMatchObject({ updated: true });

		const after = await db.query<{ avatar_spec: { seed: string; style: string } }>(
			`SELECT ma.avatar_spec FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'ui-designer'`,
			[teamId],
		);
		expect(after.rows[0].avatar_spec.seed).not.toBe(before.rows[0].avatar_spec.seed);
		expect(after.rows[0].avatar_spec.style).toBe('design');
	});
});
