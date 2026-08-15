import { AgentAdminStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { useAgents } from '../../hooks/use-agents';
import { useProjectMeta } from '../../hooks/use-projects';
import { agentAvatarUrl } from '../../lib/agent-avatar';
import { useI18n } from '../../lib/i18n';
import { agentDisplayName } from '../agent-identity-tooltip';
import { AgentRef } from '../agent-ref';
import { Avatar, getInitials } from '../ui/avatar';
import { RelativeTime } from '../ui/relative-time';

/**
 * Who is working right now, as one strip between the progress summary and the two columns.
 *
 * A strip rather than a card, and one that keeps its height when nothing is running: agents work
 * in bursts, so an empty state is what an operator sees most of the day. A card that collapsed
 * when idle would move everything below it every time a run started or finished.
 */
export function ActiveAgentsStrip({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const project = useProjectMeta(projectId);
	const { data: agents } = useAgents(projectId, AgentAdminStatus.Enabled);

	const running = (agents ?? []).filter((a) => a.active_run?.run_status === 'running');
	const live = running.length > 0;

	return (
		<section
			data-testid="dashboard-active-agents"
			className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-l-[3px] border-border bg-surface px-3 py-2 ${
				live ? 'border-l-live' : 'border-l-border-strong'
			}`}
		>
			<span
				className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'bg-live' : 'bg-text-3'}`}
				aria-hidden="true"
			/>
			{live ? (
				<>
					<span className="shrink-0 text-[12px] font-medium text-text-1">
						{t('dashboard.agents.workingNow')}
					</span>
					{running.map((agent) => {
						const run = agent.active_run;
						const sameProject = run?.task_project_id === project?.id;
						return (
							<span
								key={agent.id}
								data-testid="dashboard-active-agent"
								className="flex min-w-0 items-center gap-1.5"
							>
								<AgentRef
									agent={agent}
									projectId={projectId}
									link
									className="flex min-w-0 items-center gap-1.5 hover:opacity-80"
								>
									<Avatar
										size="sm"
										initials={getInitials(agentDisplayName(agent))}
										imageUrl={agentAvatarUrl({ slug: agent.slug, avatar_spec: agent.avatar_spec })}
									/>
									<span className="truncate text-[12px] text-text-2">
										{agentDisplayName(agent)}
									</span>
								</AgentRef>
								{run?.task_identifier &&
									(sameProject ? (
										<Link
											to="/projects/$projectId/tasks/$taskId"
											params={{ projectId, taskId: run.task_identifier.toLowerCase() }}
											className="shrink-0 font-mono text-[11px] text-text-1 hover:underline"
										>
											{run.task_identifier}
										</Link>
									) : (
										<span className="shrink-0 font-mono text-[11px] text-text-3">
											{run.task_identifier}
										</span>
									))}
								{run?.started_at && (
									<RelativeTime
										iso={run.started_at}
										compact
										className="shrink-0 font-mono text-[10.5px] text-text-3"
									/>
								)}
							</span>
						);
					})}
				</>
			) : (
				<span className="text-[12px] text-text-2" data-testid="dashboard-active-agents-idle">
					{t('dashboard.agents.noneRunning')}
					{project?.last_activity_at && (
						<>
							{' · '}
							<span className="text-text-3">
								{t('dashboard.agents.lastActive')}{' '}
								<RelativeTime iso={project.last_activity_at} compact />
							</span>
						</>
					)}
				</span>
			)}
			<Link
				to="/projects/$projectId/agents"
				params={{ projectId }}
				className="ml-auto shrink-0 text-[11px] text-info-soft-fg hover:underline"
			>
				{t('dashboard.agents.viewTeam')}
			</Link>
		</section>
	);
}
