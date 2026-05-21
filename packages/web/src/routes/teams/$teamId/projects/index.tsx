import { OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { FolderKanban, Plus } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectDialog } from '../../../../components/create-project-dialog';
import { Avatar, avatarColorFromString } from '../../../../components/ui/avatar';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { EmptyState } from '../../../../components/ui/empty-state';
import { useProjects } from '../../../../hooks/use-projects';

type ProjectListSearch = { create?: boolean };

function getInitials(name: string): string {
	const words = name.split(/\s+/).filter(Boolean);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return name.slice(0, 2).toUpperCase();
}

function ProjectListPage() {
	const { teamId } = Route.useParams();
	const { create } = Route.useSearch();
	const navigate = useNavigate();
	const { data: projects, isLoading } = useProjects(teamId);
	const [createOpen, setCreateOpen] = useState(create ?? false);

	const sortedProjects = [...(projects ?? [])].sort((a, b) => {
		if (a.slug === OPERATIONS_PROJECT_SLUG) return 1;
		if (b.slug === OPERATIONS_PROJECT_SLUG) return -1;
		return a.name.localeCompare(b.name);
	});

	function handleCreateOpenChange(open: boolean) {
		setCreateOpen(open);
		if (!open && create) {
			navigate({
				to: '/teams/$teamId/projects',
				params: { teamId },
				search: {},
				replace: true,
			});
		}
	}

	return (
		<div className="max-w-[900px] mx-auto w-full">
			<div className="flex items-center justify-between mb-5">
				<h1 className="text-[22px] font-medium">Projects</h1>
				<Button onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4" />
					New project
				</Button>
			</div>

			{isLoading ? (
				<div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>
			) : sortedProjects.length === 0 ? (
				<EmptyState
					icon={<FolderKanban className="w-10 h-10" />}
					title="No projects yet"
					description="Create a project to organize issues and repos."
				/>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
					{sortedProjects.map((p) => (
						<Link
							key={p.id}
							to="/teams/$teamId/projects/$projectId"
							params={{ teamId, projectId: p.slug }}
						>
							<Card className="cursor-pointer">
								<div className="flex items-start gap-3">
									<Avatar
										initials={p.slug === OPERATIONS_PROJECT_SLUG ? 'IN' : getInitials(p.name)}
										color={avatarColorFromString(p.name)}
									/>
									<div className="flex flex-col gap-1 min-w-0 flex-1">
										<div className="flex items-center justify-between gap-2">
											<h2
												className={`text-[15px] font-medium text-text truncate ${
													p.slug === OPERATIONS_PROJECT_SLUG ? 'italic' : ''
												}`}
											>
												{p.name}
											</h2>
											{p.container_status && p.container_status !== 'running' && (
												<span
													role="img"
													title={`Container ${p.container_status}`}
													aria-label={`Container ${p.container_status}`}
													className="w-2 h-2 rounded-full bg-accent-red shrink-0"
												/>
											)}
										</div>
										{p.description && (
											<p className="text-xs text-text-muted line-clamp-2">{p.description}</p>
										)}
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

			<CreateProjectDialog
				teamId={teamId}
				open={createOpen}
				onOpenChange={handleCreateOpenChange}
			/>
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/projects/')({
	validateSearch: (search: Record<string, unknown>): ProjectListSearch => {
		if (search.create === true || search.create === 'true') return { create: true };
		return {};
	},
	component: ProjectListPage,
});
