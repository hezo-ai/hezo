import { AgentAdminStatus } from '@hezo/shared';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { agentDisplayName } from '../../../../../components/agent-identity-tooltip';
import { NextHeartbeatIndicator } from '../../../../../components/next-heartbeat-indicator';
import { Avatar, getInitials } from '../../../../../components/ui/avatar';
import { Badge } from '../../../../../components/ui/badge';
import { ExpandableText } from '../../../../../components/ui/expandable-text';
import { Tabs } from '../../../../../components/ui/tabs';
import { useAgent } from '../../../../../hooks/use-agents';
import { agentAvatarUrl } from '../../../../../lib/agent-avatar';
import { agentRuntimeStatusMeta } from '../../../../../lib/status-meta';

const executionsTab = {
	label: 'Executions',
	to: '/projects/$projectId/agents/$agentId/executions' as const,
};
const chatHistoryTab = {
	label: 'Chat history',
	to: '/projects/$projectId/agents/$agentId/chat-history' as const,
};
const settingsTab = {
	label: 'Settings',
	to: '/projects/$projectId/agents/$agentId/settings' as const,
};

function AgentLayout() {
	const { projectId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(projectId, agentId);
	const params = { projectId, agentId };

	if (isLoading || !agent) return <div className="text-text-2">Loading...</div>;

	// The Chat history tab (long-term compacted memory) shows only for chat-enabled
	// agents — those with a live chatbox. Today that is just the CEO.
	const tabs = agent.chat_enabled
		? [executionsTab, chatHistoryTab, settingsTab]
		: [executionsTab, settingsTab];

	return (
		<div className="max-w-3xl">
			<Link
				to="/projects/$projectId/agents"
				params={{ projectId }}
				className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text-1 mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Team
			</Link>

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-4">
				<Avatar
					initials={getInitials(agentDisplayName(agent))}
					imageUrl={agentAvatarUrl(agent)}
					size="md"
					running={agent.runtime_status === 'active'}
				/>
				<h1
					className={`text-lg font-semibold${agent.admin_status === AgentAdminStatus.Disabled ? ' text-text-2' : ''}`}
				>
					{agentDisplayName(agent)}
					{agent.admin_status === AgentAdminStatus.Disabled ? ' (disabled)' : ''}
				</h1>
				{/* Named agents keep their role visible, so the page still says what
				    this teammate is here to do. */}
				{agent.human_name?.trim() && <span className="text-sm text-text-2">{agent.title}</span>}
				<Badge color={agentRuntimeStatusMeta(agent.runtime_status).color}>
					{agentRuntimeStatusMeta(agent.runtime_status).label}
				</Badge>
				<NextHeartbeatIndicator
					nextHeartbeatAt={agent.next_heartbeat_at}
					hasActionableWork={agent.has_actionable_work}
					className="w-full sm:w-auto sm:ml-auto"
				/>
			</div>

			<div
				data-testid="agent-summary"
				className="rounded-lg border border-border-subtle bg-surface-2 p-4 text-sm leading-relaxed text-text-1 mb-6"
			>
				<ExpandableText
					text={agent.summary ?? ''}
					projectId={projectId}
					placeholder={<span className="italic text-text-2">Description being generated…</span>}
				/>
			</div>

			<Tabs items={tabs.map((tab) => ({ ...tab, params }))} className="mt-6 mb-6" />

			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId')({
	component: AgentLayout,
});
