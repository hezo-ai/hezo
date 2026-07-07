import { HeartbeatRunStatus } from './types/common.js';

export function isLastRunFailed(hasActiveRun: boolean, lastRunStatus: string | null): boolean {
	return (
		!hasActiveRun &&
		(lastRunStatus === HeartbeatRunStatus.Failed || lastRunStatus === HeartbeatRunStatus.TimedOut)
	);
}
