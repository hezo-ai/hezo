import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { StatusDot } from '../../../../components/ui/status-dot';
import { useCompany } from '../../../../hooks/use-companies';
import type { OrgNode } from '../../../../hooks/use-org-chart';
import { useOrgChart } from '../../../../hooks/use-org-chart';

type VisibleStatus = 'active' | 'paused' | 'disabled';

function orgDotStatus(node: OrgNode): VisibleStatus | null {
	if (node.admin_status === 'disabled') return 'disabled';
	if (node.runtime_status === 'paused') return 'paused';
	if (node.runtime_status === 'active') return 'active';
	return null;
}

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

function OrgNodeComponent({ node, companyId }: { node: OrgNode; companyId: string }) {
	const status = orgDotStatus(node);
	return (
		<div className="flex flex-col items-center">
			<Link
				to="/companies/$companyId/agents/$agentId"
				params={{ companyId, agentId: node.slug }}
				className="relative inline-flex items-center gap-2 rounded-radius-md border border-border bg-bg px-3.5 py-2 text-[13px] font-medium transition-[border-color] duration-150 hover:border-border-hover"
			>
				{status && <StatusDot status={status} />}
				{node.title}
			</Link>
			{node.children.length > 0 && (
				<>
					<div className="w-px h-4 bg-border" />
					<div className="flex gap-6">
						{node.children.map((child) => (
							<div key={child.id} className="flex flex-col items-center">
								<div className="w-px h-4 bg-border" />
								<OrgNodeComponent node={child} companyId={companyId} />
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function TeamPage() {
	const { companyId } = Route.useParams();
	const { data: orgChart, isLoading } = useOrgChart(companyId);
	const { data: company } = useCompany(companyId);
	const { containerRef, contentRef, scale, height } = useAutoFit();

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	const hasMembers = orgChart?.board.children && orgChart.board.children.length > 0;

	return (
		<div>
			<div className="flex items-center justify-end mb-4">
				<Link to="/companies/$companyId/agents/hire" params={{ companyId }}>
					<Button>
						<UserPlus className="w-4 h-4" /> Hire agent
					</Button>
				</Link>
			</div>

			<div
				data-testid="team-summary"
				className="rounded-lg border border-border-subtle bg-bg-subtle p-4 text-sm leading-relaxed text-text whitespace-pre-line mb-6"
			>
				{company?.team_summary?.trim() ? (
					company.team_summary
				) : (
					<span className="italic text-text-muted">Team description being generated…</span>
				)}
			</div>

			{!hasMembers ? (
				<EmptyState icon={<Plus className="w-10 h-10" />} title="No team members yet" />
			) : (
				<>
					<div ref={containerRef} className="w-full pt-4" style={{ height }}>
						<div
							ref={contentRef}
							className="flex flex-col items-center"
							style={{ transform: `scale(${scale})`, transformOrigin: 'top center' }}
						>
							<div className="inline-flex items-center gap-2 rounded-radius-md border-2 border-primary bg-accent-blue-bg px-4 py-2 text-[13px] font-medium text-accent-blue-text mb-2">
								You (Board)
							</div>
							<div className="w-px h-4 bg-border" />
							<div className="flex gap-8">
								{orgChart.board.children.map((node) => (
									<div key={node.id} className="flex flex-col items-center">
										<div className="w-px h-4 bg-border" />
										<OrgNodeComponent node={node} companyId={companyId} />
									</div>
								))}
							</div>
						</div>
					</div>

					<div className="flex items-center gap-4 mt-8 pt-4 border-t border-border text-xs text-text-muted">
						<div className="flex items-center gap-1.5">
							<StatusDot status="active" /> Active
						</div>
						<div className="flex items-center gap-1.5">
							<StatusDot status="paused" /> Paused
						</div>
						<div className="flex items-center gap-1.5">
							<StatusDot status="disabled" /> Disabled
						</div>
					</div>
				</>
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/')({
	component: TeamPage,
});
