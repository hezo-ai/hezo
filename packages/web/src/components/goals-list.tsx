import { GOAL_CHECK_FREQUENCY_LABELS, type GoalWithProject } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import {
	Archive,
	ArchiveRestore,
	Clock,
	Pencil,
	Plus,
	RotateCw,
	Target,
	Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	useCancelQueuedProgressRun,
	useGoalQueuedRun,
	useGoalRuns,
	useGoals,
	useRunProgressUpdateNow,
	useUpdateGoal,
} from '../hooks/use-goals';
import { RunCommentBody } from './comment-renderers/run-comment';
import { CreateGoalDialog } from './create-goal-dialog';
import { GoalHealthPill } from './goal-health-pill';
import { GoalSmartGuidance } from './goal-smart-guidance';
import { InfiniteScrollSentinel } from './infinite-scroll-sentinel';
import { LazyMount } from './lazy-mount';
import { ProjectProgressSummary } from './project-progress-summary';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { EmptyState } from './ui/empty-state';
import { HelpDialog } from './ui/help-dialog';
import { Tooltip } from './ui/tooltip';

interface GoalsListProps {
	projectId: string;
}

type GoalView = 'active' | 'archived';

function formatTargetDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

	// The whole card is a stretched link to the goal's detail page (its expanded view).
	// `before:absolute before:inset-0` makes the card surface clickable; the edit/archive
	// buttons sit above it (`relative z-10`) so they stay independently clickable.
	return (
		<div
			data-testid="goal-panel"
			className={`relative flex flex-col gap-3 rounded-md border border-border bg-surface p-4 transition-colors hover:border-border-strong ${
				isArchived ? 'opacity-70' : ''
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<Link
					to="/projects/$projectId/goals/$goalId"
					params={{ projectId, goalId: goal.id }}
					data-testid="goal-open"
					aria-label={`Open goal ${goal.title}`}
					className="flex min-w-0 flex-col gap-1.5 before:absolute before:inset-0 before:rounded-md"
				>
					<h3 className="text-sm font-semibold text-text-1 break-words hover:underline">
						{goal.title}
					</h3>
					<GoalHealthPill health={goal.health} testId="goal-health-pill" />
				</Link>
				<div className="relative z-10 flex shrink-0 items-center gap-0.5">
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

			{goal.status_blurb && (
				<p className="text-[13px] text-text-2 leading-relaxed break-words line-clamp-3">
					{goal.status_blurb}
				</p>
			)}

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-3">
				<span>Checked {GOAL_CHECK_FREQUENCY_LABELS[goal.check_frequency]}</span>
				{goal.target_date && <span>Deadline: {formatTargetDate(goal.target_date)}</span>}
				{isArchived && <span className="text-text-2">Archived</span>}
			</div>
		</div>
	);
}

function QueuedProgressRunRow({ projectId, wakeupId }: { projectId: string; wakeupId: string }) {
	const [open, setOpen] = useState(false);
	const cancel = useCancelQueuedProgressRun(projectId);

	return (
		<div
			data-testid="progress-update-queued-row"
			className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2.5"
		>
			<div className="flex min-w-0 items-center gap-2 text-[13px] text-text-2">
				<Clock className="h-3.5 w-3.5 shrink-0 text-text-3" />
				<span className="truncate">Queued — waiting for the Captain to finish</span>
			</div>
			<Tooltip content="Cancel queued progress update">
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-label="Cancel queued progress update"
					data-testid="cancel-queued-progress-run"
					disabled={cancel.isPending}
					className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-danger transition-colors hover:bg-danger/10"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
			</Tooltip>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Cancel queued progress update?"
				description="The queued progress update will be removed and won't run."
				confirmLabel="Cancel run"
				cancelLabel="Keep queued"
				variant="danger"
				loading={cancel.isPending}
				onConfirm={async () => {
					await cancel.mutateAsync(wakeupId);
				}}
			/>
		</div>
	);
}

function ProgressUpdatesFooter({ projectId }: { projectId: string }) {
	const { data: runPages, hasNextPage, isFetchingNextPage, fetchNextPage } = useGoalRuns(projectId);
	const { data: queued } = useGoalQueuedRun(projectId);
	const runNow = useRunProgressUpdateNow(projectId);
	// Flatten accumulated pages, deduping by id (offset pagination + new runs
	// prepending can transiently overlap a page boundary).
	const runs = useMemo(() => {
		const seen = new Set<string>();
		return (runPages?.pages.flatMap((p) => p.data) ?? []).filter((run) =>
			seen.has(run.id) ? false : (seen.add(run.id), true),
		);
	}, [runPages]);
	const hasRuns = runs.length > 0;
	const queuedRun = queued?.queued ?? null;

	return (
		<section data-testid="progress-updates" className="mt-8">
			<div className="mb-2 flex items-center justify-between gap-2 px-0.5">
				<h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
					Progress update runs
				</h2>
				<Button
					variant="secondary"
					size="sm"
					onClick={() => runNow.mutate()}
					disabled={runNow.isPending}
					data-testid="progress-update-run-now"
					title="Run the Captain's progress update now"
				>
					<RotateCw className={`h-3.5 w-3.5 ${runNow.isPending ? 'animate-spin' : ''}`} />
					{runNow.isPending ? 'Running…' : 'Run now'}
				</Button>
			</div>
			{queuedRun && <QueuedProgressRunRow projectId={projectId} wakeupId={queuedRun.id} />}
			{!hasRuns ? (
				<div
					data-testid="progress-updates-empty"
					className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[13px] text-text-3"
				>
					No progress updates yet.
				</div>
			) : (
				<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
					{runs.map((run) => {
						const updated = run.updated_goal_titles.length > 0;
						return (
							<li
								key={run.id}
								data-testid="progress-update-run"
								className="flex flex-col gap-1.5 px-3 py-2.5"
							>
								{/* Collapsible run card — the same summary/expand/log UI as an agent run on a task. */}
								<LazyMount minHeight={32} testId="progress-update-run-lazy">
									<RunCommentBody
										projectId={projectId}
										runId={run.id}
										agentId={run.member_id}
										agentTitle={run.agent_title}
										agentSlug={run.agent_slug}
										actorName={null}
										createdAt={run.created_at}
										inline
									/>
								</LazyMount>
								{updated && (
									<p
										className="text-xs text-text-3 break-words"
										data-testid="progress-update-run-goals"
									>
										Updated goals: {run.updated_goal_titles.join(', ')}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{hasRuns && (
				<InfiniteScrollSentinel
					hasNextPage={hasNextPage}
					isFetchingNextPage={isFetchingNextPage}
					onLoadMore={fetchNextPage}
					testId="progress-update-runs"
				/>
			)}
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
				{view === 'active' && (
					<Button
						size="sm"
						onClick={() => setCreateOpen(true)}
						data-testid="goals-new-goal"
						aria-label="New goal"
						title="New goal"
					>
						<Plus className="w-4 h-4" />
						{/* Label appears at the desktop breakpoint; icon-only below it. */}
						<span className="hidden lg:inline">New goal</span>
					</Button>
				)}
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

			<ProgressUpdatesFooter projectId={projectId} />

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
