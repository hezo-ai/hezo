import {
	GOAL_CHECK_FREQUENCY_LABELS,
	type GoalCheckRunSummary,
	type GoalWithProject,
	HeartbeatRunStatus,
} from '@hezo/shared';
import { Archive, Plus, Target } from 'lucide-react';
import { useState } from 'react';
import { useArchiveGoal, useGoalRuns, useGoals } from '../hooks/use-goals';
import { CreateGoalDialog } from './create-goal-dialog';
import { GoalHealthPill } from './goal-health-pill';
import { GoalProgressChart } from './goal-progress-chart';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';

interface GoalsListProps {
	projectId: string;
}

function formatTargetDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRunTime(run: GoalCheckRunSummary): string {
	const iso = run.finished_at ?? run.started_at ?? run.created_at;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

function GoalPanel({ projectId, goal }: { projectId: string; goal: GoalWithProject }) {
	const archiveGoal = useArchiveGoal(projectId);
	const percent = Math.max(0, Math.min(100, Math.round(goal.progress_percent)));

	return (
		<div
			data-testid="goal-panel"
			className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
		>
			<div className="flex items-start justify-between gap-2">
				<div className="flex flex-col gap-1.5 min-w-0">
					<h3 className="text-sm font-semibold text-text-1 break-words">{goal.title}</h3>
					<GoalHealthPill health={goal.health} testId="goal-health-pill" />
				</div>
				<button
					type="button"
					onClick={() => archiveGoal.mutate(goal.id)}
					disabled={archiveGoal.isPending}
					aria-label="Archive goal"
					title="Archive goal"
					data-testid="goal-archive"
					className="shrink-0 text-text-3 hover:text-text-1 transition-colors p-1 -m-1 disabled:opacity-50"
				>
					<Archive className="w-4 h-4" />
				</button>
			</div>

			<div className="flex flex-col gap-1.5">
				<div className="flex items-baseline justify-between">
					<span className="text-2xl font-semibold text-text-1">{percent}%</span>
				</div>
				<div className="h-2 w-full overflow-hidden rounded-full bg-surface-3">
					<div
						className="h-full rounded-full bg-accent-solid transition-all"
						style={{ width: `${percent}%` }}
						data-testid="goal-progress-bar"
					/>
				</div>
			</div>

			<GoalProgressChart history={goal.history} size="compact" />

			{goal.status_blurb && (
				<p className="text-[13px] text-text-2 leading-relaxed break-words">{goal.status_blurb}</p>
			)}

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
				<span>{GOAL_CHECK_FREQUENCY_LABELS[goal.check_frequency]}</span>
				{goal.target_date && <span>Target: {formatTargetDate(goal.target_date)}</span>}
			</div>
		</div>
	);
}

function GoalChecksFooter({ projectId }: { projectId: string }) {
	const { data: runs, isLoading } = useGoalRuns(projectId);

	if (isLoading || !runs || runs.length === 0) return null;

	return (
		<section data-testid="goal-checks" className="mt-8">
			<h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3 mb-2 px-0.5">
				Goal checks
			</h2>
			<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
				{runs.map((run) => {
					const updated = run.updated_goal_titles.length > 0;
					return (
						<li
							key={run.id}
							data-testid="goal-check-run"
							className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
						>
							<span className="text-[13px] text-text-2">
								{formatRunTime(run)}
								{run.status !== HeartbeatRunStatus.Succeeded && (
									<span className="ml-2 text-text-3">({run.status})</span>
								)}
							</span>
							<span className="text-xs text-text-3 break-words">
								{updated ? `Updated goals: ${run.updated_goal_titles.join(', ')}` : 'No changes'}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export function GoalsList({ projectId }: GoalsListProps) {
	const { data: goals, isLoading } = useGoals(projectId);
	const [createOpen, setCreateOpen] = useState(false);

	if (isLoading) {
		return (
			<div data-testid="goals-list-loading" className="text-text-2 text-[13px] py-8 text-center">
				Loading...
			</div>
		);
	}

	if (!goals || goals.length === 0) {
		return (
			<div>
				<EmptyState
					variant="hero"
					icon={<Target className="w-8 h-8" />}
					title="No goals yet"
					description="Create the first goal for the team to work towards"
					action={
						<Button size="lg" onClick={() => setCreateOpen(true)} data-testid="goals-empty-create">
							<Plus className="w-4 h-4" />
							Create Goal
						</Button>
					}
				/>
				<CreateGoalDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
			</div>
		);
	}

	return (
		<div>
			<div className="mb-4 flex items-center justify-between gap-2">
				<h1 className="text-lg font-semibold text-text-1">Goals</h1>
				<Button onClick={() => setCreateOpen(true)} data-testid="goals-new-goal">
					<Plus className="w-4 h-4" />
					New goal
				</Button>
			</div>

			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{goals.map((goal) => (
					<GoalPanel key={goal.id} projectId={projectId} goal={goal} />
				))}
			</div>

			<GoalChecksFooter projectId={projectId} />

			<CreateGoalDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}
