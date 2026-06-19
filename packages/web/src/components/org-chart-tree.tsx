import { isBudgetPauseStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { OrgNode } from '../hooks/use-org-chart';
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
			setHeight(contentHeight * next);
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

export function OrgChartTree({ roots, projectId, mode, hint, testId }: OrgChartTreeProps) {
	const { containerRef, contentRef, scale, height } = useOrgChartAutoFit();

	const renderNode = (node: OrgNode): ReactNode => {
		const status = mode === 'interactive' ? orgDotStatus(node) : null;
		const label = (
			<>
				{status && <StatusDot status={status} />}
				{node.title}
			</>
		);

		const nodeBody =
			mode === 'interactive' && projectId ? (
				<Link
					to="/projects/$projectId/agents/$agentId"
					params={{ projectId, agentId: node.slug }}
					className="relative inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium transition-[border-color] duration-150 hover:border-border-strong"
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
						className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3.5 py-2 text-[13px] font-medium transition-[border-color,background-color] duration-150 hover:border-border-strong hover:bg-surface-elevated cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inverse/40"
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
				{node.children.length > 0 && (
					<>
						<div className="w-px h-4 bg-border" />
						<div className={`flex ${mode === 'onboarding' ? 'gap-4 sm:gap-6' : 'gap-6'}`}>
							{node.children.map((child) => (
								<div key={child.id} className="flex flex-col items-center">
									<div className="w-px h-4 bg-border" />
									{renderNode(child)}
								</div>
							))}
						</div>
					</>
				)}
			</div>
		);
	};

	if (roots.length === 0) return null;

	return (
		<div data-testid={testId}>
			<div ref={containerRef} className="w-full overflow-hidden pt-1" style={{ height }}>
				<div
					ref={contentRef}
					className="flex flex-col items-center"
					style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
				>
					<div className="inline-flex items-center gap-2 rounded-md border-2 border-inverse bg-info-soft px-4 py-2 text-[13px] font-medium text-info-soft-fg mb-2">
						You (Admin)
					</div>
					<div className="w-px h-4 bg-border" />
					<div className={`flex ${mode === 'onboarding' ? 'gap-6 sm:gap-8' : 'gap-8'}`}>
						{roots.map((node) => (
							<div key={node.id} className="flex flex-col items-center">
								<div className="w-px h-4 bg-border" />
								{renderNode(node)}
							</div>
						))}
					</div>
				</div>
			</div>
			{hint && <p className="text-[11px] text-text-3 mt-3">{hint}</p>}
		</div>
	);
}
