import type { PGlite } from '@electric-sql/pglite';
import { BUILTIN_AGENT_SLUGS, MemberType, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { toProjectIssuePrefix, toSlug, uniqueSlug } from '../lib/slug';
import { logger } from '../logger';
import { type ProjectRow, provisionContainer } from './containers';
import { enqueueTeamContextTaskForAllAgents } from './description-tasks';
import type { DockerClient } from './docker';
import { initAgentSystemPrompt } from './documents';
import type { LogStreamBroker } from './log-stream-broker';
import {
	createRequirementsIntakeIssue,
	wakeCaptainForRequirementsIntake,
} from './requirements-intake';
import { createSkillsFromTemplate, provisionAgentsFromTeamTypes } from './team-template-provision';
import type { WebSocketManager } from './ws';

const log = logger.child('team-create');

export const DEFAULT_ONBOARDING_TEAM_NAME = 'Team';
export const BLANK_TEAM_TEMPLATE_NAME = 'Blank';

export interface CreateTeamInput {
	name: string;
	description?: string;
	templateId?: string;
	creatorUserId?: string;
}

export interface CreateTeamDeps {
	db: PGlite;
	docker: DockerClient;
	dataDir: string;
	wsManager?: WebSocketManager;
	masterKeyManager?: MasterKeyManager;
	logs?: LogStreamBroker;
	/** Host path to the egress CA PEM; bind-mounted into the operations container. */
	egressCAPath?: string | null;
}

export interface CreatedTeamRow {
	id: string;
	name: string;
	slug: string;
	description: string;
	agent_count: number;
	open_issue_count: number;
	[key: string]: unknown;
}

async function ensureBuiltinAgents(db: PGlite, teamId: string): Promise<void> {
	const existing = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = ANY($2)`,
		[teamId, [...BUILTIN_AGENT_SLUGS]],
	);
	const existingSlugs = new Set(existing.rows.map((r) => r.slug));
	const missingSlugs = BUILTIN_AGENT_SLUGS.filter((s) => !existingSlugs.has(s));
	if (missingSlugs.length === 0) return;

	const overrideResult = await db.query<{
		builtin_agent_prompts: Record<string, string> | null;
		builtin_agent_team_contexts: Record<string, string> | null;
	}>(
		`SELECT ct.builtin_agent_prompts, ct.builtin_agent_team_contexts
		 FROM team_template_assignments ctt
		 JOIN team_templates ct ON ct.id = ctt.team_template_id
		 WHERE ctt.team_id = $1`,
		[teamId],
	);
	const promptOverrides: Record<string, string> = {};
	const teamContextOverrides: Record<string, string> = {};
	for (const row of overrideResult.rows) {
		for (const [slug, prompt] of Object.entries(row.builtin_agent_prompts ?? {})) {
			if (prompt && !promptOverrides[slug]) promptOverrides[slug] = prompt;
		}
		for (const [slug, context] of Object.entries(row.builtin_agent_team_contexts ?? {})) {
			if (context && !teamContextOverrides[slug]) teamContextOverrides[slug] = context;
		}
	}

	const agentTypes = await db.query<{
		id: string;
		name: string;
		slug: string;
		role_description: string;
		default_summary: string;
		default_team_context: string;
		system_prompt_template: string;
		default_effort: string;
		heartbeat_interval_min: number;
		monthly_budget_cents: number;
		touches_code: boolean;
	}>(
		`SELECT id, name, slug, role_description, default_summary, default_team_context,
		        system_prompt_template,
		        default_effort, heartbeat_interval_min, monthly_budget_cents, touches_code
		 FROM agent_types WHERE slug = ANY($1)`,
		[missingSlugs],
	);

	for (const at of agentTypes.rows) {
		const memberResult = await db.query<{ id: string }>(
			`INSERT INTO members (team_id, member_type, display_name)
			 VALUES ($1, $2, $3)
			 RETURNING id`,
			[teamId, MemberType.Agent, at.name],
		);
		await db.query(
			`INSERT INTO member_agents (id, agent_type_id, title, slug, role_description, summary,
			                            team_context,
			                            default_effort, heartbeat_interval_min, monthly_budget_cents,
			                            touches_code)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::agent_effort, $9, $10, $11)`,
			[
				memberResult.rows[0].id,
				at.id,
				at.name,
				at.slug,
				at.role_description,
				at.default_summary ?? '',
				teamContextOverrides[at.slug] || at.default_team_context || '',
				at.default_effort,
				at.heartbeat_interval_min,
				at.monthly_budget_cents,
				at.touches_code ?? false,
			],
		);

		await initAgentSystemPrompt(
			db,
			teamId,
			memberResult.rows[0].id,
			promptOverrides[at.slug] || at.system_prompt_template,
			null,
		);
	}
}

export async function createTeam(
	deps: CreateTeamDeps,
	input: CreateTeamInput,
): Promise<CreatedTeamRow> {
	const { db, docker, dataDir, wsManager, masterKeyManager, logs } = deps;

	const slug = await uniqueSlug(toSlug(input.name), async (s) => {
		const r = await db.query('SELECT 1 FROM teams WHERE slug = $1', [s]);
		return r.rows.length > 0;
	});

	await db.query('BEGIN');
	try {
		const teamSummaryResult = input.templateId
			? await db.query<{ default_summary: string }>(
					'SELECT default_summary FROM team_templates WHERE id = $1',
					[input.templateId],
				)
			: null;
		const teamSummary = teamSummaryResult?.rows[0]?.default_summary ?? '';

		const teamResult = await db.query(
			`INSERT INTO teams (name, slug, description, summary)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
			[input.name.trim(), slug, input.description ?? '', teamSummary],
		);
		const team = teamResult.rows[0] as { id: string; [key: string]: unknown };

		if (input.creatorUserId) {
			const memberResult = await db.query<{ id: string }>(
				`INSERT INTO members (team_id, member_type, display_name)
         VALUES ($1, $2, (SELECT display_name FROM users WHERE id = $3))
         RETURNING id`,
				[team.id, MemberType.User, input.creatorUserId],
			);
			await db.query(`INSERT INTO member_users (id, user_id, role) VALUES ($1, $2, 'board')`, [
				memberResult.rows[0].id,
				input.creatorUserId,
			]);
		}

		const opsProjectResult = await db.query<{ id: string }>(
			`INSERT INTO projects (team_id, name, slug, issue_prefix, description, is_internal)
			 VALUES ($1, 'Operations', $2, $3, 'Administrative workspace for internal operations such as agent onboarding, team coordination, and team-wide tasks.', true)
			 RETURNING id`,
			[team.id, OPERATIONS_PROJECT_SLUG, toProjectIssuePrefix('Operations')],
		);
		await db.query('INSERT INTO project_issue_counters (project_id, next_number) VALUES ($1, 1)', [
			opsProjectResult.rows[0].id,
		]);

		if (input.templateId) {
			await provisionAgentsFromTeamTypes(db, team.id, [input.templateId]);
		}

		await ensureBuiltinAgents(db, team.id);

		const requirementsIntake = await createRequirementsIntakeIssue(db, team.id);

		await db.query('COMMIT');

		if (requirementsIntake) {
			wakeCaptainForRequirementsIntake(
				db,
				team.id,
				requirementsIntake.captainMemberId,
				requirementsIntake.issueId,
			).catch((e) => log.error('Failed to wake Captain after requirements intake create:', e));
		}

		enqueueTeamContextTaskForAllAgents(db, team.id, 'initial').catch((e) =>
			log.error('Failed to bootstrap team_context tasks for new team:', e),
		);

		if (input.templateId) {
			await createSkillsFromTemplate(db, team.id, input.templateId);
		}

		const opsResult = await db.query<ProjectRow>(
			`SELECT id, team_id, slug, docker_base_image, container_id, container_status, dev_ports
			 FROM projects WHERE team_id = $1 AND slug = $2`,
			[team.id, OPERATIONS_PROJECT_SLUG],
		);
		if (opsResult.rows[0]) {
			provisionContainer(
				{
					db,
					docker,
					dataDir,
					wsManager,
					masterKeyManager,
					logs,
					egressCAPath: deps.egressCAPath ?? null,
				},
				opsResult.rows[0],
				slug,
			).catch((error) => {
				log.error(`Failed to provision container for operations project:`, error);
			});
		}

		const result = await db.query<CreatedTeamRow>(
			`SELECT c.*,
         (SELECT count(*) FROM members m WHERE m.team_id = c.id AND m.member_type = $2)::int AS agent_count,
         0 AS open_issue_count
       FROM teams c WHERE c.id = $1`,
			[team.id, MemberType.Agent],
		);

		return result.rows[0];
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
}

/**
 * After the first AI provider is configured, create a default team from the Blank
 * template when the instance has no teams yet (onboarding shortcut).
 */
export async function ensureOnboardingTeamAfterFirstProvider(
	deps: CreateTeamDeps,
	creatorUserId: string,
	wasConfiguredBefore: boolean,
): Promise<CreatedTeamRow | null> {
	if (wasConfiguredBefore) return null;

	const existing = await deps.db.query('SELECT 1 FROM teams LIMIT 1');
	if (existing.rows.length > 0) return null;

	const blank = await deps.db.query<{ id: string }>(
		'SELECT id FROM team_templates WHERE name = $1',
		[BLANK_TEAM_TEMPLATE_NAME],
	);
	if (blank.rows.length === 0) {
		log.warn(`Team template "${BLANK_TEAM_TEMPLATE_NAME}" not found; skipping onboarding team`);
		return null;
	}

	return createTeam(deps, {
		name: DEFAULT_ONBOARDING_TEAM_NAME,
		templateId: blank.rows[0].id,
		creatorUserId,
	});
}
