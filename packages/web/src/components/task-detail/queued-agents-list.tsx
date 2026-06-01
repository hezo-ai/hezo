import { Loader2, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCancelQueuedWakeup } from '../../hooks/use-cancel-queued-wakeup';
import type { QueuedDispatchState, QueuedWakeup } from '../../hooks/use-queued-wakeups';
import { useRunQueuedWakeup } from '../../hooks/use-run-queued-wakeup';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';

interface QueuedAgentsListProps {
	teamId: string;
	taskId: string;
	wakeups: QueuedWakeup[];
	dispatch: QueuedDispatchState;
}

/**
 * Human-readable reason the run-now action is unavailable, or null when it can
 * run. Mirrors the gating order of `JobManager.dispatchWakeupNow` on the server.
 */
function runNowBlockReason(wakeup: QueuedWakeup, dispatch: QueuedDispatchState): string | null {
	if (dispatch.task_busy) return 'This ticket already has a run in progress';
	if (dispatch.project_at_capacity) return 'Project is at its concurrent-run limit';
	if (wakeup.run_now_blocked === 'blocked_by_dependency') return 'Blocked by an open dependency';
	return null;
}

export function QueuedAgentsList({ teamId, taskId, wakeups, dispatch }: QueuedAgentsListProps) {
	if (wakeups.length === 0) return null;

	return (
		<div data-testid="queued-agents-list">
			<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
				Queued to run
			</span>
			<div className="flex flex-col gap-1">
				{wakeups.map((w) => (
					<QueuedAgentRow
						key={w.id}
						teamId={teamId}
						taskId={taskId}
						wakeup={w}
						dispatch={dispatch}
					/>
				))}
			</div>
		</div>
	);
}

function QueuedAgentRow({
	teamId,
	taskId,
	wakeup,
	dispatch,
}: {
	teamId: string;
	taskId: string;
	wakeup: QueuedWakeup;
	dispatch: QueuedDispatchState;
}) {
	const [open, setOpen] = useState(false);
	const cancelMutation = useCancelQueuedWakeup({ teamId, taskId });
	const runMutation = useRunQueuedWakeup({ teamId, taskId });
	const blockReason = runNowBlockReason(wakeup, dispatch);

	return (
		<div
			data-testid={`queued-agent-${wakeup.id}`}
			className="flex items-center justify-between gap-2 text-[13px] text-text"
		>
			<span className="truncate min-w-0">{wakeup.member_name}</span>
			<div className="flex items-center gap-1 shrink-0">
				{blockReason ? (
					// aria-disabled (not the native `disabled` attribute) keeps the button
					// emitting pointer events so the Radix tooltip still shows the reason.
					<Tooltip content={blockReason}>
						<button
							type="button"
							aria-disabled="true"
							aria-label={`Run now unavailable: ${blockReason}`}
							data-testid={`run-queued-wakeup-${wakeup.id}`}
							onClick={(e) => e.preventDefault()}
							className="inline-flex items-center justify-center h-6 w-6 text-accent-green opacity-40 cursor-not-allowed rounded-radius-md"
						>
							<Play className="w-3.5 h-3.5" />
						</button>
					</Tooltip>
				) : (
					<Tooltip content="Run now">
						<button
							type="button"
							onClick={() => runMutation.mutate(wakeup.id)}
							aria-label="Run queued agent now"
							data-testid={`run-queued-wakeup-${wakeup.id}`}
							disabled={runMutation.isPending}
							className="inline-flex items-center justify-center h-6 w-6 text-accent-green hover:bg-accent-green/10 rounded-radius-md transition-colors"
						>
							{runMutation.isPending ? (
								<Loader2 className="w-3.5 h-3.5 animate-spin" />
							) : (
								<Play className="w-3.5 h-3.5" />
							)}
						</button>
					</Tooltip>
				)}
				<Tooltip content="Cancel queued run">
					<button
						type="button"
						onClick={() => setOpen(true)}
						aria-label="Cancel queued agent"
						data-testid={`cancel-queued-wakeup-${wakeup.id}`}
						disabled={cancelMutation.isPending}
						className="inline-flex items-center justify-center h-6 w-6 text-accent-red hover:bg-accent-red/10 rounded-radius-md transition-colors"
					>
						<Trash2 className="w-3.5 h-3.5" />
					</button>
				</Tooltip>
			</div>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Cancel queued agent?"
				description={`${wakeup.member_name} will be removed from the queue and won't run on this task.`}
				confirmLabel="Cancel run"
				cancelLabel="Keep queued"
				variant="danger"
				loading={cancelMutation.isPending}
				onConfirm={async () => {
					await cancelMutation.mutateAsync(wakeup.id);
				}}
			/>
		</div>
	);
}
