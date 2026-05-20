import { createFileRoute, Navigate } from '@tanstack/react-router';

function AgentIndex() {
	const { teamId, agentId } = Route.useParams();
	return (
		<Navigate to="/teams/$teamId/agents/$agentId/executions" params={{ teamId, agentId }} replace />
	);
}

export const Route = createFileRoute('/teams/$teamId/agents/$agentId/')({
	component: AgentIndex,
});
