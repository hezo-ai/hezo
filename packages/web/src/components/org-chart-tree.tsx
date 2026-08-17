import { isBudgetPauseStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { OrgNode } from '../hooks/use-org-chart';
import { agentAvatarUrl } from '../lib/agent-avatar';
import { useI18n } from '../lib/i18n';
import { computeOrgChartFit, type OrgChartFit } from '../lib/org-chart-fit';
import { AgentIdentityTooltipContent, agentDisplayName } from './agent-identity-tooltip';
import { agentPageParams } from './agent-link';
import { Avatar, getInitials } from './ui/avatar';
import { StatusDot } from './ui/status-dot';
import { Tooltip } from './ui/tooltip';

const INITIAL_FIT: OrgChartFit = { scale: 1, width: 0, height: 0, overflows: false };

/**
 * Measure the chart against its viewport and keep the two in step.
 *
 * The content is `w-max`, so `offsetWidth`/`offsetHeight` report its natural
 * size — and unlike `getBoundingClientRect()` those are layout values, read
 * straight through the transform this hook itself wrote last pass. Measuring a
 * transformed box would feed each scale into the next and converge on zero.
 *
 * This replaced a `scrollWidth` measurement, which is where the bug was: with a
 * content box the width of its container and `items-center`, a wide row
 * overflows symmetrically, and in LTR `scrollWidth` only ever reports the right
 * half. The chart was measured about half its overhang too narrow, so the scale
 * came out too high and it clipped on both sides.
 */
function useOrgChartAutoFit() {
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [fit, setFit] = useState<OrgChartFit>(INITIAL_FIT);

	// Layout effect, not effect: the fit lands in the frame the tree mounts, so
	// there is no flash of an unscaled chart overhanging its column.
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		const content = contentRef.current;
		if (!viewport || !content) return;

		const measure = () => {
			const next = computeOrgChartFit({
				viewportWidth: viewport.clientWidth,
				contentWidth: content.offsetWidth,
				contentHeight: content.offsetHeight,
			});
			// `overflows` has to be compared too: either side of the floor boundary
			// two different viewport widths can share a `width`, and a comparison
			// without it would leave the scrollbar off on a chart that needs one.
			setFit((prev) =>
				prev.scale === next.scale &&
				prev.width === next.width &&
				prev.height === next.height &&
				prev.overflows === next.overflows
					? prev
					: next,
			);
		};

		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(viewport);
		ro.observe(content);
		return () => ro.disconnect();
	}, []);

	// The chart is centred on its root, so a scrolling one left at scrollLeft 0
	// opens on the leftmost worker with "You (Admin)" off-screen. Centre it once,
	// then leave the scroll position to whoever is panning.
	//
	// Separate from the measure pass on purpose: `scrollWidth` only becomes the
	// new sizer's width after React has committed it, so centring inside
	// `measure` would divide up the *previous* extent.
	const centred = useRef(false);
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || !fit.overflows || centred.current) return;
		centred.current = true;
		viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
	}, [fit.overflows]);

	return { viewportRef, contentRef, fit };
}

type VisibleStatus = 'active' | 'paused' | 'disabled';

function orgDotStatus(node: OrgNode): VisibleStatus | null {
	if (node.admin_status === 'disabled') return 'disabled';
	// Budget-paused agents render as the (red) paused dot; the agent badge
	// carries the precise reason (over agent vs project budget).
	if (isBudgetPauseStatus(node.runtime_status)) return 'paused';
	if (node.runtime_status === 'active') return 'active';
	return null;
}

function AgentRoleTooltipContent({ node }: { node: OrgNode }) {
	return (
		<AgentIdentityTooltipContent
			agent={{
				human_name: node.human_name,
				title: node.title,
				role_description: node.role_description?.trim() || 'No role description yet.',
			}}
		/>
	);
}

interface OrgChartTreeProps {
	roots: OrgNode[];
	projectId?: string;
	mode: 'interactive' | 'onboarding';
	hint?: string;
	testId?: string;
}

/**
 * A row of sibling nodes joined to their parent by three line segments: one
 * vertical "trunk" dropping from the parent, a horizontal "bus" spanning the
 * outermost siblings, and a vertical "riser" down to each sibling. The bus is
 * assembled from each column's two half-width top borders — `::before` draws the
 * left half, `::after` the right half — so it is width-agnostic; the first column
 * drops its left half and the last drops its right half, ending the line exactly
 * under the outermost siblings. Columns sit flush (no flex gap) so adjacent
 * halves meet into one continuous line; spacing comes from the horizontal
 * padding instead. This is what keeps every level's connectors joined.
 */
const CONNECTOR_COLUMN =
	'relative flex flex-col items-center px-3 sm:px-4 ' +
	"before:content-[''] before:absolute before:left-0 before:right-1/2 before:top-0 before:h-px before:bg-border " +
	"after:content-[''] after:absolute after:left-1/2 after:right-0 after:top-0 after:h-px after:bg-border " +
	'first:before:hidden last:after:hidden';

export function OrgChartTree({ roots, projectId, mode, hint, testId }: OrgChartTreeProps) {
	const { viewportRef, contentRef, fit } = useOrgChartAutoFit();
	const { t } = useI18n();

	const renderNode = (node: OrgNode): ReactNode => {
		const status = mode === 'interactive' ? orgDotStatus(node) : null;
		const displayName = agentDisplayName(node);
		const role = node.title?.trim();
		// Only a *named* agent needs its role spelled out beneath: for everyone else
		// the label already is the role, and a second line would just repeat it.
		const roleLine = role && role !== displayName ? role : null;
		const label = (
			<>
				{mode === 'interactive' && (
					<Avatar size="sm" initials={getInitials(displayName)} imageUrl={agentAvatarUrl(node)} />
				)}
				{status && <StatusDot status={status} />}
				<span className="flex min-w-0 flex-col items-start leading-tight">
					<span className="truncate">{displayName}</span>
					{roleLine && (
						<span className="truncate text-[11px] font-normal text-text-3">
							{/* Sighted readers get the second line from its position and weight;
							    a screen reader needs it said, so the label is read aloud only. */}
							<span className="sr-only">{t('agents.identity.roleLabel')} </span>
							{roleLine}
						</span>
					)}
				</span>
			</>
		);

		// Both modes carry the identity card: on the team page it is the only way to
		// learn which role a named agent fills, which is the whole point of the node.
		const tooltipProps = {
			content: <AgentRoleTooltipContent node={node} />,
			side: 'top' as const,
			delayDuration: 200,
			contentClassName: 'max-w-[min(18rem,calc(100vw-2rem))] px-3 py-2.5 text-[12px] leading-snug',
		};

		const nodeBody =
			mode === 'interactive' && projectId ? (
				<Tooltip {...tooltipProps}>
					<Link
						to="/projects/$projectId/agents/$agentId"
						params={agentPageParams(projectId, node.slug)}
						className="relative inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium cursor-pointer transition-[border-color,background-color,box-shadow] duration-150 hover:border-border-strong hover:bg-surface-2 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverse/40"
						data-testid={`org-node-${node.slug}`}
					>
						{label}
					</Link>
				</Tooltip>
			) : (
				<Tooltip {...tooltipProps}>
					<button
						type="button"
						className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium transition-[border-color,background-color] duration-150 hover:border-border-strong hover:bg-surface-2 cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverse/40"
						data-testid={`onboarding-org-node-${node.slug}`}
						aria-label={t('agents.identity.tooltipHint', { name: displayName })}
					>
						{label}
					</button>
				</Tooltip>
			);

		return (
			<div className="flex flex-col items-center" key={node.id}>
				{nodeBody}
				{node.children.length > 0 && renderBranch(node.children)}
			</div>
		);
	};

	// Trunk down from a parent, then the connected row of its children. Shared by
	// the synthetic "You (Admin)" root and every interior node so connectors are
	// drawn identically at every depth.
	const renderBranch = (children: OrgNode[]): ReactNode => (
		<>
			<div className="w-px h-4 bg-border" />
			<div className="flex">
				{children.map((child) => (
					<div key={child.id} className={CONNECTOR_COLUMN}>
						<div className="w-px h-4 bg-border" />
						{renderNode(child)}
					</div>
				))}
			</div>
		</>
	);

	if (roots.length === 0) return null;

	return (
		<div data-testid={testId}>
			{/* The viewport's height is left to the content so a space-taking
			    horizontal scrollbar gets a gutter below the chart instead of eating
			    ~15px out of the box and shearing the bottom row's border - the same
			    border PR #620 was about. Its vertical overflow must be stated
			    explicitly: a non-`visible` value on one axis computes the other to
			    `auto`, which would let a vertical scrollbar appear alongside.

			    Scrollability is driven from our own measurement rather than left to
			    `auto`, so a chart measured a sub-pixel narrow shows an invisible
			    hairline clip instead of a flickering scrollbar. */}
			<div
				ref={viewportRef}
				data-testid={testId ? `${testId}-viewport` : undefined}
				className={`w-full py-1 overflow-y-hidden overscroll-x-contain ${
					fit.overflows ? 'overflow-x-auto' : 'overflow-x-hidden'
				}`}
			>
				{/* The scaled chart keeps its untransformed layout box, so this sizer
				    carries the painted size instead - it is what gives the viewport a
				    correct scroll extent, and clipping to it keeps the untransformed
				    tree's layout overflow from leaking into that extent.

				    `mx-auto` is the whole centring story: CSS 2.1 §10.3.3 zeroes
				    over-constrained auto margins, so the sizer centres while the chart
				    fits and goes flush left the moment it outgrows the viewport -
				    which is what puts the chart's left edge at scrollLeft 0 instead of
				    stranding it out of reach. `justify-center` on a scroll container
				    would strand it, the same way the old measurement did. */}
				<div
					data-testid={testId ? `${testId}-canvas` : undefined}
					className="mx-auto overflow-hidden"
					style={{ width: fit.width || undefined, height: fit.height || undefined }}
				>
					{/* `w-max` sizes the tree to its widest row rather than to the column,
					    so nothing overflows it and `offsetWidth` is the true width. Origin
					    top-left pins the painted result to the sizer; `top center` would
					    put half of it at negative x, unreachable all over again. */}
					<div
						ref={contentRef}
						className="w-max flex flex-col items-center"
						style={{ transform: `scale(${fit.scale})`, transformOrigin: 'top left' }}
					>
						<div className="inline-flex items-center gap-2 rounded-md border-2 border-inverse bg-info-soft px-4 py-2 text-[13px] font-medium text-info-soft-fg">
							You (Admin)
						</div>
						{renderBranch(roots)}
					</div>
				</div>
			</div>
			{hint && <p className="text-[11px] text-text-3 mt-3">{hint}</p>}
		</div>
	);
}
