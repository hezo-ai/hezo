import type { PGlite } from '@electric-sql/pglite';
import {
	DEFAULT_TEAM_ID,
	DEFAULT_TEAM_NAME,
	DEFAULT_TEAM_SLUG,
	HQ_PROJECT_NAME,
	HQ_PROJECT_SLUG,
	HQ_PROJECT_TASK_PREFIX,
	MemberType,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { toSlug, uniqueSlug } from '../lib/slug';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import type { ContainerLogStreamer } from './container-logs';
import type { DockerClient } from './docker';
import type { LogStreamBroker } from './log-stream-broker';
import {
	applyTemplateToTeam,
	ensureBuiltinAgents,
	ensureInstanceCeo,
	ensureInstanceCoach,
	linkTeamCaptainToInstanceCeo,
} from './team-template-apply';
import type { WebSocketManager } from './ws';

const log = logger.child('teams');

export interface CreateTeamDeps {
	db: PGlite;
	docker: DockerClient;
	wsManager?: WebSocketManager;
	masterKeyManager?: MasterKeyManager;
	logs?: LogStreamBroker;
	containerLogStreamer?: ContainerLogStreamer;
	dataDir: string;
	/** Host path to the egress CA PEM; bind-mounted into the Internal project container. */
	egressCAPath?: string | null;
}

export interface CreateTeamInput {
	name: string;
	description?: string;
	templateId?: string;
	/** Fixed UUID to use as the team's primary key. Defaults to gen_random_uuid(). */
	id?: string;
	/** Fixed slug. Defaults to a unique slug derived from name. */
	slug?: string;
	/** When provided, the user is inserted as a the admin of the new team. */
	creatorUserId?: string;
}

export interface CreatedTeamRow {
	id: string;
	name: string;
	slug: string;
	description: string;
	agent_count: number;
	open_task_count: number;
	[key: string]: unknown;
}

export async function createTeam(
	deps: CreateTeamDeps,
	input: CreateTeamInput,
): Promise<CreatedTeamRow> {
	const { db, dataDir, wsManager } = deps;

	const name = input.name.trim();
	const slug =
		input.slug ??
		(await uniqueSlug(toSlug(name), async (s) => {
			const r = await db.query('SELECT 1 FROM teams WHERE slug = $1', [s]);
			return r.rows.length > 0;
		}));

	const teamId = await withTransaction(db, async () => {
		const teamSummaryResult = input.templateId
			? await db.query<{ default_summary: string }>(
					'SELECT default_summary FROM team_templates WHERE id = $1',
					[input.templateId],
				)
			: null;
		const teamSummary = teamSummaryResult?.rows[0]?.default_summary ?? '';

		const teamResult = input.id
			? await db.query<{ id: string }>(
					`INSERT INTO teams (id, name, slug, description, summary)
					 VALUES ($1, $2, $3, $4, $5)
					 RETURNING id`,
					[input.id, name, slug, input.description ?? '', teamSummary],
				)
			: await db.query<{ id: string }>(
					`INSERT INTO teams (name, slug, description, summary)
					 VALUES ($1, $2, $3, $4)
					 RETURNING id`,
					[name, slug, input.description ?? '', teamSummary],
				);
		const teamId = teamResult.rows[0].id;

		if (input.creatorUserId) {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
				 VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
				 RETURNING id`,
				[teamId, MemberType.User, input.creatorUserId],
			);
			await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'admin')`, [
				memberResult.rows[0].id,
				input.creatorUserId,
			]);
		}

		// A project-team's single project is created on intake approval, not here —
		// the team exists with just its Captain until the admin approves the project.
		if (input.templateId) {
			await db.query(
				`INSERT INTO team_template_assignments (team_id, team_template_id)
				 VALUES ($1, $2)
				 ON CONFLICT DO NOTHING`,
				[teamId, input.templateId],
			);
		}

		return teamId;
	});

	if (input.templateId) {
		await applyTemplateToTeam(db, teamId, input.templateId, { dataDir, wsManager });
	} else {
		await ensureBuiltinAgents(db, teamId);
	}

	// A new team's Captain reports to the single instance CEO. No-op while the
	// HQ team (which hosts the CEO) is itself being seeded.
	await linkTeamCaptainToInstanceCeo(db, teamId);

	const enriched = await db.query<CreatedTeamRow>(
		`SELECT c.*,
		   (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $2)::int AS agent_count,
		   0 AS open_task_count
		 FROM teams c WHERE c.id = $1`,
		[teamId, MemberType.Agent],
	);

	return enriched.rows[0];
}

/**
 * Seeds the HQ team — the single instance-level team. It owns the one HQ project
 * (the only `is_internal` project across the instance) and hosts the two
 * singletons, the CEO and the Coach. It has no Captain and runs no user work;
 * every project-team's Captain reports up to the CEO that lives here.
 */
export async function seedDefaultTeam(deps: CreateTeamDeps): Promise<void> {
	const { db } = deps;
	const existing = await db.query('SELECT 1 FROM teams WHERE id = $1', [DEFAULT_TEAM_ID]);
	if (existing.rows.length > 0) return;

	await withTransaction(db, async () => {
		await db.query(
			`INSERT INTO teams (id, name, slug, description, summary) VALUES ($1, $2, $3, '', '')`,
			[DEFAULT_TEAM_ID, DEFAULT_TEAM_NAME, DEFAULT_TEAM_SLUG],
		);
		const projectResult = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description, is_internal)
			 VALUES ($1, $2, $3, $4, 'Instance coordination project — home of the CEO and Coach.', true)
			 RETURNING id`,
			[DEFAULT_TEAM_ID, HQ_PROJECT_NAME, HQ_PROJECT_SLUG, HQ_PROJECT_TASK_PREFIX],
		);
		await db.query('INSERT INTO project_task_counters (project_id, next_number) VALUES ($1, 1)', [
			projectResult.rows[0].id,
		]);
	});

	await ensureInstanceCeo(db, DEFAULT_TEAM_ID);
	await ensureInstanceCoach(db, DEFAULT_TEAM_ID);

	// The HQ container is brought up by the startup reconciliation pass
	// (JobManager.ensureHqContainerRunning), which runs after the master key is
	// unlocked — provisioning needs secrets/egress that aren't available here.

	log.info(`Seeded HQ team (${DEFAULT_TEAM_SLUG}) with CEO + Coach`);
}
