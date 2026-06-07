import type { PGlite } from '@electric-sql/pglite';
import {
	DEFAULT_TEAM_ID,
	DEFAULT_TEAM_NAME,
	DEFAULT_TEAM_SLUG,
	DEFAULT_TEAM_TEMPLATE_NAME,
	INTERNAL_PROJECT_SLUG,
	INTERNAL_PROJECT_TASK_PREFIX,
	MemberType,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { trackBackground } from '../lib/background';
import { toSlug, uniqueSlug } from '../lib/slug';
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import type { ContainerLogStreamer } from './container-logs';
import { type ProjectRow, provisionContainer } from './containers';
import type { DockerClient } from './docker';
import type { LogStreamBroker } from './log-stream-broker';
import {
	applyTemplateToTeam,
	ensureBuiltinAgents,
	ensureInstanceCeo,
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
	const { db, docker, dataDir, wsManager, masterKeyManager, logs } = deps;

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

		// Project slugs are globally unique, so the per-team internal project derives
		// its slug from the (already unique) team slug rather than a shared literal.
		const internalProjectResult = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, task_prefix, description, is_internal)
			 VALUES ($1, '(Internal)', $2, $3, 'Internal team coordination project, used for onboarding and team-level changes.', true)
			 RETURNING id`,
			[teamId, `${INTERNAL_PROJECT_SLUG}-${slug}`, INTERNAL_PROJECT_TASK_PREFIX],
		);
		await db.query('INSERT INTO project_task_counters (project_id, next_number) VALUES ($1, 1)', [
			internalProjectResult.rows[0].id,
		]);

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
	// default team (which hosts the CEO) is itself being seeded.
	await linkTeamCaptainToInstanceCeo(db, teamId);

	const internalProject = await db.query<ProjectRow>(
		`SELECT id, team_id, slug, docker_base_image, container_id, container_status, dev_ports
		 FROM projects WHERE team_id = $1 AND is_internal = true`,
		[teamId],
	);
	if (internalProject.rows[0]) {
		trackBackground(
			provisionContainer(
				{
					db,
					docker,
					dataDir,
					wsManager,
					masterKeyManager,
					logs,
					containerLogStreamer: deps.containerLogStreamer,
					egressCAPath: deps.egressCAPath ?? null,
				},
				internalProject.rows[0],
				slug,
			).catch((error) => {
				log.error(`Failed to provision container for Internal project:`, error);
			}),
		);
	}

	const enriched = await db.query<CreatedTeamRow>(
		`SELECT c.*,
		   (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $2)::int AS agent_count,
		   0 AS open_task_count
		 FROM teams c WHERE c.id = $1`,
		[teamId, MemberType.Agent],
	);

	return enriched.rows[0];
}

export async function seedDefaultTeam(deps: CreateTeamDeps): Promise<void> {
	const existing = await deps.db.query('SELECT 1 FROM teams WHERE id = $1', [DEFAULT_TEAM_ID]);
	if (existing.rows.length > 0) return;

	const templateResult = await deps.db.query<{ id: string }>(
		'SELECT id FROM team_templates WHERE name = $1',
		[DEFAULT_TEAM_TEMPLATE_NAME],
	);
	const templateId = templateResult.rows[0]?.id;
	if (!templateId) {
		log.warn(`Team template "${DEFAULT_TEAM_TEMPLATE_NAME}" not found; cannot seed default team`);
		return;
	}

	await createTeam(deps, {
		id: DEFAULT_TEAM_ID,
		slug: DEFAULT_TEAM_SLUG,
		name: DEFAULT_TEAM_NAME,
		templateId,
	});

	// The single instance CEO lives in the default team; its Captain reports to it.
	await ensureInstanceCeo(deps.db, DEFAULT_TEAM_ID);
	await linkTeamCaptainToInstanceCeo(deps.db, DEFAULT_TEAM_ID);

	log.info(
		`Seeded default team (${DEFAULT_TEAM_SLUG}) using template "${DEFAULT_TEAM_TEMPLATE_NAME}"`,
	);
}
