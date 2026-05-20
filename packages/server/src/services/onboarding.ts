import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	CAPTAIN_AGENT_SLUG,
	GoalStatus,
	MemberType,
	TERMINAL_ISSUE_STATUSES,
	WakeupSource,
} from '@hezo/shared';
import { logger } from '../logger';
import { HIRE_TEAM_INTAKE_LABEL } from './hire-team-intake';
import { REQUIREMENTS_INTAKE_LABEL } from './requirements-intake';
import { createWakeup } from './wakeup';

const log = logger.child('onboarding');

export type OnboardingStageKey = 'requirements' | 'hire_team' | 'start_project';
export type OnboardingStageStatus = 'complete' | 'current' | 'pending';

export interface OnboardingAgentSummary {
	title: string;
	slug: string;
}

export interface OnboardingGoalSummary {
	id: string;
	title: string;
	status: string;
}

export interface OnboardingPrimaryProject {
	id: string;
	slug: string;
	name: string;
	description: string;
	planning_issue_id: string | null;
	planning_issue_identifier: string | null;
	planning_issue_title: string | null;
	execution_started_at: string | null;
}

export interface OnboardingStatus {
	show_welcome: boolean;
	current_stage: OnboardingStageKey;
	stages: Record<OnboardingStageKey, OnboardingStageStatus>;
	primary_project: OnboardingPrimaryProject | null;
	agents: OnboardingAgentSummary[];
	goals: OnboardingGoalSummary[];
}

async function hasOpenIntakeLabel(db: PGlite, teamId: string, label: string): Promise<boolean> {
	const terminalPlaceholders = TERMINAL_ISSUE_STATUSES.map(
		(_, i) => `$${i + 3}::issue_status`,
	).join(', ');
	const result = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE team_id = $1 AND labels @> $2::jsonb
		   AND status NOT IN (${terminalPlaceholders})
		 LIMIT 1`,
		[teamId, JSON.stringify([label]), ...TERMINAL_ISSUE_STATUSES],
	);
	return result.rows.length > 0;
}

async function getPrimaryUserProject(
	db: PGlite,
	teamId: string,
): Promise<OnboardingPrimaryProject | null> {
	const result = await db.query<{
		id: string;
		slug: string;
		name: string;
		description: string;
		execution_started_at: string | null;
		planning_issue_id: string | null;
		planning_issue_identifier: string | null;
		planning_issue_title: string | null;
	}>(
		`SELECT p.id, p.slug, p.name, p.description, p.execution_started_at,
		        pi.id AS planning_issue_id,
		        pi.identifier AS planning_issue_identifier,
		        pi.title AS planning_issue_title
		 FROM projects p
		 LEFT JOIN LATERAL (
		   SELECT i.id, i.identifier, i.title
		   FROM issues i
		   WHERE i.project_id = p.id AND i.labels @> '["planning"]'::jsonb
		   ORDER BY i.created_at ASC
		   LIMIT 1
		 ) pi ON true
		 WHERE p.team_id = $1 AND p.is_internal = false
		 ORDER BY p.created_at ASC
		 LIMIT 1`,
		[teamId],
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		planning_issue_id: row.planning_issue_id,
		planning_issue_identifier: row.planning_issue_identifier,
		planning_issue_title: row.planning_issue_title,
		execution_started_at: row.execution_started_at,
	};
}

function resolveStageStatuses(
	requirementsOpen: boolean,
	hireOpen: boolean,
	executionStarted: boolean,
): {
	current: OnboardingStageKey;
	stages: Record<OnboardingStageKey, OnboardingStageStatus>;
	showWelcome: boolean;
} {
	const requirementsDone = !requirementsOpen;
	const hireDone = requirementsDone && !hireOpen;

	const stages: Record<OnboardingStageKey, OnboardingStageStatus> = {
		requirements: requirementsOpen ? 'current' : 'complete',
		hire_team: requirementsOpen ? 'pending' : hireOpen ? 'current' : 'complete',
		start_project: executionStarted ? 'complete' : hireDone ? 'current' : 'pending',
	};

	let current: OnboardingStageKey = 'requirements';
	if (requirementsDone && hireOpen) current = 'hire_team';
	else if (hireDone && !executionStarted) current = 'start_project';
	else if (executionStarted) current = 'start_project';

	return { current, stages, showWelcome: !executionStarted };
}

export async function getOnboardingStatus(db: PGlite, teamId: string): Promise<OnboardingStatus> {
	const requirementsOpen = await hasOpenIntakeLabel(db, teamId, REQUIREMENTS_INTAKE_LABEL);
	const hireOpen = await hasOpenIntakeLabel(db, teamId, HIRE_TEAM_INTAKE_LABEL);
	const primaryProject = await getPrimaryUserProject(db, teamId);
	const executionStarted = !!primaryProject?.execution_started_at;

	const { current, stages, showWelcome } = resolveStageStatuses(
		requirementsOpen,
		hireOpen,
		executionStarted,
	);

	const agents = await db.query<{ title: string; slug: string }>(
		`SELECT ma.title, ma.slug
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND m.member_type = $2::member_type
		   AND ma.admin_status = $3::agent_admin_status
		   AND ma.slug NOT IN ($4, $5)
		 ORDER BY ma.title`,
		[teamId, MemberType.Agent, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG, 'coach'],
	);

	let goals: OnboardingGoalSummary[] = [];
	if (primaryProject) {
		const goalRows = await db.query<{ id: string; title: string; status: string }>(
			`SELECT id, title, status::text
			 FROM goals
			 WHERE team_id = $1 AND project_id = $2 AND status = $3::goal_status
			 ORDER BY created_at ASC`,
			[teamId, primaryProject.id, GoalStatus.Active],
		);
		goals = goalRows.rows;
	}

	return {
		show_welcome: showWelcome,
		current_stage: current,
		stages,
		primary_project: primaryProject,
		agents: agents.rows,
		goals,
	};
}

/** True when this team has no user-facing projects yet (onboarding first project). */
export async function isFirstUserFacingProject(db: PGlite, teamId: string): Promise<boolean> {
	const result = await db.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM projects
		 WHERE team_id = $1 AND is_internal = false`,
		[teamId],
	);
	return Number(result.rows[0]?.count ?? 0) === 0;
}

export async function confirmProjectExecutionStart(
	db: PGlite,
	teamId: string,
): Promise<{ project: OnboardingPrimaryProject } | { error: string }> {
	const requirementsOpen = await hasOpenIntakeLabel(db, teamId, REQUIREMENTS_INTAKE_LABEL);
	const hireOpen = await hasOpenIntakeLabel(db, teamId, HIRE_TEAM_INTAKE_LABEL);
	if (requirementsOpen || hireOpen) {
		return { error: 'Complete requirements gathering and team hiring before starting the project' };
	}

	const project = await getPrimaryUserProject(db, teamId);
	if (!project) {
		return { error: 'No project found to start' };
	}
	if (project.execution_started_at) {
		return { project };
	}

	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	if (!captain.rows[0]) {
		return { error: 'Captain is not available on this team' };
	}

	await db.query(
		`UPDATE projects SET execution_started_at = now(), updated_at = now() WHERE id = $1`,
		[project.id],
	);

	if (project.planning_issue_id) {
		await createWakeup(db, captain.rows[0].id, teamId, WakeupSource.Assignment, {
			issue_id: project.planning_issue_id,
		});
	} else {
		log.warn(`Project ${project.id} has no planning issue when starting execution`);
	}

	const updated = await getPrimaryUserProject(db, teamId);
	return { project: updated ?? { ...project, execution_started_at: new Date().toISOString() } };
}

/** True when the team's first user-facing project has not yet been confirmed for execution. */
export async function isTeamExecutionStarted(db: PGlite, teamId: string): Promise<boolean> {
	const project = await getPrimaryUserProject(db, teamId);
	return !!project?.execution_started_at;
}
