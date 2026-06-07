import { HQ_PROJECT_SLUG, INSTANCE_AGENT_SLUGS } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/**
 * Route params for an agent's page. HQ agents (CEO/Coach) are virtual members of
 * every project but their canonical page lives in the HQ project, so their links
 * resolve there; every other agent links within the current project. Pass the
 * server's instance flag when known, otherwise it's inferred from the slug.
 */
export function agentPageParams(
	currentProjectId: string,
	agentSlug: string,
	isInstance?: boolean,
): { projectId: string; agentId: string } {
	const instance = isInstance ?? (INSTANCE_AGENT_SLUGS as readonly string[]).includes(agentSlug);
	return { projectId: instance ? HQ_PROJECT_SLUG : currentProjectId, agentId: agentSlug };
}

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
 * Link to an agent's profile page. Centralizes the
 * `/projects/$projectId/agents/$agentId` target so assignee, comment authors,
 * and the agent queue all navigate consistently. HQ agents (CEO/Coach) are
 * virtual members of every project; their canonical page lives in the HQ
 * project, so passing their slug routes there. Everyone else links within the
 * current project.
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
			params={agentPageParams(projectId, agentId)}
			className={className}
			title={title}
			data-testid={testId}
		>
			{children}
		</Link>
	);
}
