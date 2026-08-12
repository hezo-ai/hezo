import { useMemo } from 'react';
import { type Agent, useAgents } from './use-agents';

export interface AgentLookup {
	/** By role slug, and by name slug when the agent has a name. */
	bySlug: Map<string, Agent>;
	byMemberId: Map<string, Agent>;
	/** By display name, lowercased - for payloads that carry only a label. */
	byName: Map<string, Agent>;
}

/**
 * The roster, indexed the three ways a surface has to reach into it: a projection
 * that carries a slug, one that carries a member id, and one that carries only a
 * name string. Every in-project route already has `useAgents(projectId)` warm, so
 * a surface showing an agent can resolve the full identity - and thus its tooltip -
 * without the server growing a field for it.
 *
 * Both handles land in `bySlug` because either can arrive from a mention or a
 * baked payload; the role slug wins a collision, since that is the one the agent
 * route resolves.
 */
export function useAgentLookup(projectId: string): AgentLookup {
	const { data: agents } = useAgents(projectId);
	return useMemo(() => {
		const bySlug = new Map<string, Agent>();
		const byMemberId = new Map<string, Agent>();
		const byName = new Map<string, Agent>();
		for (const agent of agents ?? []) {
			if (agent.human_name_slug) bySlug.set(agent.human_name_slug, agent);
			byMemberId.set(agent.id, agent);
			const name = agent.human_name?.trim() || agent.title;
			if (name) byName.set(name.toLowerCase(), agent);
			if (agent.title) byName.set(agent.title.toLowerCase(), agent);
		}
		// Second pass so a role slug always beats a name slug that collides with it.
		for (const agent of agents ?? []) bySlug.set(agent.slug, agent);
		return { bySlug, byMemberId, byName };
	}, [agents]);
}
