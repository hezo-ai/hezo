import { Link } from '@tanstack/react-router';
import { Building2, Home, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
 * each project is presented as a standalone entity.
 *
 * The create-project action is the last item *inside* the scrolling avatar
 * list, with `sticky bottom-0`: while the avatars fit the rail it simply flows
 * right after the last one, and once they overflow it pins to the bottom of
 * the visible area (the avatars scroll beneath it) with an elevation shadow
 * marking the pinned state. Only the HQ entry stays pinned below the scroll
 * area, behind a border.
 *
 * `showHome` pins a Home button above the avatar list (separated by a border).
 * It's used in the mobile side drawer, where the header logo opens the drawer
 * instead of linking home, so the drawer needs its own way back to the dashboard.
 */
export function ProjectRail({ showHome = false }: { showHome?: boolean } = {}) {
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

	// Whether the avatar list overflows its viewport. Drives only the shadow on
	// the sticky create button — its position is pure CSS, so toggling the class
	// never changes layout and there is no measure→move feedback loop.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [overflowing, setOverflowing] = useState(false);
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const measure = () => setOverflowing(el.scrollHeight - el.clientHeight > 1);
		measure();
		// The container box changes on window resize or when the pinned HQ block
		// (de)mounts; content growth (projects loading in) changes scrollHeight
		// without a box change, which only the childList observer sees.
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		const mo = new MutationObserver(measure);
		mo.observe(el, { childList: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
		};
	}, []);

	return (
		<>
			<nav
				className="w-[60px] shrink-0 h-full border-r border-border bg-surface-2 flex flex-col items-center py-3"
				data-testid="project-rail"
				aria-label="Projects"
			>
				{showHome && (
					<div className="shrink-0 pb-2 mb-1 w-full flex justify-center border-b border-border">
						<Tooltip content="Home" side="right">
							<Link
								to="/home"
								aria-label="Home"
								data-testid="project-rail-home"
								className="w-9 h-9 rounded-md flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface border border-border bg-surface transition-colors"
							>
								<Home className="w-4 h-4" />
							</Link>
						</Tooltip>
					</div>
				)}
				{/*
				  `overflow-y-auto` clips to the padding box, so the count badge
				  (`-top-1.5`, 6px above each avatar) on the topmost avatar would be
				  cut off without enough top padding. `pt-2.5` (10px) clears the
				  overhang plus the active ring.
				*/}
				<div
					ref={scrollRef}
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
									className={`relative inline-flex rounded-full transition-shadow ${
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
					{me?.is_superuser && (
						/*
						  Sticky, not a pinned sibling: in flow it sits right after the
						  last avatar; once the list overflows it stops at the viewport
						  bottom while the avatars scroll beneath. The full-width opaque
						  wrapper masks avatars sliding under; the shadow (elevation, no
						  separator border) only appears while the list overflows.
						*/
						<div className="sticky bottom-0 z-10 shrink-0 w-full flex justify-center py-1 bg-surface-2">
							<Tooltip content="New project" side="right">
								<button
									type="button"
									onClick={() => setCreateOpen(true)}
									aria-label="New project"
									data-testid="project-rail-new"
									className={`w-9 h-9 rounded-md flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface border border-dashed border-border transition ${
										overflowing ? 'shadow-up' : ''
									}`}
								>
									<Plus className="w-4 h-4" />
								</button>
							</Tooltip>
						</div>
					)}
				</div>
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
