import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataPreservationHarness, type DataPreservationHarness } from './helpers/migrate';

const TARGET = '002_audit_log_project_scope.sql';

describe('002_audit_log_project_scope migration', () => {
	let h: DataPreservationHarness;
	let teamId: string;
	let projectId: string;
	const ids: Record<string, string> = {};

	beforeAll(async () => {
		h = await createDataPreservationHarness();
		await h.applyUpToExclusive(TARGET); // schema with audit_log.team_id present

		const team = await h.db.query<{ id: string }>(
			`INSERT INTO teams (name, slug) VALUES ('Acme', 'acme') RETURNING id`,
		);
		teamId = team.rows[0].id;
		const project = await h.db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix)
			 VALUES ($1, 'Acme', 'acme', 'AC') RETURNING id`,
			[teamId],
		);
		projectId = project.rows[0].id;

		// (a) team-only agent row — no project_id yet, should backfill to the project.
		// (b) project task row — already scoped, must stay put.
		// (c) instance secret row — team_id NULL, must stay instance-scoped.
		// (d) OAuth connection row — team-tagged but instance-global, must stay instance-scoped.
		const seed = async (
			key: string,
			team: string | null,
			project: string | null,
			entityType: string,
		) => {
			const r = await h.db.query<{ id: string }>(
				`INSERT INTO audit_log (team_id, project_id, actor_type, action, entity_type)
				 VALUES ($1, $2, 'admin'::audit_actor_type, 'created', $3) RETURNING id`,
				[team, project, entityType],
			);
			ids[key] = r.rows[0].id;
		};
		await seed('agent', teamId, null, 'agent');
		await seed('task', teamId, projectId, 'task');
		await seed('secret', null, null, 'secret');
		await seed('connection', teamId, null, 'connection');

		await h.applyTarget(TARGET);
	});
	afterAll(() => h.close());

	it('drops the team_id column', async () => {
		const c = await h.db.query<{ c: number }>(
			`SELECT COUNT(*)::int AS c FROM information_schema.columns
			 WHERE table_name = 'audit_log' AND column_name = 'team_id'`,
		);
		expect(c.rows[0].c).toBe(0);
	});

	it('backfills team-only rows onto the team’s project', async () => {
		const r = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM audit_log WHERE id = $1`,
			[ids.agent],
		);
		expect(r.rows[0].project_id).toBe(projectId);
	});

	it('leaves already-project-scoped rows untouched', async () => {
		const r = await h.db.query<{ project_id: string | null }>(
			`SELECT project_id FROM audit_log WHERE id = $1`,
			[ids.task],
		);
		expect(r.rows[0].project_id).toBe(projectId);
	});

	it('keeps instance-global rows (secret, connection) instance-scoped', async () => {
		const r = await h.db.query<{ id: string; project_id: string | null }>(
			`SELECT id, project_id FROM audit_log WHERE id = ANY($1)`,
			[[ids.secret, ids.connection]],
		);
		for (const row of r.rows) expect(row.project_id).toBeNull();
	});

	it('preserves every pre-existing row', async () => {
		const r = await h.db.query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM audit_log`);
		expect(r.rows[0].c).toBe(4);
	});
});
