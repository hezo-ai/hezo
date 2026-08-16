import { INSTANCE_AGENT_SLUGS, isRunOutcomeFilter, RunOutcomeFilter } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { InfiniteScrollSentinel } from '../../../../../../components/infinite-scroll-sentinel';
import { Badge } from '../../../../../../components/ui/badge';
import { FilterPills } from '../../../../../../components/ui/filter-pills';
import { RelativeTime } from '../../../../../../components/ui/relative-time';
import { Tooltip } from '../../../../../../components/ui/tooltip';
import { useAgent } from '../../../../../../hooks/use-agents';
import { useElapsedDuration } from '../../../../../../hooks/use-elapsed-duration';
import {
	type HeartbeatRun,
	isActiveRunStatus,
	useHeartbeatRuns,
} from '../../../../../../hooks/use-heartbeat-runs';
import { useI18n } from '../../../../../../lib/i18n';
import { formatTriggerReason } from '../../../../../../lib/run-trigger';

function statusColor(status: string): string {
	switch (status) {
		case 'succeeded':
			return 'green';
		case 'failed':
		case 'timed_out':
			return 'red';
		case 'running':
		case 'queued':
			return 'yellow';
		case 'cancelled':
			return 'neutral';
		default:
			return 'neutral';
	}
}

function ExecutionRow({
	run,
	projectId,
	agentId,
	isInstanceAgent,
	filter,
}: {
	run: HeartbeatRun;
	projectId: string;
	agentId: string;
	isInstanceAgent: boolean;
	filter: RunOutcomeFilter;
}) {
	const elapsed = useElapsedDuration(run.started_at ?? '', run.finished_at);
	const trigger = formatTriggerReason(run, projectId);
	const projectLabel = run.project_name ?? run.project_slug;

	// The title band carries the task title and, for an instance agent, which
	// project the task lives in - both only ever shown for a run that has a task.
	const showTitle =
		!!run.task_identifier && (!!run.task_title || (isInstanceAgent && !!projectLabel));

	// Mobile-first: the row wraps into three bands - status + task id + when,
	// then the task title on its own line, then the meta strip. The `w-full` on
	// the title is what forces the band breaks (a full-width item can share a
	// flex line with nothing), and `order-*` lifts the timestamp up beside the
	// id, since its DOM position is the desktop one - after the trigger. Every
	// override drops at `sm`, where the row is the single line it has always
	// been. DOM order stays the desktop order so the accessible name reads
	// status, task, trigger, timing in that sequence at both sizes.
	return (
		<Link
			to="/projects/$projectId/agents/$agentId/executions/$runId"
			params={{ projectId, agentId, runId: run.id }}
			// Carried so the detail page's back link can put the reader back in the
			// view they left. Without it, returning from an errored run landed on a
			// view that may not contain it.
			search={filter === RunOutcomeFilter.All ? {} : { filter }}
			data-testid="execution-row"
			className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-xs hover:bg-surface-2 transition-colors sm:flex-nowrap sm:gap-2"
		>
			<Badge color={statusColor(run.status) as 'green'} className="order-1 sm:order-none">
				{(run.status === 'running' || run.status === 'queued') && (
					<span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1" />
				)}
				{run.status}
			</Badge>

			{run.task_identifier && (
				<span className="order-2 text-text-2 font-mono whitespace-nowrap sm:order-none">
					{run.task_identifier}
				</span>
			)}

			{showTitle && (
				<span
					data-testid="execution-row-title"
					className="order-4 w-full line-clamp-2 text-text-1 sm:order-none sm:w-auto sm:line-clamp-none"
				>
					{run.task_title}
					{isInstanceAgent && projectLabel && (
						<span data-testid="run-row-project" className="ml-1.5 text-text-3">
							· {projectLabel}
						</span>
					)}
				</span>
			)}

			{/* Capped rather than free-shrinking on mobile: a flex line only shrinks
			    its items once they overflow it, so an untruncated long trigger would
			    take the whole meta band and push the timing figures onto a fourth. */}
			<Tooltip content={trigger.text}>
				<span className="order-5 max-w-[55%] truncate text-text-3 sm:order-none sm:max-w-none">
					{trigger.text}
				</span>
			</Tooltip>

			{/* A run only stamps started_at when it goes running, so this slot keyed
			    on it alone read "queued" for every run that ended before it started -
			    an orphaned or capacity-cancelled row said `failed … queued`. The word
			    belongs to a genuinely live run; everything else is placed by the
			    clock it does have, created_at. */}
			{isActiveRunStatus(run.status) && !run.started_at ? (
				<span className="order-3 text-text-2 ml-auto whitespace-nowrap sm:order-none">queued</span>
			) : (
				<RelativeTime
					iso={run.started_at ?? run.created_at}
					className="order-3 text-text-2 ml-auto whitespace-nowrap sm:order-none"
				/>
			)}

			<span className="order-6 text-text-3 whitespace-nowrap sm:order-none">{elapsed}</span>

			{run.cost_cents != null && run.cost_cents > 0 && (
				<span className="order-7 text-text-3 whitespace-nowrap sm:order-none">
					${(run.cost_cents / 100).toFixed(2)}
				</span>
			)}

			{run.exit_code !== null && run.exit_code !== 0 && (
				<span className="order-8 text-danger whitespace-nowrap sm:order-none">
					exit: {run.exit_code}
				</span>
			)}
		</Link>
	);
}

function ExecutionListPage() {
	const { projectId, agentId } = Route.useParams();
	const { filter = RunOutcomeFilter.All } = Route.useSearch();
	const navigate = Route.useNavigate();
	const { t } = useI18n();
	const {
		data: runPages,
		isLoading,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useHeartbeatRuns(projectId, agentId, { filter });
	const { data: agent } = useAgent(projectId, agentId);

	// Flatten the accumulated pages, deduping by id: offset pagination + the 10s
	// poll can transiently overlap a page boundary when a new run prepends.
	const runs = useMemo(() => {
		const seen = new Set<string>();
		const out: HeartbeatRun[] = [];
		for (const run of runPages?.pages.flatMap((p) => p.data) ?? []) {
			if (seen.has(run.id)) continue;
			seen.add(run.id);
			out.push(run);
		}
		return out;
	}, [runPages]);

	// CEO/Coach runs span many projects (the list is member-scoped), so show each
	// row's project. Gate on the agent slug — see the run-detail page for why.
	const isInstanceAgent =
		!!agent && (INSTANCE_AGENT_SLUGS as readonly string[]).includes(agent.slug);

	function setFilter(next: RunOutcomeFilter) {
		navigate({
			search: (prev) => ({
				...(prev as ExecutionsSearch),
				filter: next === RunOutcomeFilter.All ? undefined : next,
			}),
			replace: true,
		});
	}

	// The pills render above every state, never inside the list branch: a reader
	// who filters down to nothing must still have the control that gets them back.
	return (
		<div className="flex flex-col gap-1">
			<FilterPills
				className="mb-3"
				options={[
					{ value: RunOutcomeFilter.All, label: t('executions.filter.all') },
					{ value: RunOutcomeFilter.Succeeded, label: t('executions.filter.succeeded') },
					{ value: RunOutcomeFilter.Errored, label: t('executions.filter.errored') },
				]}
				value={filter}
				onChange={setFilter}
			/>
			{isLoading ? (
				<div className="text-text-2 text-sm">{t('executions.loading')}</div>
			) : runs.length === 0 ? (
				<div className="text-text-2 text-sm py-4">
					{/* "No executions yet" is only true of the unfiltered view. The
					    default view hides errored runs, so an agent whose runs all
					    errored would otherwise be told it has never run at all. */}
					{filter === RunOutcomeFilter.All ? t('executions.empty') : t('executions.emptyFiltered')}
				</div>
			) : (
				<>
					{runs.map((run) => (
						<ExecutionRow
							key={run.id}
							run={run}
							projectId={projectId}
							agentId={agentId}
							isInstanceAgent={isInstanceAgent}
							filter={filter}
						/>
					))}
					<InfiniteScrollSentinel
						hasNextPage={hasNextPage}
						isFetchingNextPage={isFetchingNextPage}
						onLoadMore={fetchNextPage}
						testId="executions"
					/>
				</>
			)}
		</div>
	);
}

interface ExecutionsSearch {
	/** Run-outcome filter - absent means the default All view. */
	filter?: RunOutcomeFilter;
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/executions/')({
	// The default is dropped rather than written, so `?filter=all` and no param
	// cannot become two cache entries holding the same rows.
	validateSearch: (search: Record<string, unknown>): ExecutionsSearch => ({
		filter:
			isRunOutcomeFilter(search.filter) && search.filter !== RunOutcomeFilter.All
				? search.filter
				: undefined,
	}),
	component: ExecutionListPage,
});
