import { type ReactNode, useState } from 'react';
import { agentDisplayName, agentIdentityTooltip } from './agent-identity-tooltip';
import { AgentLink } from './agent-link';
import { Tooltip } from './ui/tooltip';

/**
 * The subset of an agent this component needs. Kept structural rather than taking
 * the full `Agent` so a surface holding only a baked projection (a run comment's
 * `agent_slug` + title, say) can still render through the one seam.
 */
export interface AgentRefIdentity {
	human_name?: string | null;
	title?: string | null;
	role_description?: string | null;
	slug?: string | null;
	is_instance?: boolean;
}

interface AgentRefProps {
	/** The resolved agent. Null/undefined falls back to `fallbackName`. */
	agent?: AgentRefIdentity | null;
	/** Required for `link`; the current project, which `AgentLink` re-points for HQ agents. */
	projectId?: string;
	/** Wrap the label in a link to the agent's page. */
	link?: boolean;
	/** Shown when the agent could not be resolved - e.g. a name baked into an old payload. */
	fallbackName?: string;
	className?: string;
	testId?: string;
	/** Rendered in place of the plain label - lets the avatar and name share one trigger. */
	children?: ReactNode;
	/**
	 * Whether a touch tap opens the card. Set false when the label sits inside a
	 * link or button the tap has to reach: suppressing the tap's click is what
	 * opens the card, and it would swallow the navigation or the selection.
	 */
	tapToOpen?: boolean;
}

const TOOLTIP_PANEL = 'max-w-[min(18rem,calc(100vw-2rem))] px-3 py-2.5 text-[12px] leading-snug';

/**
 * The single way an agent is named in the UI: its own name when it has one, else
 * its role, with a hover card carrying whichever of the two the label left out
 * plus the role description.
 *
 * `agentIdentityTooltip` returns null when the label already says everything - an
 * unnamed agent with no role description - so a role-only label is never given a
 * card that just repeats itself.
 */
export function AgentRef({
	agent,
	projectId,
	link = false,
	fallbackName,
	className,
	testId,
	children,
	tapToOpen = true,
}: AgentRefProps) {
	const [open, setOpen] = useState(false);

	const label = (agent ? agentDisplayName(agent) : '') || fallbackName || '';
	if (!label && !children) return null;

	const content = children ?? label;
	const tooltip = agent ? agentIdentityTooltip(agent) : null;
	const slug = agent?.slug ?? undefined;
	const linked = link && !!projectId && !!slug;

	if (!tooltip) {
		return linked && projectId && slug ? (
			<AgentLink projectId={projectId} agentId={slug} className={className} testId={testId}>
				{content}
			</AgentLink>
		) : (
			<span className={className} data-testid={testId}>
				{content}
			</span>
		);
	}

	// Radix opens a tooltip on hover and focus but never on a touch tap. A linked
	// label needs no tap handling - the tap navigates to the agent's page, which
	// says everything the card does and more - so only a standalone label toggles
	// itself open, matching `RelativeTime`.
	if (linked && projectId && slug) {
		return (
			<Tooltip content={tooltip} contentClassName={TOOLTIP_PANEL}>
				<AgentLink projectId={projectId} agentId={slug} className={className} testId={testId}>
					{content}
				</AgentLink>
			</Tooltip>
		);
	}

	if (!tapToOpen) {
		return (
			<Tooltip content={tooltip} contentClassName={TOOLTIP_PANEL}>
				<span className={className} data-testid={testId}>
					{content}
				</span>
			</Tooltip>
		);
	}

	// No `aria-label` here: the label text is already the accessible name, and a
	// bare span has no role that supports one. The tap handler is a pointer
	// affordance only - a screen reader reads the name and role from the text.
	return (
		<Tooltip content={tooltip} open={open} onOpenChange={setOpen} contentClassName={TOOLTIP_PANEL}>
			<span
				className={className}
				data-testid={testId}
				onTouchStart={(e) => {
					e.preventDefault();
					setOpen((o) => !o);
				}}
			>
				{content}
			</span>
		</Tooltip>
	);
}
