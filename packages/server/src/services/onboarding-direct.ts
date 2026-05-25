import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, CAPTAIN_AGENT_SLUG, WakeupSource, wsRoom } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import { resolveProjectTaskPrefix } from '../routes/projects';
import type { ContainerLogStreamer } from './container-logs';
import { type ProjectRow, provisionContainer } from './containers';
import type { DockerClient } from './docker';
import type { LogStreamBroker } from './log-stream-broker';
import { createProjectWithPlanningTask } from './project-create';
import type { SshAgentServer } from './ssh-agent';
import { applyTemplateToTeam } from './team-template-apply';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('onboarding-direct');

export interface OnboardingDirectInput {
	teamId: string;
	templateId: string;
	projectName: string;
	projectDescription?: string;
	dataDir: string;
	wsManager?: WebSocketManager;
	docker: DockerClient;
	masterKeyManager?: MasterKeyManager;
	logs?: LogStreamBroker;
	containerLogStreamer?: ContainerLogStreamer;
	sshAgentServer?: SshAgentServer | null;
	/** Host path to the egress CA PEM; bind-mounted into the project container. */
	egressCAPath?: string | null;
}

export type OnboardingDirectResult =
	| {
			ok: true;
			project_id: string;
			project_slug: string;
			planning_task_id: string;
			planning_task_identifier: string;
			created_agent_slugs: string[];
	  }
	| { ok: false; code: 'INVALID_REQUEST' | 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL'; message: string };

/**
 * Direct-flow onboarding: user picked a template + named a project in the
 * wizard preview-and-confirm step. We apply the template and create the
 * project in a single server call. The user's explicit click in the wizard
 * is the approval — no team_template approval row is filed.
 *
 * The team must already exist (the seeded default team in single-team mode).
 * If the team already has a user-facing project, this still adds the template
 * agents and creates the new project alongside it.
 */
export async function runOnboardingDirect(
	db: PGlite,
	input: OnboardingDirectInput,
): Promise<OnboardingDirectResult> {
	const projectName = input.projectName.trim();
	if (!projectName) {
		return { ok: false, code: 'INVALID_REQUEST', message: 'projectName is required' };
	}

	const templateRow = await db.query<{ id: string }>(
		'SELECT id FROM team_templates WHERE id = $1',
		[input.templateId],
	);
	if (templateRow.rows.length === 0) {
		return { ok: false, code: 'NOT_FOUND', message: 'Template not found' };
	}

	const projectSlug = projectName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	if (!projectSlug) {
		return {
			ok: false,
			code: 'INVALID_REQUEST',
			message: 'projectName must contain at least one alphanumeric character',
		};
	}

	const slugCollision = await db.query('SELECT 1 FROM projects WHERE team_id = $1 AND slug = $2', [
		input.teamId,
		projectSlug,
	]);
	if (slugCollision.rows.length > 0) {
		return {
			ok: false,
			code: 'CONFLICT',
			message: `A project with slug "${projectSlug}" already exists in this team`,
		};
	}

	const prefixResult = await resolveProjectTaskPrefix(db, input.teamId, undefined, projectName);
	if (!prefixResult.ok) {
		return { ok: false, code: prefixResult.code, message: prefixResult.message };
	}

	const apply = await applyTemplateToTeam(db, input.teamId, input.templateId, {
		dataDir: input.dataDir,
		wsManager: input.wsManager,
	});

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[input.teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainMemberId = captain.rows[0]?.id;
	if (!captainMemberId) {
		return {
			ok: false,
			code: 'INTERNAL',
			message: 'No enabled Captain on team after template apply',
		};
	}

	const { project, planningTask } = await createProjectWithPlanningTask(db, {
		teamId: input.teamId,
		captainMemberId,
		name: projectName,
		slug: projectSlug,
		taskPrefix: prefixResult.prefix,
		description: input.projectDescription?.trim() ?? '',
	});

	broadcastRowChange(input.wsManager, wsRoom.team(input.teamId), 'projects', 'INSERT', project);
	broadcastRowChange(input.wsManager, wsRoom.team(input.teamId), 'tasks', 'INSERT', planningTask);
	try {
		await createWakeup(db, captainMemberId, input.teamId, WakeupSource.Assignment, {
			task_id: planningTask.id as string,
		});
	} catch (e) {
		log.error('Failed to wake Captain on planning task after direct onboarding:', e);
	}

	const teamSlugRow = await db.query<{ slug: string }>('SELECT slug FROM teams WHERE id = $1', [
		input.teamId,
	]);
	const teamSlug = teamSlugRow.rows[0]?.slug;
	if (teamSlug) {
		trackBackground(
			provisionContainer(
				{
					db,
					docker: input.docker,
					dataDir: input.dataDir,
					wsManager: input.wsManager,
					masterKeyManager: input.masterKeyManager,
					logs: input.logs,
					containerLogStreamer: input.containerLogStreamer,
					sshAgentServer: input.sshAgentServer,
					egressCAPath: input.egressCAPath ?? null,
				},
				project as unknown as ProjectRow,
				teamSlug,
			).catch((error) => {
				log.error(`Failed to provision container for project ${project.slug}:`, error);
			}),
		);
	} else {
		log.error(`Team ${input.teamId} not found when provisioning container after direct onboarding`);
	}

	return {
		ok: true,
		project_id: project.id as string,
		project_slug: project.slug as string,
		planning_task_id: planningTask.id as string,
		planning_task_identifier: planningTask.identifier as string,
		created_agent_slugs: apply.created_slugs,
	};
}
