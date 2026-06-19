import { Square } from 'lucide-react';
import { useState } from 'react';
import { isActiveRunStatus, type RunStatus } from '../hooks/use-heartbeat-runs';
import { useTerminateRun } from '../hooks/use-terminate-run';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Tooltip } from './ui/tooltip';

interface TerminateRunButtonProps {
	projectId: string;
	agentId: string;
	runId: string;
	status: RunStatus;
	taskId?: string | null;
}

export function TerminateRunButton({
	projectId,
	agentId,
	runId,
	status,
	taskId,
}: TerminateRunButtonProps) {
	const [open, setOpen] = useState(false);
	const mutation = useTerminateRun({ projectId, agentId, runId, taskId });

	if (!isActiveRunStatus(status)) return null;

	return (
		<>
			<Tooltip content="Terminate run">
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-label="Terminate run"
					data-testid="terminate-run-button"
					disabled={mutation.isPending}
					className="inline-flex items-center justify-center h-6 px-2 text-xs text-danger hover:bg-danger/10 rounded-md transition-colors"
				>
					<Square className="w-3 h-3" fill="currentColor" />
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
