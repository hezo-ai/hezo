import { HQ_PROJECT_SLUG, INSTANCE_AGENT_SLUGS } from '@hezo/shared';

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
