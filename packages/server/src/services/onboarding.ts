import type { PGlite } from '@electric-sql/pglite';
import { GoalStatus } from '@hezo/shared';
import { terminalStatusParams } from '../lib/sql';
import { ONBOARDING_INTAKE_LABEL } from './onboarding-intake';

export type OnboardingStageKey = 'intake' | 'done';
export type OnboardingStageStatus = 'complete' | 'current' | 'pending';

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
	goals: OnboardingGoalSummary[];
}

async function hasOpenIntakeLabel(db: PGlite, teamId: string, label: string): Promise<boolean> {
	const ts = terminalStatusParams(3);
	const result = await db.query<{ id: string }>(
		`SELECT id FROM issues
		 WHERE team_id = $1 AND labels @> $2::jsonb
		   AND status NOT IN (${ts.placeholders})
		 LIMIT 1`,
		[teamId, JSON.stringify([label]), ...ts.values],
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

export async function getOnboardingStatus(db: PGlite, teamId: string): Promise<OnboardingStatus> {
	const intakeOpen = await hasOpenIntakeLabel(db, teamId, ONBOARDING_INTAKE_LABEL);
	const primaryProject = await getPrimaryUserProject(db, teamId);

	const stages: Record<OnboardingStageKey, OnboardingStageStatus> = intakeOpen
		? { intake: 'current', done: 'pending' }
		: primaryProject
			? { intake: 'complete', done: 'complete' }
			: { intake: 'pending', done: 'pending' };

	const currentStage: OnboardingStageKey = intakeOpen || !primaryProject ? 'intake' : 'done';

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
		show_welcome: !primaryProject,
		current_stage: currentStage,
		stages,
		primary_project: primaryProject,
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

/** True when the team has at least one user-facing project. */
export async function isTeamExecutionStarted(db: PGlite, teamId: string): Promise<boolean> {
	const project = await getPrimaryUserProject(db, teamId);
	return !!project;
}
