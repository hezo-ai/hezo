import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { RelativeTime } from '../../components/ui/relative-time';
import { useMe } from '../../hooks/use-me';
import { type Project, useArchivedProjects, useUnarchiveProject } from '../../hooks/use-projects';

function ArchivedProjectRow({ project }: { project: Project }) {
	const unarchive = useUnarchiveProject(project.slug);
	return (
		<li
			className="flex items-center justify-between gap-3 py-3"
			data-testid={`archived-project-${project.slug}`}
		>
			<div className="min-w-0">
				<div className="text-[13px] font-medium text-text-1 truncate">{project.name}</div>
				<div className="text-xs text-text-3 truncate">
					{project.team_name}
					{project.archived_at && (
						<>
							{' · archived '}
							<RelativeTime iso={project.archived_at} />
						</>
					)}
				</div>
			</div>
			<Button
				variant="secondary"
				size="sm"
				disabled={unarchive.isPending}
				onClick={() => unarchive.mutate()}
				data-testid={`unarchive-${project.slug}`}
			>
				{unarchive.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Unarchive'}
			</Button>
		</li>
	);
}

function ArchivedProjectsPage() {
	const { data: me } = useMe();
	const { data: projects = [], isLoading } = useArchivedProjects();

	const content =
		me && !me.is_superuser ? (
			<p className="text-[13px] text-text-2">
				Archived projects are managed by the Admin. You don't have access to this page.
			</p>
		) : (
			<>
				<div className="mb-5">
					<h1 className="text-[22px] font-medium">Archived projects</h1>
					<p className="text-[13px] text-text-2 mt-1 max-w-[680px]">
						Projects that have been archived from their settings page. Archived projects are hidden
						from the project rail; unarchive one to restore it.
					</p>
				</div>

				{isLoading ? (
					<Loader2 className="w-4 h-4 animate-spin text-text-3" />
				) : projects.length === 0 ? (
					<p className="text-[13px] text-text-2" data-testid="archived-projects-empty">
						No archived projects.
					</p>
				) : (
					<ul className="divide-y divide-border border-t border-border">
						{projects.map((p) => (
							<ArchivedProjectRow key={p.id} project={p} />
						))}
					</ul>
				)}
			</>
		);

	return <div className="max-w-[900px]">{content}</div>;
}

export const Route = createFileRoute('/settings/archived-projects')({
	component: ArchivedProjectsPage,
});
