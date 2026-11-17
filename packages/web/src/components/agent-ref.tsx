import { type ReactNode, useState } from 'react';
import { AgentCard } from './agent-card';
import { agentDisplayName, agentIdentityTooltip } from './agent-identity-tooltip';
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
	/** Shown on the linked card only. */
	avatar_spec?: unknown;
	/** Shown on the linked card only. */
	runtime_status?: string | null;
}

interface AgentRefProps {
	/** The resolved agent. Null/undefined falls back to `fallbackName`. */
	agent?: AgentRefIdentity | null;
	/** Required for `link`; the current project, which the card re-points to HQ for HQ agents. */
	projectId?: string;
	/**
	 * Make the label open the agent card (see `AgentCard`): the agent's page and
	 * a chat shortcut. The label stays a link to the page for a modified click.
	 */
	link?: boolean;
	/** Shown when the agent could not be resolved - e.g. a name baked into an old payload. */
	fallbackName?: string;
	className?: string;
	testId?: string;
	/** Rendered in place of the plain label - lets the avatar and name share one trigger. */
	children?: ReactNode;
	/**
	 * Hang the card off `children` itself rather than a wrapper of our own, so the
	 * hover target is the caller's element.
	 *
	 * Use it when the label sits inside a bigger interactive row - a menu option, a
	 * list item. Without it the trigger is only the name text, which is a target a
	 * few characters wide inside a full-width row: the pointer lands on the row's
	 * padding and nothing opens. `className`, `testId` and `tapToOpen` are the
	 * caller's business in this mode and are ignored.
	 */
	asChild?: boolean;
	/** Which side the card opens on. Defaults to `top`. */
	side?: 'top' | 'right' | 'bottom' | 'left';
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
 *
 * A `link` label instead opens `AgentCard`, which carries the same identity plus
 * the agent's page and a chat shortcut, so it is shown whatever the label says.
 */
export function AgentRef({
	agent,
	projectId,
	link = false,
	fallbackName,
	className,
	testId,
	children,
	asChild = false,
	side,
	tapToOpen = true,
}: AgentRefProps) {
	const [open, setOpen] = useState(false);

	const label = (agent ? agentDisplayName(agent) : '') || fallbackName || '';
	if (!label && !children) return null;

	const content = children ?? label;
	const slug = agent?.slug ?? undefined;

	// A linked label always gets the card, even when there is nothing to add to
	// the name: the card is where its page link and chat shortcut live. The card
	// carries the identity itself, so there is no separate tooltip.
	if (link && projectId && agent && slug) {
		return (
			<AgentCard
				agent={{ ...agent, slug }}
				projectId={projectId}
				className={className}
				testId={testId}
			>
				{content}
			</AgentCard>
		);
	}

	const tooltip = agent ? agentIdentityTooltip(agent) : null;

	// The caller's element is the trigger, so there is nothing of ours to render:
	// with no card to show, `children` passes straight through untouched.
	if (asChild) {
		if (!tooltip) return <>{content}</>;
		return (
			<Tooltip content={tooltip} side={side} contentClassName={TOOLTIP_PANEL}>
				{content}
			</Tooltip>
		);
	}

	if (!tooltip) {
		return (
			<span className={className} data-testid={testId}>
				{content}
			</span>
		);
	}

	// Radix opens a tooltip on hover and focus but never on a touch tap, so a
	// standalone label toggles itself open on tap, matching `RelativeTime`.
	if (!tapToOpen) {
		return (
			<Tooltip content={tooltip} side={side} contentClassName={TOOLTIP_PANEL}>
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
		<Tooltip
			content={tooltip}
			side={side}
			open={open}
			onOpenChange={setOpen}
			contentClassName={TOOLTIP_PANEL}
		>
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
