import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { useMe } from '../hooks/use-me';
import { useAllVisibleProjects } from '../hooks/use-projects';
import { CreateProjectWithTeamDialog } from './create-project-with-team-dialog';
import { Avatar, avatarColorFromString, getInitials } from './ui/avatar';
import { Tooltip } from './ui/tooltip';

/**
 * The thin left rail of project avatars. Projects are the primary navigation
 * axis: every visible project across every team appears here. Selecting one
 * opens its menu in the panel to the right. There is no team-level grouping —
 * each project is presented as a standalone entity. The create-project action
 * is pinned to the bottom so it stays in place as the avatar list scrolls.
 */
export function ProjectRail() {
	const { data: me } = useMe();
	const { projects } = useAllVisibleProjects();
	const active = useActiveProject();
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<>
			<nav
				className="w-[60px] shrink-0 h-full border-r border-border bg-bg-subtle flex flex-col items-center py-3"
				data-testid="project-rail"
				aria-label="Projects"
			>
				<div className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center gap-2 py-1">
					{projects.map((p) => {
						const isActive = active?.slug === p.slug && active?.teamSlug === p.teamSlug;
						return (
							<Tooltip key={p.id} content={p.name} side="right">
								<Link
									to="/projects/$projectId"
									params={{ projectId: p.slug }}
									aria-label={p.name}
									data-testid={`project-rail-avatar-${p.slug}`}
									className={`rounded-full transition-shadow ${
										isActive ? 'ring-2 ring-primary ring-offset-1 ring-offset-bg-subtle' : ''
									}`}
								>
									<Avatar initials={getInitials(p.name)} color={avatarColorFromString(p.name)} />
								</Link>
							</Tooltip>
						);
					})}
				</div>
				{me?.is_superuser && (
					<div className="shrink-0 pt-2 mt-2 w-full flex justify-center border-t border-border">
						<Tooltip content="New project" side="right">
							<button
								type="button"
								onClick={() => setCreateOpen(true)}
								aria-label="New project"
								data-testid="project-rail-new"
								className="w-9 h-9 rounded-radius-md flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-elevated border border-dashed border-border transition-colors"
							>
								<Plus className="w-4 h-4" />
							</button>
						</Tooltip>
					</div>
				)}
			</nav>
			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
