import { ContainerStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { useProjects } from '../hooks/use-projects';

export function ContainerStatusBanner({ companyId }: { companyId: string }) {
	const { data: projects } = useProjects(companyId);

	const unhealthy = projects?.filter(
		(p) =>
			p.container_status === ContainerStatus.Stopped ||
			p.container_status === ContainerStatus.Error,
	);

	if (!unhealthy?.length) return null;

	return (
		<div className="sticky top-0 z-40 flex flex-col">
			{unhealthy.map((p) => {
				const isError = p.container_status === ContainerStatus.Error;
				return (
					<Link
						key={p.id}
						to="/companies/$companyId/projects/$projectId/container"
						params={{ companyId, projectId: p.slug }}
						className={`flex items-center gap-2 px-4 py-2 text-[13px] font-medium transition-colors ${
							isError
								? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
								: 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
						}`}
					>
						<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
						<span>
							{p.name} container {isError ? 'has an error' : 'is stopped'}
						</span>
					</Link>
				);
			})}
		</div>
	);
}
