import { Link } from '@tanstack/react-router';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { LatestRunForIssue } from '../hooks/use-heartbeat-runs';
import { useRunLogs } from '../hooks/use-run-logs';

const TAIL_LINES = 8;

interface Props {
	companyId: string;
	run: LatestRunForIssue;
}

export function IssueRunLogStrip({ companyId, run }: Props) {
	const isActive = run.status === 'running' || run.status === 'queued';
	const { lines } = useRunLogs(run.project_id, run.id, run.log_text, isActive);
	const tailRef = useRef<HTMLPreElement>(null);

	const tail = lines.slice(-TAIL_LINES);

	useEffect(() => {
		const el = tailRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, []);

	const statusLabel =
		run.status === 'running'
			? 'running'
			: run.status === 'queued'
				? 'queued'
				: run.status === 'succeeded'
					? 'succeeded'
					: run.status === 'failed'
						? 'failed'
						: run.status === 'cancelled'
							? 'cancelled'
							: 'timed out';

	return (
		<div className="mb-4 rounded-radius-md border border-border-subtle bg-bg-subtle overflow-hidden">
			<div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
				<div className="flex items-center gap-2 text-xs">
					<span
						className={`inline-block w-2 h-2 rounded-full ${
							isActive
								? 'bg-accent-yellow animate-pulse'
								: run.status === 'succeeded'
									? 'bg-accent-green'
									: run.status === 'failed' || run.status === 'timed_out'
										? 'bg-accent-red'
										: 'bg-text-subtle'
						}`}
					/>
					<span className="text-text-muted">
						{run.agent_title ?? 'Agent'} — {statusLabel}
					</span>
				</div>
				<Link
					to="/companies/$companyId/agents/$agentId/executions/$runId"
					params={{ companyId, agentId: run.member_id, runId: run.id }}
					className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text"
				>
					View full run <ExternalLink className="w-3 h-3" />
				</Link>
			</div>
			<pre
				ref={tailRef}
				data-testid="issue-run-log-tail"
				className="text-[11px] font-mono bg-bg px-3 py-2 max-h-40 overflow-auto whitespace-pre-wrap text-text-muted"
			>
				{tail.length === 0
					? isActive
						? 'Waiting for log output...'
						: 'No output.'
					: tail.map((line) => (
							<div key={line.id} className={line.stream === 'stderr' ? 'text-accent-red-text' : ''}>
								{line.text}
							</div>
						))}
			</pre>
		</div>
	);
}
