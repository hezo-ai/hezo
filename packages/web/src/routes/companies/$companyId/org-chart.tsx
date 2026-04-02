import { createFileRoute } from '@tanstack/react-router';
import { StatusDot } from '../../../components/ui/status-dot';
import type { OrgNode } from '../../../hooks/use-org-chart';
import { useOrgChart } from '../../../hooks/use-org-chart';

function orgDotStatus(node: OrgNode): 'active' | 'idle' | 'paused' | 'disabled' {
	if (node.admin_status === 'disabled' || node.admin_status === 'terminated') return 'disabled';
	if (node.runtime_status === 'paused') return 'paused';
	return node.runtime_status === 'active' ? 'active' : 'idle';
}

function OrgNodeComponent({ node }: { node: OrgNode }) {
	return (
		<div className="flex flex-col items-center">
			<div className="relative inline-flex items-center gap-2 rounded-radius-md border border-border bg-bg px-3.5 py-2 text-[13px] font-medium transition-[border-color] duration-150 hover:border-border-hover">
				<StatusDot status={orgDotStatus(node)} />
				{node.title}
			</div>
			{node.children.length > 0 && (
				<>
					<div className="w-px h-4 bg-border" />
					<div className="flex gap-6">
						{node.children.map((child) => (
							<div key={child.id} className="flex flex-col items-center">
								<div className="w-px h-4 bg-border" />
								<OrgNodeComponent node={child} />
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}

function OrgChartPage() {
	const { companyId } = Route.useParams();
	const { data: orgChart, isLoading } = useOrgChart(companyId);

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	return (
		<div>
			<div className="flex flex-col items-center overflow-auto pt-4">
				<div className="inline-flex items-center gap-2 rounded-radius-md border-2 border-primary bg-accent-blue-bg px-4 py-2 text-[13px] font-medium text-accent-blue-text mb-2">
					You (Board)
				</div>
				{orgChart?.board.children && orgChart.board.children.length > 0 && (
					<>
						<div className="w-px h-4 bg-border" />
						<div className="flex gap-8">
							{orgChart.board.children.map((node) => (
								<div key={node.id} className="flex flex-col items-center">
									<div className="w-px h-4 bg-border" />
									<OrgNodeComponent node={node} />
								</div>
							))}
						</div>
					</>
				)}
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
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/org-chart')({
	component: OrgChartPage,
});
