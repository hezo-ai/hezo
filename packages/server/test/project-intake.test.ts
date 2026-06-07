import type { PGlite } from '@electric-sql/pglite';
import { TaskStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/lib/types';
import { PROJECT_INTAKE_MARKER } from '../src/services/project-intake';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams');
});

afterAll(async () => {
	await safeClose(db);
});

async function createBlankTeam(name: string): Promise<{ slug: string; id: string }> {
	const blank = await db.query<{ id: string }>(
		"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
	);
	const res = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, template_id: blank.rows[0].id }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data as { slug: string; id: string };
}

interface IntakeResponse {
	intake_task_id: string;
	intake_task_identifier: string;
	project_slug: string;
	approval_id: string;
}

describe('project intake', () => {
	it('creates an intake ticket and pending approval instead of a project', async () => {
		const team = await createBlankTeam('Intake Co');

		const res = await app.request(`/api/projects/internal-${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Mobile App',
				description: 'A new mobile app for our customers',
			}),
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as IntakeResponse;

		expect(intake.project_slug).toBe(`internal-${team.slug}`);
		expect(intake.intake_task_identifier).toMatch(/^IN-\d+$/);
		expect(intake.approval_id).toBeTruthy();

		const projectCount = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM projects
			 WHERE team_id = $1 AND is_internal = false`,
			[team.id],
		);
		expect(projectCount.rows[0].count).toBe(0);

		const taskRow = await db.query<{ description: string; labels: unknown }>(
			'SELECT description, labels FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(taskRow.rows[0].description).toContain(PROJECT_INTAKE_MARKER);
		expect(taskRow.rows[0].description).toContain(intake.approval_id);

		const approval = await db.query<{
			type: string;
			status: string;
			payload: Record<string, unknown>;
		}>('SELECT type::text, status::text, payload FROM approvals WHERE id = $1', [
			intake.approval_id,
		]);
		expect(approval.rows[0].type).toBe('project_creation');
		expect(approval.rows[0].status).toBe('pending');
		expect(approval.rows[0].payload.name).toBe('Mobile App');
		expect(approval.rows[0].payload.intake_task_id).toBe(intake.intake_task_id);

		const commentsRes = await app.request(
			`/api/projects/internal-${team.slug}/tasks/${intake.intake_task_identifier}/comments`,
			{ headers: authHeader(token) },
		);
		const comments = (await commentsRes.json()).data as Array<{
			author_name: string;
			content: { text: string };
		}>;
		expect(
			comments.some(
				(c) => c.author_name === 'Captain' && c.content.text.includes("I'm the Captain"),
			),
		).toBe(true);
	});

	it('rejects missing name/description with 400 and no side effects', async () => {
		const team = await createBlankTeam('Validation Co');

		const res = await app.request(`/api/projects/internal-${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: '', description: 'desc' }),
		});
		expect(res.status).toBe(400);

		const approvals = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM approvals WHERE team_id = $1`,
			[team.id],
		);
		expect(approvals.rows[0].count).toBe(0);
	});

	it('rejects task_prefix conflict with 409 before any rows are inserted', async () => {
		const team = await createBlankTeam('Prefix Conflict Co');

		// Internal already uses 'IN' — submitting that should conflict.
		const res = await app.request(`/api/projects/internal-${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Indigo',
				description: 'desc',
				task_prefix: 'IN',
			}),
		});
		expect(res.status).toBe(409);

		const approvals = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM approvals WHERE team_id = $1`,
			[team.id],
		);
		expect(approvals.rows[0].count).toBe(0);
	});

	it('approving the approval creates the project + planning task and closes the intake', async () => {
		const team = await createBlankTeam('Approve Co');

		const res = await app.request(`/api/projects/internal-${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Customer Portal',
				description: 'Self-service portal for customers',
			}),
		});
		const intake = (await res.json()).data as IntakeResponse;

		const approveRes = await app.request(`/api/approvals/${intake.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(approveRes.status).toBe(200);

		const project = await db.query<{ id: string; slug: string; task_prefix: string }>(
			`SELECT id, slug, task_prefix FROM projects
			 WHERE team_id = $1 AND is_internal = false AND name = $2`,
			[team.id, 'Customer Portal'],
		);
		expect(project.rows[0]).toBeDefined();
		expect(project.rows[0].slug).toBe('customer-portal');

		const planning = await db.query<{ title: string; labels: unknown; status: string }>(
			`SELECT title, labels, status::text FROM tasks
			 WHERE project_id = $1 AND labels @> '["planning"]'::jsonb`,
			[project.rows[0].id],
		);
		expect(planning.rows[0]).toBeDefined();
		expect(planning.rows[0].title).toContain('Customer Portal');

		const intakeAfter = await db.query<{ status: string }>(
			'SELECT status::text FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(intakeAfter.rows[0].status).toBe(TaskStatus.Done);
	});

	it('denying the approval posts a denial note and leaves the intake open', async () => {
		const team = await createBlankTeam('Deny Co');

		const res = await app.request(`/api/projects/internal-${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Skunkworks', description: 'desc' }),
		});
		const intake = (await res.json()).data as IntakeResponse;

		const denyRes = await app.request(`/api/approvals/${intake.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied', resolution_note: 'Not now' }),
		});
		expect(denyRes.status).toBe(200);

		const projectCount = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM projects
			 WHERE team_id = $1 AND is_internal = false`,
			[team.id],
		);
		expect(projectCount.rows[0].count).toBe(0);

		const intakeAfter = await db.query<{ status: string }>(
			'SELECT status::text FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(intakeAfter.rows[0].status).not.toBe(TaskStatus.Done);

		const commentsRes = await app.request(
			`/api/projects/internal-${team.slug}/tasks/${intake.intake_task_identifier}/comments`,
			{ headers: authHeader(token) },
		);
		const comments = (await commentsRes.json()).data as Array<{
			author_name: string;
			content: { text: string };
		}>;
		expect(
			comments.some(
				(c) => c.author_name === 'Captain' && c.content.text.toLowerCase().includes('declined'),
			),
		).toBe(true);
	});

	it('skip-questions posts a system comment on the project intake', async () => {
		const team = await createBlankTeam('Skip Q Co');

		const res = await app.request(`/api/projects/internal-${team.slug}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Fast Track', description: 'desc' }),
		});
		const intake = (await res.json()).data as IntakeResponse;

		const skipRes = await app.request(
			`/api/projects/internal-${team.slug}/project-intake/${intake.intake_task_id}/skip-questions`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(skipRes.status).toBe(200);

		const commentsRes = await app.request(
			`/api/projects/internal-${team.slug}/tasks/${intake.intake_task_identifier}/comments`,
			{ headers: authHeader(token) },
		);
		const comments = (await commentsRes.json()).data as Array<{
			content_type: string;
			content: { text: string };
		}>;
		const systemComment = comments.find(
			(c) => c.content_type === 'system' && c.content.text.toLowerCase().includes('skip'),
		);
		expect(systemComment).toBeDefined();
	});
});
