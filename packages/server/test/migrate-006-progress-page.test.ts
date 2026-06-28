import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '006_progress_page.sql';

describe('006_progress_page migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	let taskId: string;
	let commentId: string;
	let runId: string;

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET);

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme Project', 'acme-project', 'AP') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;
		const member = await h.db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, 'agent', 'Captain') RETURNING id`,
			[teamId],
		);
		const memberId = member.rows[0].id;
		const task = await h.db.query<{ id: string }>(
			`INSERT INTO tasks (team_id, project_id, number, identifier, title, status, priority, labels)
			 VALUES ($1, $2, 1, 'AP-1', 'Existing task', 'backlog'::task_status, 'medium'::task_priority, '[]'::jsonb)
			 RETURNING id`,
			[teamId, projectId],
		);
		taskId = task.rows[0].id;
		// A pre-existing comment that must survive and pick up created_by_run_id = NULL.
		const comment = await h.db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"hello"}'::jsonb)
			 RETURNING id`,
			[taskId, memberId],
		);
		commentId = comment.rows[0].id;
		const run = await h.db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status) RETURNING id`,
			[teamId, memberId, taskId],
		);
		runId = run.rows[0].id;

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('adds the new columns', async () => {
		const cols = await h.db.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name FROM information_schema.columns
			 WHERE (table_name = 'task_comments' AND column_name = 'created_by_run_id')
			    OR (table_name = 'projects' AND column_name IN ('progress_summary', 'progress_summary_updated_at'))`,
		);
		const found = cols.rows.map((r) => `${r.table_name}.${r.column_name}`).sort();
		expect(found).toEqual([
			'projects.progress_summary',
			'projects.progress_summary_updated_at',
			'task_comments.created_by_run_id',
		]);
	});

	it('preserves the pre-existing comment with a NULL run link', async () => {
		const c = await h.db.query<{ id: string; created_by_run_id: string | null }>(
			`SELECT id, created_by_run_id FROM task_comments WHERE id = $1`,
			[commentId],
		);
		expect(c.rows.length).toBe(1);
		expect(c.rows[0].created_by_run_id).toBeNull();
	});

	it('defaults the project progress summary to empty and unset timestamp', async () => {
		const p = await h.db.query<{
			progress_summary: string;
			progress_summary_updated_at: string | null;
		}>(`SELECT progress_summary, progress_summary_updated_at FROM projects WHERE id = $1`, [
			projectId,
		]);
		expect(p.rows[0].progress_summary).toBe('');
		expect(p.rows[0].progress_summary_updated_at).toBeNull();
	});

	it('preserves the pre-existing team, project, task, and run rows', async () => {
		const kept = await h.db.query(
			`SELECT
			   (SELECT count(*) FROM teams WHERE id = $1) AS teams,
			   (SELECT count(*) FROM projects WHERE id = $2) AS projects,
			   (SELECT count(*) FROM tasks WHERE id = $3) AS tasks,
			   (SELECT count(*) FROM heartbeat_runs WHERE id = $4) AS runs`,
			[teamId, projectId, taskId, runId],
		);
		const r = kept.rows[0] as Record<string, string>;
		expect(Number(r.teams)).toBe(1);
		expect(Number(r.projects)).toBe(1);
		expect(Number(r.tasks)).toBe(1);
		expect(Number(r.runs)).toBe(1);
	});

	it('links a comment to a run and stores a project summary after the migration', async () => {
		await h.db.query(`UPDATE task_comments SET created_by_run_id = $1 WHERE id = $2`, [
			runId,
			commentId,
		]);
		const linked = await h.db.query<{ created_by_run_id: string }>(
			`SELECT created_by_run_id FROM task_comments WHERE id = $1`,
			[commentId],
		);
		expect(linked.rows[0].created_by_run_id).toBe(runId);

		await h.db.query(
			`UPDATE projects SET progress_summary = $1, progress_summary_updated_at = now() WHERE id = $2`,
			['**Shipping v1.** Auth done; payments in progress.', projectId],
		);
		const p = await h.db.query<{ progress_summary: string; progress_summary_updated_at: string }>(
			`SELECT progress_summary, progress_summary_updated_at FROM projects WHERE id = $1`,
			[projectId],
		);
		expect(p.rows[0].progress_summary).toContain('Shipping v1');
		expect(p.rows[0].progress_summary_updated_at).not.toBeNull();
	});
});
