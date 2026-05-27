import { Square } from 'lucide-react';
import { useState } from 'react';
import { isActiveRunStatus, type RunStatus } from '../hooks/use-heartbeat-runs';
import { useTerminateRun } from '../hooks/use-terminate-run';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Tooltip } from './ui/tooltip';

interface TerminateRunButtonProps {
	teamId: string;
	agentId: string;
	runId: string;
	status: RunStatus;
	taskId?: string | null;
	variant?: 'compact' | 'standalone';
}

export function TerminateRunButton({
	teamId,
	agentId,
	runId,
	status,
	taskId,
	variant = 'compact',
}: TerminateRunButtonProps) {
	const [open, setOpen] = useState(false);
	const mutation = useTerminateRun({ teamId, agentId, runId, taskId });

	if (!isActiveRunStatus(status)) return null;

	const triggerClass =
		variant === 'compact'
			? 'inline-flex items-center justify-center h-6 px-2 text-xs text-accent-red hover:bg-accent-red/10 rounded-radius-md transition-colors'
			: 'inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-muted hover:text-accent-red border border-border hover:border-accent-red bg-bg-subtle hover:bg-bg-muted rounded-radius-md transition-colors';

	return (
		<>
			<Tooltip content="Terminate run">
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-label="Terminate run"
					data-testid="terminate-run-button"
					disabled={mutation.isPending}
					className={triggerClass}
				>
					<Square className="w-3 h-3" fill="currentColor" />
					{variant === 'standalone' && <span>Terminate</span>}
				</button>
			</Tooltip>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Terminate this run?"
				description="The agent will be aborted immediately. Any in-progress work in this run will be lost."
				confirmLabel="Terminate"
				cancelLabel="Cancel"
				variant="danger"
				loading={mutation.isPending}
				onConfirm={async () => {
					await mutation.mutateAsync();
				}}
			/>
		</>
	);
}
