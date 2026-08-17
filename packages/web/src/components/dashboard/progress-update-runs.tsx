import { Clock, RotateCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	useCancelQueuedProgressRun,
	useGoalQueuedRun,
	useGoalRuns,
	useRunProgressUpdateNow,
} from '../../hooks/use-goals';
import { useI18n } from '../../lib/i18n';
import { RunCommentBody } from '../comment-renderers/run-comment';
import { InfiniteScrollSentinel } from '../infinite-scroll-sentinel';
import { LazyMount } from '../lazy-mount';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';

/**
 * The project's progress-update run history, at the bottom of the project dashboard. It sits with
 * the summary rather than with goals: a progress-update run rewrites the summary whether or not
 * the project has any goals, so this is the history of the band at the top of this same page.
 */
function QueuedProgressRunRow({ projectId, wakeupId }: { projectId: string; wakeupId: string }) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const cancel = useCancelQueuedProgressRun(projectId);

	return (
		<div
			data-testid="progress-update-queued-row"
			className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2.5"
		>
			<div className="flex min-w-0 items-center gap-2 text-[13px] text-text-2">
				<Clock className="h-3.5 w-3.5 shrink-0 text-text-3" />
				<span className="truncate">{t('progress.runs.queued')}</span>
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

export function ProgressUpdateRuns({ projectId }: { projectId: string }) {
	const { t } = useI18n();
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
					{t('progress.runs.heading')}
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
					{runNow.isPending ? t('progress.runs.running') : t('progress.runs.runNow')}
				</Button>
			</div>
			{queuedRun && <QueuedProgressRunRow projectId={projectId} wakeupId={queuedRun.id} />}
			{!hasRuns ? (
				<div
					data-testid="progress-updates-empty"
					className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[13px] text-text-3"
				>
					{t('progress.runs.empty')}
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
								{/* Collapsible run card - the same summary/expand/log UI as an agent run on a task. */}
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
