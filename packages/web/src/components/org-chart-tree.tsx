import { isBudgetPauseStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { OrgNode } from '../hooks/use-org-chart';
import { defaultAvatarForSlug } from '../lib/default-avatars';
import { agentPageParams } from './agent-link';
import { Avatar, getInitials } from './ui/avatar';
import { StatusDot } from './ui/status-dot';
import { Tooltip } from './ui/tooltip';

export function useOrgChartAutoFit() {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [scale, setScale] = useState(1);
	const [height, setHeight] = useState<number | undefined>(undefined);

	useEffect(() => {
		const container = containerRef.current;
		const content = contentRef.current;
		if (!container || !content) return;

		const recompute = () => {
			const containerWidth = container.clientWidth;
			const contentWidth = content.scrollWidth;
			const contentHeight = content.scrollHeight;
			if (!containerWidth || !contentWidth) return;
			const next = Math.min(1, containerWidth / contentWidth);
			setScale(next);
			// The container is border-box with vertical padding and clips via
			// overflow-hidden, so the height must cover the scaled content *plus*
			// that padding — otherwise the padding eats into the box and the last
			// row's bottom border falls outside the clip. Round the scaled height
			// up and add 1px to absorb the sub-pixel rounding of the scaled border.
			const style = getComputedStyle(container);
			const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
			setHeight(Math.ceil(contentHeight * next) + paddingY + 1);
		};

		recompute();
		const ro = new ResizeObserver(recompute);
		ro.observe(container);
		ro.observe(content);
		return () => ro.disconnect();
	}, []);

	return { containerRef, contentRef, scale, height };
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
	const description = node.role_description?.trim();
	return (
		<div className="space-y-1.5">
			<p className="text-[12px] font-semibold text-text-1 leading-tight">{node.title}</p>
			<p className="text-[11px] leading-relaxed text-text-2">
				{description || 'No role description yet.'}
			</p>
		</div>
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
	const { containerRef, contentRef, scale, height } = useOrgChartAutoFit();

	const renderNode = (node: OrgNode): ReactNode => {
		const status = mode === 'interactive' ? orgDotStatus(node) : null;
		const label = (
			<>
				{mode === 'interactive' && (
					<Avatar
						size="sm"
						initials={getInitials(node.title)}
						imageUrl={node.icon_url ?? defaultAvatarForSlug(node.slug)}
					/>
				)}
				{status && <StatusDot status={status} />}
				{node.title}
			</>
		);

		const nodeBody =
			mode === 'interactive' && projectId ? (
				<Link
					to="/projects/$projectId/agents/$agentId"
					params={agentPageParams(projectId, node.slug)}
					className="relative inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium cursor-pointer transition-[border-color,background-color,box-shadow] duration-150 hover:border-border-strong hover:bg-surface-2 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverse/40"
				>
					{label}
				</Link>
			) : (
				<Tooltip
					content={<AgentRoleTooltipContent node={node} />}
					side="top"
					delayDuration={200}
					contentClassName="max-w-[min(18rem,calc(100vw-2rem))] px-3 py-2.5 text-[12px] leading-snug"
				>
					<button
						type="button"
						className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium transition-[border-color,background-color] duration-150 hover:border-border-strong hover:bg-surface-2 cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverse/40"
						data-testid={`onboarding-org-node-${node.slug}`}
						aria-label={`${node.title} — tap or hover for role description`}
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
			<div
				ref={containerRef}
				data-testid={testId ? `${testId}-viewport` : undefined}
				className="w-full overflow-hidden py-1"
				style={{ height }}
			>
				<div
					ref={contentRef}
					className="flex flex-col items-center"
					style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
				>
					<div className="inline-flex items-center gap-2 rounded-md border-2 border-inverse bg-info-soft px-4 py-2 text-[13px] font-medium text-info-soft-fg">
						You (Admin)
					</div>
					{renderBranch(roots)}
				</div>
			</div>
			{hint && <p className="text-[11px] text-text-3 mt-3">{hint}</p>}
		</div>
	);
}
