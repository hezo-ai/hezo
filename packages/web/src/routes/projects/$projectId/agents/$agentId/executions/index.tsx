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
import { type HeartbeatRun, useHeartbeatRuns } from '../../../../../../hooks/use-heartbeat-runs';
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
}: {
	run: HeartbeatRun;
	projectId: string;
	agentId: string;
	isInstanceAgent: boolean;
}) {
	const elapsed = useElapsedDuration(run.started_at ?? '', run.finished_at);
	const trigger = formatTriggerReason(run, projectId);
	const projectLabel = run.project_name ?? run.project_slug;

	return (
		<Link
			to="/projects/$projectId/agents/$agentId/executions/$runId"
			params={{ projectId, agentId, runId: run.id }}
			data-testid="execution-row"
			className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-xs hover:bg-surface-2 transition-colors"
		>
			<Badge color={statusColor(run.status) as 'green'}>
				{(run.status === 'running' || run.status === 'queued') && (
					<span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1" />
				)}
				{run.status}
			</Badge>

			{run.task_identifier && (
				<span className="text-text-2 font-mono">
					{run.task_identifier}
					{run.task_title && <span className="font-sans ml-1.5 text-text-1">{run.task_title}</span>}
					{isInstanceAgent && projectLabel && (
						<span data-testid="run-row-project" className="font-sans ml-1.5 text-text-3">
							· {projectLabel}
						</span>
					)}
				</span>
			)}

			<Tooltip content={trigger.text}>
				<span className="text-text-3 truncate">{trigger.text}</span>
			</Tooltip>

			{run.started_at ? (
				<RelativeTime iso={run.started_at} className="text-text-2 ml-auto whitespace-nowrap" />
			) : (
				<span className="text-text-2 ml-auto whitespace-nowrap">queued</span>
			)}

			<span className="text-text-3 whitespace-nowrap">{elapsed}</span>

			{run.cost_cents != null && run.cost_cents > 0 && (
				<span className="text-text-3 whitespace-nowrap">${(run.cost_cents / 100).toFixed(2)}</span>
			)}

			{run.exit_code !== null && run.exit_code !== 0 && (
				<span className="text-danger whitespace-nowrap">exit: {run.exit_code}</span>
			)}
		</Link>
	);
}

function ExecutionListPage() {
	const { projectId, agentId } = Route.useParams();
	const { filter = RunOutcomeFilter.Runs } = Route.useSearch();
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
				filter: next === RunOutcomeFilter.Runs ? undefined : next,
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
					{ value: RunOutcomeFilter.Runs, label: t('executions.filter.runs') },
					{ value: RunOutcomeFilter.Errored, label: t('executions.filter.errored') },
					{ value: RunOutcomeFilter.All, label: t('executions.filter.all') },
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
	/** Run-outcome filter - absent means the default Runs view. */
	filter?: RunOutcomeFilter;
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/executions/')({
	// The default is dropped rather than written, so `?filter=runs` and no param
	// cannot become two cache entries holding the same rows.
	validateSearch: (search: Record<string, unknown>): ExecutionsSearch => ({
		filter:
			isRunOutcomeFilter(search.filter) && search.filter !== RunOutcomeFilter.Runs
				? search.filter
				: undefined,
	}),
	component: ExecutionListPage,
});
