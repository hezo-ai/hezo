import { createFileRoute, Navigate } from '@tanstack/react-router';

function AgentIndex() {
	const { companyId, agentId } = Route.useParams();
	return (
		<Navigate
			to="/companies/$companyId/agents/$agentId/executions"
			params={{ companyId, agentId }}
			replace
		/>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/$agentId/')({
	component: AgentIndex,
});
