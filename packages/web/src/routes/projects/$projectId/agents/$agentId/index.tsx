import { createFileRoute, Navigate } from '@tanstack/react-router';

function AgentIndex() {
	const { projectId, agentId } = Route.useParams();
	return (
		<Navigate
			to="/projects/$projectId/agents/$agentId/executions"
			params={{ projectId, agentId }}
			replace
		/>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/')({
	component: AgentIndex,
});
