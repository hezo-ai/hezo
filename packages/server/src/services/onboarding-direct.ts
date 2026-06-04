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
import { createTeam } from './teams';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('onboarding-direct');

export interface OnboardingDirectInput {
	templateId: string;
	projectName: string;
	projectDescription?: string;
	initialPrd?: string;
	/** The admin who ran the wizard, added as a member of the new project-team. */
	creatorUserId?: string;
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
			team_id: string;
			team_slug: string;
			project_id: string;
			project_slug: string;
			planning_task_id: string;
			planning_task_identifier: string;
			created_agent_slugs: string[];
	  }
	| { ok: false; code: 'INVALID_REQUEST' | 'CONFLICT' | 'NOT_FOUND' | 'INTERNAL'; message: string };

/**
 * Direct-flow onboarding (projects-primary): the user picked a template + named
 * a project in the wizard. We provision the project's **own team** (roster from
 * the template, named after the project, Captain linked to the instance CEO) and
 * create the project + planning task in it directly — the wizard click is the
 * approval, so no intake/approval ticket is filed. The default/HQ team is left
 * untouched (it stays CEO-only). See .dev/per-project-teams.md.
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

	// Provision the project's dedicated team (named after the project).
	const team = await createTeam(
		{
			db,
			docker: input.docker,
			dataDir: input.dataDir,
			wsManager: input.wsManager,
			masterKeyManager: input.masterKeyManager,
			logs: input.logs,
			containerLogStreamer: input.containerLogStreamer,
			egressCAPath: input.egressCAPath ?? null,
		},
		{
			name: projectName,
			description: input.projectDescription?.trim(),
			templateId: input.templateId,
			creatorUserId: input.creatorUserId,
		},
	);

	const prefixResult = await resolveProjectTaskPrefix(db, team.id, undefined, projectName);
	if (!prefixResult.ok) {
		return { ok: false, code: prefixResult.code, message: prefixResult.message };
	}

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[team.id, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainMemberId = captain.rows[0]?.id;
	if (!captainMemberId) {
		return {
			ok: false,
			code: 'INTERNAL',
			message: 'No enabled Captain on the new project-team',
		};
	}

	const { project, planningTask } = await createProjectWithPlanningTask(db, {
		teamId: team.id,
		captainMemberId,
		name: projectName,
		slug: projectSlug,
		taskPrefix: prefixResult.prefix,
		description: input.projectDescription?.trim() ?? '',
		initialPrd: input.initialPrd?.trim() || null,
	});

	broadcastRowChange(input.wsManager, wsRoom.team(team.id), 'projects', 'INSERT', project);
	broadcastRowChange(input.wsManager, wsRoom.team(team.id), 'tasks', 'INSERT', planningTask);
	try {
		await createWakeup(db, captainMemberId, team.id, WakeupSource.Assignment, {
			task_id: planningTask.id as string,
		});
	} catch (e) {
		log.error('Failed to wake Captain on planning task after direct onboarding:', e);
	}

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
			team.slug,
		).catch((error) => {
			log.error(`Failed to provision container for project ${project.slug}:`, error);
		}),
	);

	const agentSlugs = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id WHERE m.team_id = $1`,
		[team.id],
	);

	return {
		ok: true,
		team_id: team.id,
		team_slug: team.slug,
		project_id: project.id as string,
		project_slug: project.slug as string,
		planning_task_id: planningTask.id as string,
		planning_task_identifier: planningTask.identifier as string,
		created_agent_slugs: agentSlugs.rows.map((r) => r.slug),
	};
}
