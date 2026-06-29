import {
	GOAL_CHECK_FREQUENCY_LABELS,
	type GoalCheckRunSummary,
	type GoalWithProject,
	HeartbeatRunStatus,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Pencil, Plus, Target } from 'lucide-react';
import { useState } from 'react';
import { useGoalRuns, useGoals, useUpdateGoal } from '../hooks/use-goals';
import { CreateGoalDialog } from './create-goal-dialog';
import { GoalHealthPill } from './goal-health-pill';
import { GoalProgressChart } from './goal-progress-chart';
import { GoalSmartGuidance } from './goal-smart-guidance';
import { ProjectProgressSummary } from './project-progress-summary';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { HelpDialog } from './ui/help-dialog';

interface GoalsListProps {
	projectId: string;
}

type GoalView = 'active' | 'archived';

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

function GoalPanel({
	projectId,
	goal,
	onEdit,
}: {
	projectId: string;
	goal: GoalWithProject;
	onEdit: (goal: GoalWithProject) => void;
}) {
	const updateGoal = useUpdateGoal(projectId, goal.id);
	const isArchived = !!goal.archived_at;
	const percent = Math.max(0, Math.min(100, Math.round(goal.progress_percent)));

	return (
		<div
			data-testid="goal-panel"
			className={`flex flex-col gap-3 rounded-md border border-border bg-surface p-4 ${
				isArchived ? 'opacity-70' : ''
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<Link
					to="/projects/$projectId/goals/$goalId"
					params={{ projectId, goalId: goal.id }}
					data-testid="goal-open"
					className="flex min-w-0 flex-col gap-1.5 group"
				>
					<h3 className="text-sm font-semibold text-text-1 break-words group-hover:underline">
						{goal.title}
					</h3>
					<GoalHealthPill health={goal.health} testId="goal-health-pill" />
				</Link>
				<div className="flex shrink-0 items-center gap-0.5">
					<button
						type="button"
						onClick={() => onEdit(goal)}
						aria-label="Edit goal"
						title="Edit goal"
						data-testid="goal-edit"
						className="text-text-3 hover:text-text-1 transition-colors p-1"
					>
						<Pencil className="w-4 h-4" />
					</button>
					<button
						type="button"
						onClick={() => updateGoal.mutate({ archived: !isArchived })}
						disabled={updateGoal.isPending}
						aria-label={isArchived ? 'Unarchive goal' : 'Archive goal'}
						title={isArchived ? 'Unarchive goal' : 'Archive goal'}
						data-testid="goal-archive"
						className="text-text-3 hover:text-text-1 transition-colors p-1 disabled:opacity-50"
					>
						{isArchived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
					</button>
				</div>
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

			{goal.measurement && (
				<p className="text-xs text-text-3 leading-relaxed break-words">
					<span className="font-medium text-text-2">Achieved when:</span> {goal.measurement}
				</p>
			)}
			{goal.actions && (
				<p className="text-xs text-text-3 leading-relaxed break-words">
					<span className="font-medium text-text-2">Actions:</span> {goal.actions}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
				<span>{GOAL_CHECK_FREQUENCY_LABELS[goal.check_frequency]}</span>
				{goal.target_date && <span>Deadline: {formatTargetDate(goal.target_date)}</span>}
				{isArchived && <span className="text-text-2">Archived</span>}
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
				Goal heartbeat runs
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

function ViewFilter({ view, onChange }: { view: GoalView; onChange: (v: GoalView) => void }) {
	return (
		<div
			data-testid="goals-view-filter"
			className="inline-flex rounded-md border border-border bg-surface p-0.5 text-xs"
		>
			{(['active', 'archived'] as const).map((v) => (
				<button
					key={v}
					type="button"
					onClick={() => onChange(v)}
					data-testid={`goals-view-${v}`}
					className={`rounded px-2.5 py-1 capitalize transition-colors ${
						view === v ? 'bg-surface-3 text-text-1' : 'text-text-3 hover:text-text-1'
					}`}
				>
					{v}
				</button>
			))}
		</div>
	);
}

export function GoalsList({ projectId }: GoalsListProps) {
	const [view, setView] = useState<GoalView>('active');
	const [createOpen, setCreateOpen] = useState(false);
	const [editingGoal, setEditingGoal] = useState<GoalWithProject | null>(null);

	// Active view fetches only live goals; archived view fetches everything and filters to the
	// archived ones, so the same query cache backs both tabs.
	const { data: allGoals, isLoading } = useGoals(projectId, {
		includeArchived: view === 'archived',
	});
	const goals = (allGoals ?? []).filter((g) =>
		view === 'archived' ? !!g.archived_at : !g.archived_at,
	);

	if (isLoading) {
		return (
			<div data-testid="goals-list-loading" className="text-text-2 text-[13px] py-8 text-center">
				Loading...
			</div>
		);
	}

	// First-run empty state (no goals at all): the hero CTA. Shown only on the active tab.
	if (view === 'active' && goals.length === 0) {
		return (
			<div>
				<ProjectProgressSummary projectId={projectId} />
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
			<ProjectProgressSummary projectId={projectId} />
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h1 className="text-lg font-semibold text-text-1">Goals</h1>
					<HelpDialog
						title="What makes a good goal?"
						triggerLabel="What makes a good goal?"
						data-testid="goals-help"
					>
						<div className="flex flex-col gap-3">
							<p className="text-sm text-text-2 leading-relaxed">
								Goals are the outcomes the Captain steers the team toward. Write each one so
								progress is unambiguous — strong goals follow the{' '}
								<span className="font-semibold">SMART</span> framework:
							</p>
							<GoalSmartGuidance className="border-0 bg-transparent p-0" />
						</div>
					</HelpDialog>
					<ViewFilter view={view} onChange={setView} />
				</div>
				<Button onClick={() => setCreateOpen(true)} data-testid="goals-new-goal">
					<Plus className="w-4 h-4" />
					New goal
				</Button>
			</div>

			{goals.length === 0 ? (
				<div className="py-12 text-center text-[13px] text-text-3" data-testid="goals-empty-view">
					{view === 'archived' ? 'No archived goals.' : 'No active goals.'}
				</div>
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{goals.map((goal) => (
						<GoalPanel key={goal.id} projectId={projectId} goal={goal} onEdit={setEditingGoal} />
					))}
				</div>
			)}

			<GoalChecksFooter projectId={projectId} />

			<CreateGoalDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
			<CreateGoalDialog
				projectId={projectId}
				goal={editingGoal}
				open={!!editingGoal}
				onOpenChange={(o) => !o && setEditingGoal(null)}
			/>
		</div>
	);
}
