import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

interface AgentLinkProps {
	projectId: string;
	/** Agent slug (preferred) or member id — the agent route resolves either. */
	agentId: string;
	className?: string;
	title?: string;
	testId?: string;
	children: ReactNode;
}

/**
 * Link to an agent's profile page within a project. Centralizes the
 * `/projects/$projectId/agents/$agentId` target so assignee, comment authors,
 * and the agent queue all navigate consistently. Callers gate on team
 * membership before rendering this (cross-team instance agents like the CEO /
 * Coach have no page in another team's project), so it stays a plain Link.
 */
export function AgentLink({
	projectId,
	agentId,
	className,
	title,
	testId,
	children,
}: AgentLinkProps) {
	return (
		<Link
			to="/projects/$projectId/agents/$agentId"
			params={{ projectId, agentId }}
			className={className}
			title={title}
			data-testid={testId}
		>
			{children}
		</Link>
	);
}
