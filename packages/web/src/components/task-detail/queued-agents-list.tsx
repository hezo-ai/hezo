import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useCancelQueuedWakeup } from '../../hooks/use-cancel-queued-wakeup';
import type { QueuedWakeup } from '../../hooks/use-queued-wakeups';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Tooltip } from '../ui/tooltip';

interface QueuedAgentsListProps {
	teamId: string;
	taskId: string;
	wakeups: QueuedWakeup[];
}

export function QueuedAgentsList({ teamId, taskId, wakeups }: QueuedAgentsListProps) {
	if (wakeups.length === 0) return null;

	return (
		<div data-testid="queued-agents-list">
			<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
				Queued to run
			</span>
			<div className="flex flex-col gap-1">
				{wakeups.map((w) => (
					<QueuedAgentRow key={w.id} teamId={teamId} taskId={taskId} wakeup={w} />
				))}
			</div>
		</div>
	);
}

function QueuedAgentRow({
	teamId,
	taskId,
	wakeup,
}: {
	teamId: string;
	taskId: string;
	wakeup: QueuedWakeup;
}) {
	const [open, setOpen] = useState(false);
	const mutation = useCancelQueuedWakeup({ teamId, taskId });

	return (
		<div
			data-testid={`queued-agent-${wakeup.id}`}
			className="flex items-center justify-between gap-2 text-[13px] text-text"
		>
			<span className="truncate min-w-0">
				{wakeup.member_name}
				{wakeup.coalesced_count > 0 && (
					<span className="text-text-subtle"> ×{wakeup.coalesced_count + 1}</span>
				)}
			</span>
			<Tooltip content="Cancel queued run">
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-label="Cancel queued agent"
					data-testid={`cancel-queued-wakeup-${wakeup.id}`}
					disabled={mutation.isPending}
					className="inline-flex items-center justify-center h-6 w-6 shrink-0 text-accent-red hover:bg-accent-red/10 rounded-radius-md transition-colors"
				>
					<Trash2 className="w-3.5 h-3.5" />
				</button>
			</Tooltip>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Cancel queued agent?"
				description={`${wakeup.member_name} will be removed from the queue and won't run on this task.`}
				confirmLabel="Cancel run"
				cancelLabel="Keep queued"
				variant="danger"
				loading={mutation.isPending}
				onConfirm={async () => {
					await mutation.mutateAsync(wakeup.id);
				}}
			/>
		</div>
	);
}
