import { Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { useInboxUnreadCount, useInboxUnreadCountsBySlug } from '../hooks/use-inbox-count';
import { useMe } from '../hooks/use-me';
import { useAllVisibleProjects, useHqProject } from '../hooks/use-projects';
import { CreateProjectWithTeamDialog } from './create-project-with-team-dialog';
import { Avatar, avatarColorFromString, getInitials } from './ui/avatar';
import { CountOverlayBadge } from './ui/count-overlay-badge';
import { Tooltip } from './ui/tooltip';

/**
 * The thin left rail of project avatars. Projects are the primary navigation
 * axis: every visible project across every team appears here. Selecting one
 * opens its menu in the panel to the right. There is no team-level grouping —
 * each project is presented as a standalone entity. The create-project action
 * and the HQ entry are pinned below the scrolling avatar list (create-project
 * above HQ) so they stay in place as the avatar list scrolls.
 */
export function ProjectRail() {
	const { data: me } = useMe();
	const { projects } = useAllVisibleProjects();
	const hq = useHqProject();
	const active = useActiveProject();
	const inboxCounts = useInboxUnreadCountsBySlug();
	// HQ is excluded from the visible-project map (it's internal), so fetch its
	// outstanding count separately to badge the pinned HQ entry.
	const { data: hqInbox } = useInboxUnreadCount(hq?.slug ?? '', !!hq);
	const [createOpen, setCreateOpen] = useState(false);
	const hqActive = !!hq && active?.slug === hq.slug;

	return (
		<>
			<nav
				className="w-[60px] shrink-0 h-full border-r border-border bg-surface-2 flex flex-col items-center py-3"
				data-testid="project-rail"
				aria-label="Projects"
			>
				{/*
				  `overflow-y-auto` clips to the padding box, so the count badge
				  (`-top-1.5`, 6px above each avatar) on the topmost avatar would be
				  cut off without enough top padding. `pt-2.5` (10px) clears the
				  overhang plus the active ring.
				*/}
				<div
					className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center gap-2 pt-2.5 pb-1"
					data-testid="project-rail-scroll"
				>
					{projects.map((p) => {
						const isActive = active?.slug === p.slug && active?.teamSlug === p.teamSlug;
						return (
							<Tooltip key={p.id} content={p.name} side="right">
								<Link
									to="/projects/$projectId"
									params={{ projectId: p.slug }}
									aria-label={p.name}
									data-testid={`project-rail-avatar-${p.slug}`}
									className={`relative rounded-full transition-shadow ${
										isActive ? 'ring-2 ring-inverse ring-offset-1 ring-offset-surface-2' : ''
									}`}
								>
									<Avatar
										initials={getInitials(p.name)}
										color={avatarColorFromString(p.name)}
										imageUrl={p.icon_url}
									/>
									<CountOverlayBadge
										count={inboxCounts[p.slug] ?? 0}
										testId={`project-rail-inbox-badge-${p.slug}`}
									/>
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
								className="w-9 h-9 rounded-md flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface border border-dashed border-border transition-colors"
							>
								<Plus className="w-4 h-4" />
							</button>
						</Tooltip>
					</div>
				)}
				{hq && (
					<div className="shrink-0 pt-2 mt-2 w-full flex justify-center border-t border-border">
						<Tooltip content={hq.name} side="right">
							<Link
								to="/projects/$projectId"
								params={{ projectId: hq.slug }}
								aria-label={hq.name}
								data-testid="project-rail-hq"
								className={`relative w-9 h-9 rounded-full flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface border border-border bg-surface transition-colors ${
									hqActive ? 'ring-2 ring-inverse ring-offset-1 ring-offset-surface-2' : ''
								}`}
							>
								<Building2 className="w-4 h-4" />
								<CountOverlayBadge
									count={hqInbox?.unread ?? 0}
									testId="project-rail-hq-inbox-badge"
								/>
							</Link>
						</Tooltip>
					</div>
				)}
			</nav>
			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
