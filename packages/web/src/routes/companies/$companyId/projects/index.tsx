import { createFileRoute, Link } from '@tanstack/react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectDialog } from '../../../../components/create-project-dialog';
import { Avatar, avatarColorFromString } from '../../../../components/ui/avatar';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { EmptyState } from '../../../../components/ui/empty-state';
import { useProjects } from '../../../../hooks/use-projects';

function getInitials(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function ProjectListPage() {
	const { companyId } = Route.useParams();
	const { data: projects, isLoading } = useProjects(companyId);
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<div className="max-w-[900px] mx-auto w-full px-8 py-6">
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">Projects</h1>
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" />
					New project
				</Button>
			</div>

			{isLoading ? (
				<div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>
			) : projects?.length === 0 ? (
				<EmptyState
					icon={<FolderKanban className="w-10 h-10" />}
					title="No projects yet"
					description="Create a project to organize issues and repos."
				/>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
					{projects?.map((p) => (
						<Link
							key={p.id}
							to="/companies/$companyId/projects/$projectId"
							params={{ companyId, projectId: p.slug }}
						>
							<Card className="cursor-pointer">
								<div className="flex items-start gap-3">
									<Avatar initials={getInitials(p.name)} color={avatarColorFromString(p.name)} />
									<div className="flex flex-col gap-1 min-w-0 flex-1">
										<div className="flex items-center justify-between gap-2">
											<h2 className="text-[15px] font-medium text-text truncate">{p.name}</h2>
											{p.container_status && <ContainerStatusBadge status={p.container_status} />}
										</div>
										{p.goal && <p className="text-xs text-text-muted line-clamp-2">{p.goal}</p>}
										<div className="flex gap-3 text-xs text-text-muted mt-1">
											<span>{p.open_issue_count} issues</span>
											<span>{p.repo_count} repos</span>
										</div>
									</div>
								</div>
							</Card>
						</Link>
					))}
				</div>
			)}

			<CreateProjectDialog companyId={companyId} open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

function ContainerStatusBadge({ status }: { status: string }) {
	const config: Record<string, { color: string; label: string }> = {
		creating: { color: 'warning', label: 'Provisioning' },
		running: { color: 'success', label: 'Running' },
		stopped: { color: 'neutral', label: 'Stopped' },
		error: { color: 'danger', label: 'Error' },
	};
	const { color, label } = config[status] ?? { color: 'neutral', label: status };
	return <Badge color={color as 'neutral'}>{label}</Badge>;
}

export const Route = createFileRoute('/companies/$companyId/projects/')({
	component: ProjectListPage,
});
