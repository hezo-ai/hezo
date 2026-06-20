import type { PGlite } from '@electric-sql/pglite';
import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapEventToAudit } from '../src/events/audit-observer';
import { waitForBackground } from '../src/lib/background';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Events Co' });
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

	it('records an instance secret creation with a null team', async () => {
		const res = await app.request('/api/secrets', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'OBSERVED_KEY', value: 'shhh' }),
		});
		expect(res.status).toBe(201);

		const rows = await auditRows({ entityType: 'secret', action: 'created' });
		const entry = rows.find((e) => (e.details as Record<string, unknown>)?.name === 'OBSERVED_KEY');
		expect(entry).toBeDefined();
		expect(entry?.team_id).toBeNull();
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
		expect(typeof entry?.team_slug).toBe('string');
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
});
