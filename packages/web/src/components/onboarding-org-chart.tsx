import { useEffect, useRef, useState } from 'react';
import type { OrgNode } from '../hooks/use-org-chart';
import { useOrgChart } from '../hooks/use-org-chart';
import { Tooltip } from './ui/tooltip';

function useAutoFit() {
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

function AgentRoleTooltipContent({ node }: { node: OrgNode }) {
	const description = node.role_description?.trim();
	return (
		<div className="space-y-1.5">
			<p className="text-[12px] font-semibold text-text leading-tight">{node.title}</p>
			<p className="text-[11px] leading-relaxed text-text-muted">
				{description || 'No role description yet.'}
			</p>
		</div>
	);
}

function OnboardingOrgNode({ node }: { node: OrgNode }) {
	return (
		<div className="flex flex-col items-center">
			<Tooltip
				content={<AgentRoleTooltipContent node={node} />}
				side="top"
				delayDuration={200}
				contentClassName="max-w-[min(18rem,calc(100vw-2rem))] px-3 py-2.5 text-[12px] leading-snug"
			>
				<button
					type="button"
					className="inline-flex items-center gap-2 rounded-radius-md border border-border bg-bg px-3.5 py-2 text-[13px] font-medium transition-[border-color,background-color] duration-150 hover:border-border-hover hover:bg-surface-elevated cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
					data-testid={`onboarding-org-node-${node.slug}`}
					aria-label={`${node.title} — hover for role description`}
				>
					{node.title}
				</button>
			</Tooltip>
			{node.children.length > 0 && (
				<>
					<div className="w-px h-4 bg-border" />
					<div className="flex gap-4 sm:gap-6">
						{node.children.map((child) => (
							<div key={child.id} className="flex flex-col items-center">
								<div className="w-px h-4 bg-border" />
								<OnboardingOrgNode node={child} />
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}

export function OnboardingOrgChart({ teamId }: { teamId: string }) {
	const { data: orgChart, isLoading } = useOrgChart(teamId);
	const { containerRef, contentRef, scale, height } = useAutoFit();

	if (isLoading) {
		return (
			<p
				className="text-sm text-text-muted py-4 text-center"
				data-testid="onboarding-org-chart-loading"
			>
				Loading team structure…
			</p>
		);
	}

	const roots = orgChart?.board.children ?? [];
	if (roots.length === 0) {
		return (
			<p className="text-sm text-text-muted" data-testid="onboarding-org-chart-empty">
				Your team will appear here once agents are hired.
			</p>
		);
	}

	return (
		<div data-testid="onboarding-org-chart">
			<p className="text-xs font-medium uppercase tracking-wide text-text-muted mb-3">
				Reporting structure
			</p>
			<div ref={containerRef} className="w-full overflow-hidden pt-1" style={{ height }}>
				<div
					ref={contentRef}
					className="flex flex-col items-center"
					style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
				>
					<div className="inline-flex items-center gap-2 rounded-radius-md border-2 border-primary bg-accent-blue-bg px-4 py-2 text-[13px] font-medium text-accent-blue-text mb-2">
						You (Board)
					</div>
					<div className="w-px h-4 bg-border" />
					<div className="flex gap-6 sm:gap-8">
						{roots.map((node) => (
							<div key={node.id} className="flex flex-col items-center">
								<div className="w-px h-4 bg-border" />
								<OnboardingOrgNode node={node} />
							</div>
						))}
					</div>
				</div>
			</div>
			<p className="text-[11px] text-text-subtle mt-3">
				Hover a role to read what they do on the team.
			</p>
		</div>
	);
}
