import { createFileRoute } from '@tanstack/react-router';
import type { OrgNode } from '../../../hooks/use-org-chart';
import { useOrgChart } from '../../../hooks/use-org-chart';

const statusDot: Record<string, string> = {
	active: 'bg-success',
	idle: 'bg-info',
	paused: 'bg-warning',
	terminated: 'bg-bg-elevated',
};

function OrgNodeComponent({ node, depth = 0 }: { node: OrgNode; depth?: number }) {
	return (
		<div className="flex flex-col items-center">
			<div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm">
				<span
					className={`w-2 h-2 rounded-full shrink-0 ${statusDot[node.status] || 'bg-bg-elevated'}`}
				/>
				<span className="font-medium text-text">{node.title}</span>
			</div>
			{node.children.length > 0 && (
				<>
					<div className="w-px h-4 bg-border" />
					<div className="flex gap-6">
						{node.children.map((child) => (
							<div key={child.id} className="flex flex-col items-center">
								<div className="w-px h-4 bg-border" />
								<OrgNodeComponent node={child} depth={depth + 1} />
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

	if (isLoading) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div className="p-6">
			<h1 className="text-lg font-semibold mb-6">Org Chart</h1>
			<div className="flex flex-col items-center overflow-auto">
				<div className="flex items-center gap-2 rounded-lg border-2 border-primary bg-primary/10 px-4 py-2 text-sm font-semibold text-primary mb-2">
					Board
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
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/org-chart')({
	component: OrgChartPage,
});
