import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { mapEventToAudit } from '../src/events/audit-observer';
import { DomainEventBus } from '../src/events/bus';
import type { DomainEvent } from '../src/events/types';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { emitTaskUpdateEvents } from '../src/services/task-events';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let masterKeyManager: MasterKeyManager;
let teamId: string;
let projectId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const teamRes = await createTestTeam(db, { name: 'Events Co', marketplace_slug: 'app-dev' });
	teamId = (await teamRes.json()).data.id;

	const project = await createTestProject(db, teamId, { name: 'Events Project' });
	const projectData = (await project.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;
});

afterAll(async () => {
	await safeClose(db);
});

/** The observer writes via trackBackground; drain it before asserting. */
async function auditRows(filter: { entityType?: string; action?: string } = {}) {
	await waitForBackground();
	const params = new URLSearchParams();
	if (filter.entityType) params.set('entity_type', filter.entityType);
	if (filter.action) params.set('action', filter.action);
	const res = await app.request(`/api/audit-log?${params.toString()}`, {
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
	return (await res.json()).data as Array<Record<string, unknown>>;
}

async function callAgentTool(
	agentToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

describe('audit observer (end-to-end)', () => {
	it('records task creation with project scope', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Audited task',
				assignee_slug: CAPTAIN_AGENT_SLUG,
			}),
		});
		expect(res.status).toBe(201);
		const taskId = (await res.json()).data.id;

		const rows = await auditRows({ entityType: 'task', action: 'created' });
		const entry = rows.find((e) => e.entity_id === taskId);
		expect(entry).toBeDefined();
		expect(entry?.project_id).toBe(projectId);
		expect(entry?.actor_type).toBe('admin');
	});

	it('records an instance secret creation with no project scope', async () => {
		const res = await app.request('/api/secrets', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'OBSERVED_KEY', value: 'shhh' }),
		});
		expect(res.status).toBe(201);

		const rows = await auditRows({ entityType: 'secret', action: 'created' });
		const entry = rows.find((e) => (e.details as Record<string, unknown>)?.name === 'OBSERVED_KEY');
		expect(entry).toBeDefined();
		expect(entry?.project_id).toBeNull();
		expect(entry?.actor_type).toBe('admin');
	});

	it('records an instance skill creation', async () => {
		const res = await app.request('/api/skills', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Observed Skill', content: '# hi' }),
		});
		expect(res.status).toBe(201);

		const rows = await auditRows({ entityType: 'skill', action: 'created' });
		expect(rows.length).toBeGreaterThanOrEqual(1);
	});

	it('resolves navigational slugs + the task identifier for task rows', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Linkable task',
				assignee_slug: CAPTAIN_AGENT_SLUG,
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()).data as { id: string; identifier: string };

		const rows = await auditRows({ entityType: 'task', action: 'created' });
		const entry = rows.find((e) => e.entity_id === created.id);
		expect(entry).toBeDefined();
		expect(entry?.entity_identifier).toBe(created.identifier);
		expect(typeof entry?.project_slug).toBe('string');
	});

	it('records a status change with the field and resolves the task identifier', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Status task',
				assignee_slug: CAPTAIN_AGENT_SLUG,
			}),
		});
		const created = (await res.json()).data as { id: string; identifier: string };

		const patch = await app.request(`/api/projects/${projectSlug}/tasks/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'in_progress' }),
		});
		expect(patch.status).toBe(200);

		const rows = await auditRows({ entityType: 'task', action: 'updated' });
		const entry = rows.find(
			(e) =>
				e.entity_id === created.id && (e.details as Record<string, unknown>).field === 'status',
		);
		expect(entry).toBeDefined();
		const details = entry?.details as Record<string, unknown>;
		expect(details.to).toBe('in_progress');
		expect(entry?.entity_identifier).toBe(created.identifier);
	});

	it('records a description change without copying the bodies into the row', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Description task',
				description: 'The original body.',
				assignee_slug: CAPTAIN_AGENT_SLUG,
			}),
		});
		const created = (await res.json()).data as { id: string; identifier: string };

		const patch = await app.request(`/api/projects/${projectSlug}/tasks/${created.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ description: 'A rewritten body.' }),
		});
		expect(patch.status).toBe(200);

		const rows = await auditRows({ entityType: 'task', action: 'updated' });
		const entry = rows.find(
			(e) =>
				e.entity_id === created.id &&
				(e.details as Record<string, unknown>).field === 'description',
		);
		expect(entry).toBeDefined();
		const details = entry?.details as Record<string, unknown>;
		// A description has no size ceiling, so neither end reaches the audit row.
		expect(details.from).toBeNull();
		expect(details.to).toBeNull();
		expect(JSON.stringify(details)).not.toContain('rewritten body');
	});

	it('records every supported agent-side task mutation with the agent actor', async () => {
		const agents = await db.query<{
			id: string;
			slug: string;
			title: string;
			reports_to: string | null;
		}>(
			`SELECT ma.id, ma.slug, ma.title, ma.reports_to
			   FROM member_agents ma JOIN members m ON m.id = ma.id
			  WHERE m.team_id = $1`,
			[teamId],
		);
		const captain = agents.rows.find((agent) => agent.slug === CAPTAIN_AGENT_SLUG);
		expect(captain).toBeDefined();
		const subordinate = agents.rows.find((agent) => agent.reports_to === captain?.id);
		expect(subordinate).toBeDefined();

		const parentRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Audit parent', assignee_id: captain?.id }),
		});
		const parent = (await parentRes.json()).data as { id: string; identifier: string };
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Agent audit task',
				description: 'Original description',
				assignee_id: captain?.id,
			}),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain?.id as string,
			teamId,
			task.id,
		);

		const updated = await callAgentTool(agentToken, 'update_task', {
			project: projectSlug,
			task_id: task.identifier,
			title: 'Agent-renamed task',
			description: 'Rewritten by the agent',
			status: 'in_progress',
			priority: 'high',
			assignee_id: subordinate?.id,
			progress_summary: 'Implementation is underway.',
			rules: 'Run focused tests before committing.',
			branch_name: 'hezo/HM-audit',
			runtime_type: 'codex',
			parent_task_id: parent.identifier,
		});
		expect(updated.error).toBeUndefined();

		await waitForBackground();
		const result = await db.query<{
			actor_type: string;
			actor_member_id: string | null;
			details: Record<string, unknown>;
		}>(
			`SELECT actor_type, actor_member_id, details
			   FROM audit_log
			  WHERE entity_type = 'task' AND action = 'updated' AND entity_id = $1
			  ORDER BY created_at`,
			[task.id],
		);
		const byField = new Map(result.rows.map((row) => [row.details.field, row]));
		expect(result.rows).toHaveLength(10);
		expect(new Set(byField.keys())).toEqual(
			new Set([
				'title',
				'description',
				'status',
				'priority',
				'assignee',
				'progress_summary',
				'rules',
				'branch',
				'runtime',
				'parent',
			]),
		);
		for (const row of result.rows) {
			expect(row.actor_type).toBe('agent');
			expect(row.actor_member_id).toBe(captain?.id);
		}
		expect(byField.get('title')?.details).toMatchObject({
			from: 'Agent audit task',
			to: 'Agent-renamed task',
		});
		expect(byField.get('description')?.details).toMatchObject({ from: null, to: null });
		expect(byField.get('status')?.details).toMatchObject({ from: 'backlog', to: 'in_progress' });
		expect(byField.get('priority')?.details).toMatchObject({ from: 'medium', to: 'high' });
		expect(byField.get('assignee')?.details).toMatchObject({
			from: captain?.id,
			to: subordinate?.id,
			from_label: captain?.title,
			to_label: subordinate?.title,
		});
		expect(byField.get('progress_summary')?.details).toMatchObject({ from: null, to: null });
		expect(byField.get('rules')?.details).toMatchObject({ from: null, to: null });
		expect(byField.get('branch')?.details).toMatchObject({ from: null, to: 'hezo/HM-audit' });
		expect(byField.get('runtime')?.details).toMatchObject({ from: null, to: 'codex' });
		expect(byField.get('parent')?.details).toMatchObject({
			from: null,
			to: parent.id,
			to_label: parent.identifier,
		});

		const unchanged = await callAgentTool(agentToken, 'update_task', {
			project: projectSlug,
			task_id: task.identifier,
			title: 'Agent-renamed task',
			description: 'Rewritten by the agent',
			status: 'in_progress',
			priority: 'high',
			assignee_id: subordinate?.id,
			progress_summary: 'Implementation is underway.',
			rules: 'Run focused tests before committing.',
			branch_name: 'hezo/HM-audit',
			runtime_type: 'codex',
			parent_task_id: parent.identifier,
		});
		expect(unchanged.error).toBeUndefined();
		await waitForBackground();
		const unchangedCount = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM audit_log
			  WHERE entity_type = 'task' AND action = 'updated' AND entity_id = $1`,
			[task.id],
		);
		expect(unchangedCount.rows[0].count).toBe(10);

		const cleared = await callAgentTool(agentToken, 'update_task', {
			project: projectSlug,
			task_id: task.identifier,
			description: '',
			progress_summary: '',
			rules: '',
			branch_name: '',
			runtime_type: '',
			parent_task_id: null,
		});
		expect(cleared.error).toBeUndefined();
		await waitForBackground();
		const afterClear = await db.query<{ details: Record<string, unknown> }>(
			`SELECT details FROM audit_log
			  WHERE entity_type = 'task' AND action = 'updated' AND entity_id = $1
			  ORDER BY created_at`,
			[task.id],
		);
		expect(afterClear.rows).toHaveLength(16);
		const clearRows = afterClear.rows.slice(10).map((row) => row.details);
		expect(new Set(clearRows.map((row) => row.field))).toEqual(
			new Set(['description', 'progress_summary', 'rules', 'branch', 'runtime', 'parent']),
		);
		expect(clearRows.find((row) => row.field === 'description')).toMatchObject({
			from: null,
			to: null,
		});
		expect(clearRows.find((row) => row.field === 'runtime')).toMatchObject({
			from: 'codex',
			to: null,
		});
		expect(clearRows.find((row) => row.field === 'parent')).toMatchObject({
			from: parent.id,
			to: null,
			from_label: parent.identifier,
		});
	});

	it('does not attribute an interleaved field change to the agent update', async () => {
		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			  JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[CAPTAIN_AGENT_SLUG, teamId],
		);
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Before interleaving', assignee_id: captain.rows[0].id }),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			teamId,
			task.id,
		);

		const originalQuery = db.query.bind(db);
		const originalTransaction = db.transaction.bind(db);
		let interleaved = false;
		const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(async (fn) => {
			if (!interleaved) {
				interleaved = true;
				await originalQuery("UPDATE tasks SET title = 'Concurrent rename' WHERE id = $1", [
					task.id,
				]);
			}
			return originalTransaction(fn);
		});
		try {
			const updated = await callAgentTool(agentToken, 'update_task', {
				project: projectSlug,
				task_id: task.identifier,
				priority: 'high',
			});
			expect(updated.error).toBeUndefined();
		} finally {
			transactionSpy.mockRestore();
		}
		const persisted = await db.query<{ title: string; priority: string }>(
			'SELECT title, priority FROM tasks WHERE id = $1',
			[task.id],
		);
		expect(persisted.rows[0]).toMatchObject({ title: 'Concurrent rename', priority: 'high' });

		await waitForBackground();
		const rows = await db.query<{ details: Record<string, unknown> }>(
			`SELECT details FROM audit_log
			  WHERE entity_type = 'task' AND action = 'updated' AND entity_id = $1`,
			[task.id],
		);
		expect(rows.rows.map((row) => row.details.field)).toEqual(['priority']);
	});

	it('revalidates terminal status under the task update lock before an agent reopens it', async () => {
		const captain = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			  JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1 AND m.team_id = $2`,
			[CAPTAIN_AGENT_SLUG, teamId],
		);
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Concurrent close', assignee_id: captain.rows[0].id }),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			teamId,
			task.id,
		);

		const originalQuery = db.query.bind(db);
		const originalTransaction = db.transaction.bind(db);
		let interleaved = false;
		const interleaveClose = async () => {
			if (interleaved) return;
			interleaved = true;
			await originalQuery("UPDATE tasks SET status = 'done' WHERE id = $1", [task.id]);
		};
		const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(async (fn) => {
			await interleaveClose();
			return originalTransaction(fn);
		});
		const querySpy = vi.spyOn(db, 'query').mockImplementation(async (sql, params) => {
			const result = await originalQuery(sql, params);
			if (
				!interleaved &&
				typeof sql === 'string' &&
				sql.includes('SELECT title, description, status, priority') &&
				params?.[0] === task.id
			) {
				await interleaveClose();
			}
			return result;
		});
		try {
			const updated = await callAgentTool(agentToken, 'update_task', {
				project: projectSlug,
				task_id: task.identifier,
				status: 'in_progress',
			});
			expect(updated.error).toBe('Only the admin can re-open a completed task');
		} finally {
			querySpy.mockRestore();
			transactionSpy.mockRestore();
		}

		const persisted = await db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [
			task.id,
		]);
		expect(persisted.rows[0].status).toBe('done');
		const statusComments = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM task_comments
			  WHERE task_id = $1 AND content_type = 'system'
			    AND content->>'kind' = 'status_change'`,
			[task.id],
		);
		expect(statusComments.rows[0].count).toBe(0);
	});

	it('treats clearing an already-null branch as an unchanged agent update', async () => {
		const captain = await db.query<{ id: string }>(
			'SELECT id FROM member_agents WHERE slug = $1 LIMIT 1',
			[CAPTAIN_AGENT_SLUG],
		);
		const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'No branch', assignee_id: captain.rows[0].id }),
		});
		const task = (await taskRes.json()).data as { id: string; identifier: string };
		const { token: agentToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captain.rows[0].id,
			teamId,
			task.id,
		);

		const before = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM audit_log
			  WHERE entity_type = 'task' AND action = 'updated' AND entity_id = $1`,
			[task.id],
		);
		const result = await callAgentTool(agentToken, 'update_task', {
			project: projectSlug,
			task_id: task.identifier,
			branch_name: '',
		});
		expect(result.error).toBeUndefined();
		await waitForBackground();
		const after = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM audit_log
			  WHERE entity_type = 'task' AND action = 'updated' AND entity_id = $1`,
			[task.id],
		);
		expect(after.rows[0].count).toBe(before.rows[0].count);
	});

	it('folds resolved assignee display names into the audit details', () => {
		const input = mapEventToAudit({
			type: 'task.updated',
			teamId,
			projectId,
			actorType: 'admin',
			actorMemberId: null,
			taskId: 'task-uuid',
			field: 'assignee',
			from: 'member-a',
			to: 'member-b',
			fromLabel: 'Bob',
			toLabel: 'Alice',
		});
		expect(input).not.toBeNull();
		expect(input?.details).toMatchObject({
			field: 'assignee',
			from_label: 'Bob',
			to_label: 'Alice',
		});
	});

	it('keeps unresolved assignee and parent ids as truthful audit label fallbacks', async () => {
		const missingMemberId = '00000000-0000-4000-8000-000000000091';
		const missingTaskId = '00000000-0000-4000-8000-000000000092';
		const emitted: DomainEvent[] = [];
		const events = new DomainEventBus();
		events.subscribe((event) => emitted.push(event));
		const before = {
			title: 'Before',
			description: null,
			status: 'backlog',
			priority: 'medium',
			assignee_id: missingMemberId,
			progress_summary: null,
			rules: null,
			branch_name: null,
			runtime_type: null,
			parent_task_id: missingTaskId,
		};
		await emitTaskUpdateEvents(
			db,
			events,
			{
				teamId,
				projectId,
				actorType: 'admin',
				actorMemberId: null,
				actorApiKeyId: null,
				taskId: '00000000-0000-4000-8000-000000000093',
			},
			before,
			{ ...before, assignee_id: null, parent_task_id: null },
		);
		expect(emitted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'assignee', fromLabel: missingMemberId }),
				expect.objectContaining({ field: 'parent', fromLabel: missingTaskId }),
			]),
		);
	});
});
