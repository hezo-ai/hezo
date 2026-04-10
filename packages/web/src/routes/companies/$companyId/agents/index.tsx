import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, UserPlus } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { StatusDot } from '../../../../components/ui/status-dot';
import type { OrgNode } from '../../../../hooks/use-org-chart';
import { useOrgChart } from '../../../../hooks/use-org-chart';

function orgDotStatus(node: OrgNode): 'active' | 'idle' | 'paused' | 'disabled' {
	if (node.admin_status === 'disabled') return 'disabled';
	if (node.runtime_status === 'paused') return 'paused';
	return node.runtime_status === 'active' ? 'active' : 'idle';
}

function OrgNodeComponent({ node, companyId }: { node: OrgNode; companyId: string }) {
	return (
		<div className="flex flex-col items-center">
			<Link
				to="/companies/$companyId/agents/$agentId"
				params={{ companyId, agentId: node.id }}
				className="relative inline-flex items-center gap-2 rounded-radius-md border border-border bg-bg px-3.5 py-2 text-[13px] font-medium transition-[border-color] duration-150 hover:border-border-hover"
			>
				<StatusDot status={orgDotStatus(node)} />
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

			{!hasMembers ? (
				<EmptyState icon={<Plus className="w-10 h-10" />} title="No team members yet" />
			) : (
				<>
					<div className="flex flex-col items-center overflow-auto pt-4">
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

					<div className="flex items-center gap-4 mt-8 pt-4 border-t border-border text-xs text-text-muted">
						<div className="flex items-center gap-1.5">
							<StatusDot status="active" /> Active
						</div>
						<div className="flex items-center gap-1.5">
							<StatusDot status="idle" /> Idle
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
