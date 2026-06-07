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
	await db.query("DELETE FROM teams WHERE id != '00000000-0000-0000-0000-000000000001'");
});

afterAll(async () => {
	await safeClose(db);
});

interface IntakeResponse {
	intake_task_id: string;
	intake_task_identifier: string;
	project_slug: string;
	approval_id: string;
	team_id: string;
	team_slug: string;
}

async function startIntake(body: Record<string, unknown>) {
	return app.request('/api/project-intakes', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
}

async function fetchComments(projectSlug: string, taskIdentifier: string) {
	const res = await app.request(`/api/projects/${projectSlug}/tasks/${taskIdentifier}/comments`, {
		headers: authHeader(token),
	});
	return (await res.json()).data as Array<{
		author_name: string;
		content_type: string;
		content: { text: string };
	}>;
}

describe('project intake (CEO-assisted)', () => {
	it('stands up the team and opens an HQ intake conversation + pending approval, no project yet', async () => {
		const res = await startIntake({
			name: 'Mobile App',
			description: 'A new mobile app for our customers',
		});
		expect(res.status).toBe(201);
		const intake = (await res.json()).data as IntakeResponse;

		// The conversation lives in the HQ project.
		expect(intake.project_slug).toBe('hq');
		expect(intake.intake_task_identifier).toMatch(/^HQ-\d+$/);
		expect(intake.approval_id).toBeTruthy();
		expect(intake.team_id).toBeTruthy();

		// The new team exists but has no project until the intake is approved.
		const team = await db.query<{ name: string }>('SELECT name FROM teams WHERE id = $1', [
			intake.team_id,
		]);
		expect(team.rows[0]?.name).toBe('Mobile App');
		const projectCount = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM projects WHERE team_id = $1`,
			[intake.team_id],
		);
		expect(projectCount.rows[0].count).toBe(0);

		const taskRow = await db.query<{ description: string }>(
			'SELECT description FROM tasks WHERE id = $1',
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

		const comments = await fetchComments(intake.project_slug, intake.intake_task_identifier);
		expect(comments.some((c) => c.content.text.includes("I'm the CEO"))).toBe(true);
	});

	it('rejects missing name/description with 400 and no approval', async () => {
		const res = await startIntake({ name: '', description: 'desc' });
		expect(res.status).toBe(400);

		const approvals = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM approvals WHERE type = 'project_creation'::approval_type`,
		);
		expect(approvals.rows[0].count).toBe(0);
	});

	it('rejects a malformed task_prefix with 400 and creates no approval', async () => {
		const res = await startIntake({
			name: 'Indigo',
			description: 'desc',
			task_prefix: 'lowercase-and-long',
		});
		expect(res.status).toBe(400);

		const approvals = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM approvals WHERE type = 'project_creation'::approval_type`,
		);
		expect(approvals.rows[0].count).toBe(0);
	});

	it('approving creates the project + planning task on the team and closes the intake', async () => {
		const res = await startIntake({
			name: 'Customer Portal',
			description: 'Self-service portal for customers',
		});
		const intake = (await res.json()).data as IntakeResponse;

		const approveRes = await app.request(`/api/approvals/${intake.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'approved' }),
		});
		expect(approveRes.status).toBe(200);

		const project = await db.query<{ id: string; slug: string }>(
			`SELECT id, slug FROM projects WHERE team_id = $1 AND is_internal = false`,
			[intake.team_id],
		);
		expect(project.rows[0]).toBeDefined();
		expect(project.rows[0].slug).toBe('customer-portal');

		const planning = await db.query<{ title: string }>(
			`SELECT title FROM tasks WHERE project_id = $1 AND labels @> '["planning"]'::jsonb`,
			[project.rows[0].id],
		);
		expect(planning.rows[0]?.title).toContain('Customer Portal');

		const intakeAfter = await db.query<{ status: string }>(
			'SELECT status::text FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(intakeAfter.rows[0].status).toBe(TaskStatus.Done);
	});

	it('denying posts a denial note and leaves the intake open with no project', async () => {
		const res = await startIntake({ name: 'Skunkworks', description: 'desc' });
		const intake = (await res.json()).data as IntakeResponse;

		const denyRes = await app.request(`/api/approvals/${intake.approval_id}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'denied', resolution_note: 'Not now' }),
		});
		expect(denyRes.status).toBe(200);

		const projectCount = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM projects WHERE team_id = $1`,
			[intake.team_id],
		);
		expect(projectCount.rows[0].count).toBe(0);

		const intakeAfter = await db.query<{ status: string }>(
			'SELECT status::text FROM tasks WHERE id = $1',
			[intake.intake_task_id],
		);
		expect(intakeAfter.rows[0].status).not.toBe(TaskStatus.Done);

		const comments = await fetchComments(intake.project_slug, intake.intake_task_identifier);
		expect(comments.some((c) => c.content.text.toLowerCase().includes('declined'))).toBe(true);
	});

	it('skip-questions posts a system comment on the project intake', async () => {
		const res = await startIntake({ name: 'Fast Track', description: 'desc' });
		const intake = (await res.json()).data as IntakeResponse;

		const skipRes = await app.request(
			`/api/projects/${intake.project_slug}/project-intake/${intake.intake_task_id}/skip-questions`,
			{ method: 'POST', headers: authHeader(token) },
		);
		expect(skipRes.status).toBe(200);

		const comments = await fetchComments(intake.project_slug, intake.intake_task_identifier);
		const systemComment = comments.find(
			(c) => c.content_type === 'system' && c.content.text.toLowerCase().includes('skip'),
		);
		expect(systemComment).toBeDefined();
	});
});
