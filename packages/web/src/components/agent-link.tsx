import { HQ_PROJECT_SLUG, INSTANCE_AGENT_SLUGS } from '@hezo/shared';
import type { ReactNode } from 'react';
import { AgentCard } from './agent-card';

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
	/** The agent's slug. */
	agentId: string;
	className?: string;
	testId?: string;
	children: ReactNode;
}

/**
 * An agent named only by its slug, as a system note bakes it. Opens the agent
 * card like every other linked agent name; the card fills in the agent's name,
 * role and status from the live roster. See `AgentCard`.
 */
export function AgentLink({ projectId, agentId, className, testId, children }: AgentLinkProps) {
	return (
		<AgentCard
			agent={{ slug: agentId }}
			projectId={projectId}
			className={className}
			testId={testId}
		>
			{children}
		</AgentCard>
	);
}
