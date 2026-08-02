import { GOAL_CHECK_FREQUENCY_LABELS, type GoalWithProject } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { Pencil, Plus, Target } from 'lucide-react';
import { useState } from 'react';
import {
	GOAL_EXPLAINER_TOOLTIP,
	type GoalSuggestion,
	useGoalSuggestions,
	useGoals,
	useResolveGoalSuggestion,
} from '../hooks/use-goals';
import { useI18n } from '../lib/i18n';
import { CreateGoalDialog } from './create-goal-dialog';
import { GoalArchiveButton } from './goal-archive-button';
import { GoalHealthPill } from './goal-health-pill';
import { GoalSmartGuidance } from './goal-smart-guidance';
import { Breadcrumb } from './ui/breadcrumb';
import { Button } from './ui/button';
import { EmptyState } from './ui/empty-state';
import { HelpDialog } from './ui/help-dialog';
import { InfoTooltip } from './ui/info-tooltip';

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
					to="/projects/$projectId/progress/goals/$goalId"
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
					<GoalArchiveButton projectId={projectId} goal={goal} />
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

/** `Progress › Goals`, matching the sidebar nesting and the URL. */
function GoalsBreadcrumb({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const navigate = useNavigate();
	return (
		<Breadcrumb
			data-testid="goals-breadcrumb"
			segments={[
				{
					key: 'progress',
					label: t('nav.progress'),
					onNavigate: () =>
						navigate({ to: '/projects/$projectId/progress', params: { projectId } }),
				},
				{ key: 'goals', label: t('nav.goals') },
			]}
		/>
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

/**
 * Pending goal suggestions (Captain/CEO proposals) shown above the goals grid.
 * Each carries inline Approve (creates the real goal) / Deny. Renders nothing when
 * there are no pending suggestions.
 */
function SuggestedGoals({
	projectId,
	suggestions,
}: {
	projectId: string;
	suggestions: GoalSuggestion[];
}) {
	const resolve = useResolveGoalSuggestion(projectId);
	if (suggestions.length === 0) return null;

	return (
		<div className="mb-4" data-testid="goal-suggestions">
			<div className="mb-2 flex items-center gap-1.5">
				<h2 className="text-sm font-semibold text-text-2">Suggested goals</h2>
				<InfoTooltip
					label="What is a goal?"
					content={GOAL_EXPLAINER_TOOLTIP}
					data-testid="suggested-goals-info"
				/>
			</div>
			<div className="flex flex-col gap-2">
				{suggestions.map((s) => (
					<div
						key={s.approval_id}
						className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft p-3 sm:flex-row sm:items-start sm:justify-between"
						data-testid="goal-suggestion-row"
					>
						<div className="min-w-0 flex items-start gap-2">
							<Target className="mt-0.5 h-4 w-4 shrink-0 text-warning-soft-fg" />
							<div className="min-w-0">
								<p className="text-sm font-medium text-text-1">{s.title}</p>
								{s.measurement && (
									<p className="mt-0.5 text-xs text-text-2">Measure: {s.measurement}</p>
								)}
								<p className="mt-0.5 text-xs text-text-3">
									Checked {s.check_frequency}
									{s.target_date ? ` · by ${s.target_date.slice(0, 10)}` : ''}
									{s.suggested_by_name ? ` · suggested by ${s.suggested_by_name}` : ''}
								</p>
							</div>
						</div>
						<div className="flex shrink-0 gap-2">
							<Button
								size="sm"
								disabled={resolve.isPending}
								onClick={() => resolve.mutate({ approvalId: s.approval_id, status: 'approved' })}
								data-testid="goal-suggestion-approve"
							>
								Approve
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={resolve.isPending}
								onClick={() => resolve.mutate({ approvalId: s.approval_id, status: 'denied' })}
								data-testid="goal-suggestion-deny"
							>
								Deny
							</Button>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function GoalsList({ projectId }: GoalsListProps) {
	const { t } = useI18n();
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
	const { data: suggestionsData } = useGoalSuggestions(projectId);
	const suggestions = suggestionsData ?? [];

	if (isLoading) {
		return (
			<div data-testid="goals-list-loading" className="text-text-2 text-[13px] py-8 text-center">
				{t('common.loading')}
			</div>
		);
	}

	// First-run empty state (no goals at all): the hero CTA. Shown only on the active
	// tab and only when there are no pending suggestions to act on either.
	if (view === 'active' && goals.length === 0 && suggestions.length === 0) {
		return (
			<div>
				<GoalsBreadcrumb projectId={projectId} />
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
			<GoalsBreadcrumb projectId={projectId} />
			<div className="mb-4 flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1.5">
					<h1 className="text-lg font-semibold text-text-1">{t('nav.goals')}</h1>
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

			{view === 'active' && <SuggestedGoals projectId={projectId} suggestions={suggestions} />}

			{goals.length === 0 ? (
				<div className="py-12 text-center text-[13px] text-text-3" data-testid="goals-empty-view">
					{view === 'archived'
						? 'No archived goals.'
						: suggestions.length > 0
							? 'No active goals yet — approve a suggestion above to create one.'
							: 'No active goals.'}
				</div>
			) : (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{goals.map((goal) => (
						<GoalPanel key={goal.id} projectId={projectId} goal={goal} onEdit={setEditingGoal} />
					))}
				</div>
			)}

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
