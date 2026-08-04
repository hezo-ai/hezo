import { Link } from '@tanstack/react-router';
import { Globe, Home, Plus } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { useInboxUnreadCount, useInboxUnreadCountsBySlug } from '../hooks/use-inbox-count';
import { useMe } from '../hooks/use-me';
import {
	type ProjectWithTeam,
	useAllVisibleProjects,
	useHqProject,
	useReorderProjects,
} from '../hooks/use-projects';
import { moveItem, useSortableRail } from '../hooks/use-sortable-rail';
import { useI18n } from '../lib/i18n';
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
 * the visible area (the avatars scroll beneath it). Its elevation shadow is
 * always on — it is the button's affordance in both states; there is no
 * separator border in either. Only the HQ entry stays pinned below the
 * scroll area, behind a border.
 *
 * `showHome` pins a Home button above the avatar list (separated by a border).
 * It's used in the mobile side drawer, where the header logo opens the drawer
 * instead of linking home, so the drawer needs its own way back to the dashboard.
 *
 * The avatars are drag-reorderable (see `use-sortable-rail`): press and drag with
 * a mouse, press-and-hold then drag on touch, or `Alt+ArrowUp`/`Alt+ArrowDown`
 * from the keyboard. The order is global to the instance, so — like the create
 * button below and archiving — it is offered to superusers only. Neither the
 * create button nor the pinned HQ entry takes part.
 */
export function ProjectRail({ showHome = false }: { showHome?: boolean } = {}) {
	const { t } = useI18n();
	const { data: me } = useMe();
	const { projects } = useAllVisibleProjects();
	const hq = useHqProject();
	const active = useActiveProject();
	const inboxCounts = useInboxUnreadCountsBySlug();
	const reorder = useReorderProjects();
	const canReorder = !!me?.is_superuser && projects.length > 1;
	const { containerRef, getItemProps, announcement } = useSortableRail<ProjectWithTeam>({
		items: projects,
		enabled: canReorder,
		labelFor: (p) => p.name,
		onReorder: (from, to) => reorder.mutate(moveItem(projects, from, to).map((p) => p.id)),
	});
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
				aria-label={t('nav.projects')}
			>
				{showHome && (
					<div className="shrink-0 pb-2 mb-1 w-full flex justify-center border-b border-border">
						<Tooltip content={t('nav.home')} side="right">
							<Link
								to="/home"
								aria-label={t('nav.home')}
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
					ref={containerRef}
					className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center gap-2 pt-2.5 pb-1"
					data-testid="project-rail-scroll"
				>
					{projects.map((p, index) => {
						const isActive = active?.slug === p.slug && active?.teamSlug === p.teamSlug;
						/*
						  The drag handlers live on this wrapper rather than the Link:
						  Radix's `Tooltip.Trigger asChild` already owns the Link's pointer
						  handlers, and pointerdown bubbles up here anyway. The wrapper is
						  also what the hook measures and transforms, so the lifted avatar
						  and its displaced neighbours all move *inside* the scroll
						  container — `overflow-y-auto` never has an escaping element to
						  clip. `items-center` keeps it shrink-to-fit, so it adds no layout.
						*/
						return (
							<div key={p.id} data-sortable-index={index} {...getItemProps(index)}>
								<Tooltip content={p.name} side="right">
									<Link
										to="/projects/$projectId"
										params={{ projectId: p.slug }}
										aria-label={p.name}
										// Chromium natively drags anchors; that gesture would hijack
										// the reorder drag and cancel the pointer stream.
										draggable={false}
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
							</div>
						);
					})}
					{me?.is_superuser && (
						/*
						  Sticky, not a pinned sibling: in flow it sits right after the
						  last avatar; once the list overflows it stops at the viewport
						  bottom while the avatars scroll beneath. The full-width opaque
						  wrapper masks avatars sliding under. The shadow is always on
						  (upward, so the overflow box can't clip it away in the stuck
						  position) — there is no separator border in either state.
						*/
						<div className="sticky bottom-0 z-10 shrink-0 w-full flex justify-center py-1 bg-surface-2">
							<Tooltip content="New project" side="right">
								<button
									type="button"
									onClick={() => setCreateOpen(true)}
									aria-label="New project"
									data-testid="project-rail-new"
									className="w-9 h-9 rounded-md flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface border border-dashed border-border transition-colors shadow-up"
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
								// A full-bleed icon drops the border and surface fill (the same rule
								// `Avatar` follows): keeping them would leave a grey ring between the
								// image and the active ring. Without an icon, HQ keeps its globe glyph
								// — the same mark the sidebar puts on the global agents HQ hosts.
								className={`relative w-9 h-9 rounded-full flex items-center justify-center overflow-hidden transition-colors ${
									hq.icon_url
										? ''
										: 'text-text-2 hover:text-text-1 hover:bg-surface border border-border bg-surface'
								} ${hqActive ? 'ring-2 ring-inverse ring-offset-1 ring-offset-surface-2' : ''}`}
							>
								{hq.icon_url ? (
									<img src={hq.icon_url} alt="" className="w-full h-full object-cover" />
								) : (
									<Globe className="w-4 h-4" />
								)}
								<CountOverlayBadge
									count={hqInbox?.unread ?? 0}
									testId="project-rail-hq-inbox-badge"
								/>
							</Link>
						</Tooltip>
					</div>
				)}
				{/* Announces keyboard reorders, which have no other audible result. */}
				<div
					className="sr-only"
					role="status"
					aria-live="polite"
					data-testid="project-rail-reorder-status"
				>
					{announcement}
				</div>
			</nav>
			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
