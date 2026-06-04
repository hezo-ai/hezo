import { Link } from '@tanstack/react-router';
import { BookOpen, FolderKanban, House, Inbox, KeyRound, Plug, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../hooks/use-me';
import { CreateProjectWithTeamDialog } from './create-project-with-team-dialog';

const iconLinkClass =
	'w-9 h-9 rounded-radius-md flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-elevated transition-colors';

/**
 * The 60px global rail: a thin, projects-primary navigation axis. Quick links to
 * the projects home, the cross-team inbox, and all tasks; a superuser "+" to
 * create a new project (with its own team); and instance-resource shortcuts
 * (Skills / Connectors / Credentials, Admin-only) plus Settings pinned at the
 * bottom. Individual project-teams are reached through the Home project list and
 * All Tasks — not the rail — now that each project owns its team.
 */
export function TeamRail() {
	const { data: me } = useMe();
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<>
			<nav
				className="w-[60px] shrink-0 h-full border-r border-border bg-bg-subtle flex flex-col items-center py-3 gap-2 overflow-y-auto"
				data-testid="team-rail"
				aria-label="Primary"
			>
				<Link
					to="/home"
					aria-label="Home"
					title="Home"
					data-testid="team-rail-home"
					className={iconLinkClass}
				>
					<House className="w-4 h-4" />
				</Link>
				<Link
					to="/home/inbox"
					aria-label="Inbox"
					title="Inbox"
					data-testid="team-rail-inbox"
					className={iconLinkClass}
				>
					<Inbox className="w-4 h-4" />
				</Link>
				<Link
					to="/home/tasks"
					aria-label="All Tasks"
					title="All Tasks"
					data-testid="team-rail-all-tasks"
					className={iconLinkClass}
				>
					<FolderKanban className="w-4 h-4" />
				</Link>
				{me?.is_superuser && (
					<>
						<div className="w-7 border-t border-border my-1" />
						<button
							type="button"
							onClick={() => setCreateOpen(true)}
							title="New project"
							aria-label="New project"
							data-testid="team-rail-new"
							className="w-9 h-9 rounded-radius-md flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-elevated border border-dashed border-border transition-colors"
						>
							<Plus className="w-4 h-4" />
						</button>
					</>
				)}

				{/* Instance-level resources, pinned to the bottom of the rail. The
				    Skills/Connectors/Credentials shortcuts are Admin-only; Settings is
				    available to everyone. */}
				<div className="mt-auto flex flex-col items-center gap-2 pt-2">
					<div className="w-7 border-t border-border my-1" />
					{me?.is_superuser && (
						<>
							<Link
								to="/settings/skills"
								aria-label="Skills"
								title="Skills"
								data-testid="team-rail-skills"
								className={iconLinkClass}
							>
								<BookOpen className="w-4 h-4" />
							</Link>
							<Link
								to="/settings/connectors"
								aria-label="Connectors"
								title="Connectors"
								data-testid="team-rail-connectors"
								className={iconLinkClass}
							>
								<Plug className="w-4 h-4" />
							</Link>
							<Link
								to="/settings/credentials"
								aria-label="Credentials"
								title="Credentials"
								data-testid="team-rail-credentials"
								className={iconLinkClass}
							>
								<KeyRound className="w-4 h-4" />
							</Link>
						</>
					)}
					<Link
						to="/settings"
						aria-label="Settings"
						title="Settings"
						data-testid="team-rail-settings"
						className={iconLinkClass}
					>
						<Settings className="w-4 h-4" />
					</Link>
				</div>
			</nav>
			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
