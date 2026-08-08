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

// The wake receipt is the structural half of the mention safeguards: every
// comment write reports who it ACTUALLY woke and who it merely named. Unlike the
// warning builders it runs no ask heuristic, so it stays true for phrasings no
// detector recognises — which is the whole point, since the ways to ask someone
// to do something are unbounded while the fan-out is a fact.

interface WakeReceipt {
	woke: string[];
	named_not_woken: string[];
}

describe('comment wake receipt', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;

	let teamId: string;
	let projectId: string;
	let projectSlug: string;
	let captainId: string;
	let architectId: string;

	async function insertTask(assigneeId: string, title: string): Promise<string> {
		const meta = await db.query<{ task_prefix: string; number: number }>(
			`SELECT p.task_prefix, next_project_task_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const n = meta.rows[0].number;
		const res = await db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, assignee_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId, assigneeId, n, `${meta.rows[0].task_prefix}-${n}`, title],
		);
		return res.rows[0].id;
	}

	async function createComment(
		agentToken: string,
		args: Record<string, unknown>,
	): Promise<{ id: string; wake: WakeReceipt; warning?: string }> {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'create_comment', arguments: args },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text);
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'App Team',
		).id;

		const teamRes = await createTestTeam(db, { name: 'Receipt Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;

		const projectData = (await (await createTestProject(db, teamId, { name: 'Project' })).json())
			.data;
		projectId = projectData.id;
		projectSlug = projectData.slug;

		const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		captainId = agents.find((a) => a.slug === 'captain')!.id;
		architectId = agents.find((a) => a.slug === 'architect')!.id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('reports an active mention as woken', async () => {
		const taskId = await insertTask(captainId, 'Active mention');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const r = await createComment(agentToken, {
			project: projectSlug,
			task_id: taskId,
			content: '@architect - please re-check the schema.',
		});
		expect(r.wake.woke).toEqual(['architect']);
		expect(r.wake.named_not_woken).toEqual([]);
	});

	it('reports a passive mention as named but NOT woken', async () => {
		const taskId = await insertTask(captainId, 'Passive mention');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		// The incident shape: an unmistakable ask carried on the form that wakes
		// nobody. The receipt states the outcome without judging the prose.
		const r = await createComment(agentToken, {
			project: projectSlug,
			task_id: taskId,
			content: 'Verified and cleared. @@architect — please mark this done.',
		});
		expect(r.wake.woke).toEqual([]);
		expect(r.wake.named_not_woken).toEqual(['architect']);
	});

	it('reports the admin fan-out as a wake', async () => {
		const taskId = await insertTask(captainId, 'Admin ask');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const r = await createComment(agentToken, {
			project: projectSlug,
			task_id: taskId,
			content: '@admin - which vendor should we use?',
		});
		expect(r.wake.woke).toContain('admin');
	});

	it('separates the woken from the merely named in one comment', async () => {
		const taskId = await insertTask(captainId, 'Mixed');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const r = await createComment(agentToken, {
			project: projectSlug,
			task_id: taskId,
			content: '@architect - please review.\n\nCredit to @@qa-engineer for the repro.',
		});
		expect(r.wake.woke).toEqual(['architect']);
		expect(r.wake.named_not_woken).toEqual(['qa-engineer']);
	});

	it('reports a reply as a wake even with no mention text', async () => {
		const taskId = await insertTask(architectId, 'Reply wake');
		const { token: architectToken } = await mintAgentToken(
			db,
			masterKeyManager,
			architectId,
			teamId,
			taskId,
		);
		const parent = await createComment(architectToken, {
			project: projectSlug,
			task_id: taskId,
			content: 'Which schema version are we targeting?',
		});
		const { token: captainToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const reply = await createComment(captainToken, {
			project: projectSlug,
			task_id: taskId,
			content: 'v3, the one behind the flag.',
			parent_comment_id: parent.id,
		});
		expect(reply.wake.woke).toEqual(['architect']);
	});

	it('ships the receipt on a plain comment that addresses no one', async () => {
		const taskId = await insertTask(captainId, 'No addressee');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const r = await createComment(agentToken, {
			project: projectSlug,
			task_id: taskId,
			content: 'Rebuilt the index and re-ran the import. No errors.',
		});
		// Always present, so an agent can rely on reading it rather than on a
		// warning happening to fire.
		expect(r.wake).toEqual({ woke: [], named_not_woken: [] });
	});

	it('counts a bare-name address as named-not-woken', async () => {
		const taskId = await insertTask(captainId, 'Bare name');
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			taskId,
		);
		const r = await createComment(agentToken, {
			project: projectSlug,
			task_id: taskId,
			content: '**architect** — please confirm the migration order.',
		});
		expect(r.wake.woke).toEqual([]);
		expect(r.wake.named_not_woken).toEqual(['architect']);
	});
});
