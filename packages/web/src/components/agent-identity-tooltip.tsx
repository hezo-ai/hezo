/**
 * The one way an agent's identity is spelled out on hover: its name in bold over
 * the role it fills. Used wherever a name is shown on its own - the roster, the
 * sidebar, an assignee chip, a rendered mention - so "Max" is never a mystery.
 *
 * An agent with no name of its own is shown by role, and then there is nothing
 * extra to say, so `agentIdentityTooltip` returns null and the caller skips the
 * tooltip entirely rather than repeating the label back.
 */

interface AgentIdentity {
	human_name?: string | null;
	title?: string | null;
	/** Optional extra line, e.g. the org chart's role description. */
	role_description?: string | null;
}

/** What an agent is called: its own name when it has one, else its role. */
export function agentDisplayName(agent: AgentIdentity): string {
	return agent.human_name?.trim() || (agent.title ?? '');
}

export function AgentIdentityTooltipContent({ agent }: { agent: AgentIdentity }) {
	const name = agentDisplayName(agent);
	const role = agent.title?.trim();
	const description = agent.role_description?.trim();
	return (
		<div className="space-y-1">
			<p className="text-[12px] font-semibold leading-tight text-text-1">{name}</p>
			{role && role !== name && <p className="text-[11px] leading-snug text-text-2">{role}</p>}
			{description && <p className="text-[11px] leading-relaxed text-text-2">{description}</p>}
		</div>
	);
}

/**
 * Tooltip content for an agent, or null when the label already says everything -
 * a role-only agent with no description has nothing to add on hover.
 */
export function agentIdentityTooltip(agent: AgentIdentity): React.ReactNode | null {
	const hasName = !!agent.human_name?.trim();
	const hasDescription = !!agent.role_description?.trim();
	if (!hasName && !hasDescription) return null;
	return <AgentIdentityTooltipContent agent={agent} />;
}
