import { HQ_PROJECT_NAME } from '@hezo/shared';
import { NameSwitcherButton, type SearchableSelectOption } from '@hezo/ui';
import { Check, Copy, Plus, X } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import type { ChatLaunch } from '../../contexts/chat-launch-context';
import { useActiveProject } from '../../hooks/use-active-project';
import {
	CEO_ROOM,
	type ChatConversationSummary,
	type ChatRoom,
	chatRoomKey,
	type ProjectChatGroupSummary,
	readStoredRoom,
	useChatConversations,
	useProjectChatRooms,
	writeStoredRoom,
} from '../../hooks/use-chat';
import { useCloseOnRouteChange } from '../../hooks/use-close-on-route-change';
import { useMediaQuery } from '../../hooks/use-media-query';
import { useProjectMeta } from '../../hooks/use-projects';
import { useI18n } from '../../lib/i18n';
import { PANEL_MOTION_TRANSITION } from '../../lib/panel-motion';
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from '../../lib/panel-width-storage';
import { useResizableSplit } from '../ui/resizable-split';
import { Tooltip } from '../ui/tooltip';
import { ChatSurface, Dots } from './chat-surface';
import { CreateGroupDialog } from './create-group-dialog';

/**
 * The chat dock: the app-wide chat surface. On desktop it is a right-hand rail,
 * flush to the edge and running from under the shell header to the bottom, which
 * the operator can drag wider; on mobile it stays a near-full-screen sheet. It
 * overlays the page rather than displacing it - nothing below reflows when chat
 * opens. Chat lives in rooms, not routes - the switcher on the room title
 * carries the pinned CEO (HQ) on top and, inside a project, that project's agent
 * DMs; team channels and History follow. There is no expand mode and no separate
 * chat page.
 *
 * The dock owns room selection and the panel chrome; everything inside a room
 * (messages, queue, composer, attachments) is `ChatSurface`, shared with the
 * fresh-instance landing.
 */
interface ChatWidgetProps {
	/** Open state is lifted to the shell so the header launcher can drive it. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * A surface asking for a specific room with a prefilled composer (see
	 * `ChatLaunchContext`). Applied once per `nonce`, never sent.
	 */
	launch?: ChatLaunch | null;
}

/** The rail's width before the operator has ever dragged it. */
const DEFAULT_RAIL_WIDTH = 420;

/** The rail shares the viewport, not a grid track - see `measureContainer`. */
const viewportWidth = () => (typeof window === 'undefined' ? undefined : window.innerWidth);

export function ChatWidget({ open, onOpenChange, launch = null }: ChatWidgetProps) {
	const setOpen = onOpenChange;
	// The selected room (default: the CEO's live stream). Seeded from the last
	// room the operator switched to, so reopening the dock resumes it.
	const [room, setRoom] = useState<ChatRoom>(() => readStoredRoom() ?? CEO_ROOM);
	const selectRoom = useCallback((next: ChatRoom) => {
		setRoom(next);
		writeStoredRoom(next);
	}, []);
	const { conversations, loaded: threadsLoaded } = useChatConversations(open);
	// The current (non-internal) project's DM rooms for the switcher section.
	const active = useActiveProject();
	const activeProjectMeta = useProjectMeta(active?.slug ?? '');
	const projectSlug = activeProjectMeta && !activeProjectMeta.is_internal ? active?.slug : null;
	const {
		rooms: projectRooms,
		groups: projectGroups,
		loaded: roomsLoaded,
	} = useProjectChatRooms(projectSlug, open);
	// The selected room's own project names the header scope - which can differ
	// from the ACTIVE project when the operator navigated away mid-conversation.
	const roomProjectMeta = useProjectMeta(
		room.kind === 'agent' || room.kind === 'group' ? room.projectSlug : '',
	);
	const { t } = useI18n();
	// The create-room dialog (the "+" in the header). Project rooms only.
	const [creatingGroup, setCreatingGroup] = useState(false);
	// Whether the room switcher's panel is open. Escape has two meanings once a
	// popover lives inside the dock, and the inner one wins - see the key handler.
	const [switcherOpen, setSwitcherOpen] = useState(false);
	// Drag-to-resize for the desktop rail. The rail is `fixed`, so it shares the
	// viewport rather than a grid track - hence `measureContainer`, which keeps
	// MIN_MAIN_WIDTH of page uncovered however wide the operator drags.
	const {
		width: railWidth,
		isResizing,
		panelCellRef,
		handleProps,
	} = useResizableSplit({
		side: 'right',
		storageKey: 'hezo_chat_rail_width',
		measureContainer: viewportWidth,
	});

	// Apply a launch request's room side; the composer side (draft, focus) is
	// the surface's, keyed on the same nonce.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one application per launch request
	useEffect(() => {
		if (!launch) return;
		selectRoom(launch.room);
	}, [launch?.nonce]);

	// Escape closes the chat - unless the room switcher's panel is open, which
	// takes Escape for itself. Radix dismisses the popover on document, then this
	// listener runs on window with the pre-update value still `true`, so without
	// the guard one Escape would dismiss the panel AND close the dock behind it.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || switcherOpen) return;
			setOpen(false);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [open, setOpen, switcherOpen]);

	// Navigating away only strands the reader in the blocking presentation - the
	// mobile full-screen panel with its backdrop. The anchored desktop corner
	// panel is a deliberately persistent companion and survives navigation.
	const isDesktop = useMediaQuery('(min-width: 768px)');
	useCloseOnRouteChange(open && !isDesktop, () => setOpen(false));

	// CEO-scope threads, grouped for the switcher. The live stream is reached
	// through the pinned CEO entry (server-resolved), so open web threads are not
	// listed separately; external DMs stay live, coworker channels are read-only,
	// and closed threads are History.
	const externalThreads = conversations.filter(
		(c) => c.kind !== 'coworker' && c.channel !== 'web' && !c.closed_at,
	);
	const coworkerThreads = conversations.filter((c) => c.kind === 'coworker' && !c.closed_at);
	const historyThreads = conversations.filter((c) => c.closed_at != null);
	const activeThread =
		room.kind === 'thread' ? conversations.find((c) => c.id === room.id) : undefined;
	const threadLabel = (c: ChatConversationSummary) => c.title?.trim() || t('chat.thread.untitled');

	// A selected group room's live row - its rename and unread state come from
	// the list, so the header follows a rename without reselecting.
	const activeGroup =
		room.kind === 'group' ? projectGroups.find((g) => g.id === room.conversationId) : undefined;
	const groupLabel = (g: ProjectChatGroupSummary) => g.title?.trim() || t('chat.group.untitled');

	// Who the operator is talking to, for the header.
	const roomTitle =
		room.kind === 'agent'
			? room.title
			: room.kind === 'group'
				? activeGroup
					? groupLabel(activeGroup)
					: room.title
				: room.kind === 'thread'
					? activeThread
						? threadLabel(activeThread)
						: t('chat.thread.untitled')
					: 'CEO';
	const roomScope =
		room.kind === 'agent' || room.kind === 'group'
			? (roomProjectMeta?.name ?? room.projectSlug)
			: HQ_PROJECT_NAME;

	// A remembered thread can be closed later; a remembered agent can be fired.
	// Once the lists have loaded, a selection they no longer carry falls back to
	// the CEO. History threads stay selectable - readable, composer locked.
	useEffect(() => {
		if (!open || room.kind !== 'thread' || !threadsLoaded) return;
		if (!conversations.some((c) => c.id === room.id)) selectRoom(CEO_ROOM);
	}, [open, room, threadsLoaded, conversations, selectRoom]);
	// Same for a remembered group room of the CURRENT project that no longer
	// exists (a foreign project's room cannot be verified from here and stays).
	useEffect(() => {
		if (!open || room.kind !== 'group' || !roomsLoaded) return;
		if (room.projectSlug !== projectSlug) return;
		if (!projectGroups.some((g) => g.id === room.conversationId)) selectRoom(CEO_ROOM);
	}, [open, room, roomsLoaded, projectGroups, projectSlug, selectRoom]);
	// And for a remembered agent DM whose agent has since been fired: the roster
	// list no longer carries it, its history read 404s, and a send would fail -
	// so it falls back like a dead thread or room does.
	useEffect(() => {
		if (!open || room.kind !== 'agent' || !roomsLoaded) return;
		if (room.projectSlug !== projectSlug) return;
		if (!projectRooms.some((r) => r.slug === room.agentSlug)) selectRoom(CEO_ROOM);
	}, [open, room, roomsLoaded, projectRooms, projectSlug, selectRoom]);

	// The dock renders nothing while closed: the header monogram is the launcher.
	if (!open) return null;

	// A selected agent or group room from ANOTHER project (the operator
	// navigated away) stays reachable: it renders as its own option so the
	// switcher never shows a value it does not carry.
	const foreignAgentRoom =
		room.kind === 'agent' && (!projectSlug || room.projectSlug !== projectSlug) ? room : null;
	const foreignGroupRoom =
		room.kind === 'group' && (!projectSlug || room.projectSlug !== projectSlug) ? room : null;
	// The switcher's option values. The current project's DM options are keyed by
	// bare agent slug (the project is implied by the optgroup) and its rooms by
	// bare conversation id; only a foreign room's option carries the full key.
	const roomValue =
		room.kind === 'agent' && !foreignAgentRoom
			? `agent:${room.agentSlug}`
			: room.kind === 'group' && !foreignGroupRoom
				? `group:${room.conversationId}`
				: chatRoomKey(room);
	const onSwitcherChange = (value: string) => {
		if (value === roomValue) return;
		if (value === 'ceo') return selectRoom(CEO_ROOM);
		if (value.startsWith('thread:')) return selectRoom({ kind: 'thread', id: value.slice(7) });
		if (value.startsWith('group:')) {
			const id = value.slice(6);
			const g = projectGroups.find((row) => row.id === id);
			if (g && projectSlug) {
				selectRoom({
					kind: 'group',
					projectSlug,
					conversationId: g.id,
					title: groupLabel(g),
					isGeneral: g.is_general,
				});
			}
			return;
		}
		if (value.startsWith('agent:')) {
			const slug = value.slice(6);
			const row = projectRooms.find((r) => r.slug === slug);
			if (row && projectSlug) {
				selectRoom({ kind: 'agent', projectSlug, agentSlug: row.slug, title: row.title });
			}
		}
	};

	// The switcher's options, in the order the panel draws them: the pinned CEO,
	// a foreign room the operator navigated away from, then the current project's
	// DMs and group rooms, external chats, read-only channels and History. Each
	// section is a `group`, which the panel labels once and drops when a filter
	// empties it.
	const roomOptions: SearchableSelectOption[] = (() => {
		const opts: SearchableSelectOption[] = [{ value: 'ceo', label: `CEO · ${HQ_PROJECT_NAME}` }];
		if (foreignAgentRoom) {
			opts.push({
				value: roomValue,
				label: foreignAgentRoom.title,
				description: foreignAgentRoom.projectSlug,
			});
		}
		if (foreignGroupRoom) {
			opts.push({
				value: roomValue,
				label: foreignGroupRoom.title,
				description: foreignGroupRoom.projectSlug,
			});
		}
		if (projectSlug && projectRooms.length > 0) {
			const label = activeProjectMeta?.name ?? projectSlug;
			for (const r of projectRooms) {
				opts.push({
					value: `agent:${r.slug}`,
					label: r.title,
					group: label,
					badge: r.unread ? 'dot' : undefined,
				});
			}
		}
		if (projectSlug && projectGroups.length > 0) {
			for (const g of projectGroups) {
				opts.push({
					value: `group:${g.id}`,
					label: groupLabel(g),
					group: t('chat.room.groupsGroup'),
					badge: g.unread ? 'dot' : undefined,
				});
			}
		}
		for (const c of externalThreads) {
			opts.push({
				value: `thread:${c.id}`,
				label: threadLabel(c),
				description: channelChip(c) ?? undefined,
				group: t('chat.room.externalGroup'),
			});
		}
		for (const c of coworkerThreads) {
			opts.push({
				value: `thread:${c.id}`,
				// The lock says the thread is read-only here; replies go to its home
				// surface, which the chip names.
				label: `${threadLabel(c)} 🔒`,
				description: channelChip(c) ?? undefined,
				group: t('chat.room.channelsGroup'),
			});
		}
		for (const c of historyThreads) {
			opts.push({
				value: `thread:${c.id}`,
				label: threadLabel(c),
				group: t('chat.room.historyGroup'),
			});
		}
		return opts;
	})();

	return (
		<>
			{/* Modal scrim on mobile, where the sheet floats over the page. The
			    desktop rail is a persistent companion that survives navigation, so it
			    takes none - a scrim would make it modal. */}
			<button
				type="button"
				aria-label="Close chat"
				data-testid="chat-overlay"
				onClick={() => setOpen(false)}
				className="fixed inset-x-0 bottom-0 top-12 z-40 bg-overlay cursor-default md:hidden"
			/>
			<div
				ref={panelCellRef}
				data-testid="chat-panel"
				// Mobile: a near-full-screen sheet. Desktop: a rail flush to the right
				// edge, starting below the h-12 shell header so the top bar stays
				// reachable while chat is open, and running to the bottom. The width
				// is the dragged one once there is one; until then the default below.
				style={
					railWidth != null ? ({ '--chat-rail-w': `${railWidth}px` } as CSSProperties) : undefined
				}
				className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl inset-x-2 bottom-2 top-16 md:inset-auto md:right-0 md:top-12 md:bottom-0 md:h-auto md:rounded-none md:border-y-0 md:border-r-0 md:w-[var(--chat-rail-w,420px)] ${
					isResizing ? '' : PANEL_MOTION_TRANSITION
				}`}
			>
				{/* Resize handle on the rail's inner edge. Desktop only - the mobile
				    sheet is sized by the viewport. Keyboard-resizable through the same
				    props, so the drag is not the only way to widen it. */}
				{/* The WAI-ARIA window-splitter pattern, as `ResizableSplit` draws it: a
				    focusable `separator` with value semantics. An `<hr>`
				    (useSemanticElements' suggestion) cannot be focused. */}
				{/* biome-ignore lint/a11y/useSemanticElements: focusable resize separator, not an <hr> */}
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label={t('chat.rail.resize')}
					// A focusable separator is the window-splitter pattern: it reports the
					// width it is set to, and the bounds it may be dragged between.
					aria-valuenow={railWidth ?? DEFAULT_RAIL_WIDTH}
					aria-valuemin={MIN_PANEL_WIDTH}
					aria-valuemax={MAX_PANEL_WIDTH}
					tabIndex={0}
					data-testid="chat-rail-resize"
					{...handleProps}
					className="absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize md:block hover:bg-border-strong focus-visible:bg-border-strong focus-visible:outline-none"
				/>
				<ChatSurface
					room={room}
					active={open}
					launch={launch}
					thread={activeThread}
					header={({ streaming, queued, copyConversation, copied, canCopy }) => (
						<header className="flex items-center justify-between gap-1 border-b border-border px-4 py-3">
							<div className="flex min-w-0 items-center gap-2">
								<span
									className="truncate text-sm font-semibold text-text-1"
									data-testid="chat-room-title"
									// The room the dock is on, without opening the switcher to read
									// its checked option - the native <select> used to answer this
									// with `.value`.
									data-room={roomValue}
								>
									{roomTitle}
								</span>
								{/* The room title IS the switcher: a whole row back, which a tall
								    rail spends on messages and a phone needs outright. */}
								<NameSwitcherButton
									options={roomOptions}
									value={roomValue}
									onSelect={onSwitcherChange}
									label={t('chat.room.switcher')}
									searchPlaceholder={t('chat.room.searchPlaceholder')}
									emptyLabel={t('chat.room.noMatches')}
									badgeLabel={t('chat.room.unread')}
									onOpenChange={setSwitcherOpen}
									testId="chat-room-select"
								/>
								{/* Hidden at phone width: with the longest roster name plus the
								    dots and a queued chip the header overflows 359px, and the
								    scope is already the switcher's group heading. */}
								<span className="hidden shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2 sm:inline-block">
									{roomScope}
								</span>
								{streaming && (
									<span data-testid="chat-header-dots" className="pl-0.5">
										<Dots />
									</span>
								)}
								{queued > 0 && (
									<span
										data-testid="chat-queue-count"
										className="rounded-sm border border-purple-soft-fg bg-purple-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-soft-fg"
									>
										{queued} queued
									</span>
								)}
							</div>
							<div className="flex shrink-0 items-center gap-1">
								{projectSlug && (
									<Tooltip content={t('chat.group.new')} side="bottom">
										<button
											type="button"
											onClick={() => setCreatingGroup(true)}
											aria-label={t('chat.group.new')}
											data-testid="chat-new-group"
											className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
										>
											<Plus className="h-4 w-4" />
										</button>
									</Tooltip>
								)}
								<button
									type="button"
									onClick={copyConversation}
									disabled={!canCopy}
									aria-label={copied ? 'Conversation copied' : 'Copy conversation'}
									data-testid="chat-copy"
									className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1 disabled:pointer-events-none disabled:opacity-40"
								>
									{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
								</button>
								<button
									type="button"
									onClick={() => setOpen(false)}
									aria-label="Close chat"
									data-testid="chat-close"
									className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
								>
									<X className="h-4 w-4" />
								</button>
							</div>
						</header>
					)}
				/>
			</div>

			{creatingGroup && projectSlug && (
				<CreateGroupDialog
					projectSlug={projectSlug}
					agents={projectRooms}
					onClose={() => setCreatingGroup(false)}
					onCreated={(created) => {
						setCreatingGroup(false);
						selectRoom({
							kind: 'group',
							projectSlug,
							conversationId: created.conversationId,
							title: created.title,
						});
					}}
				/>
			)}
		</>
	);
}

/**
 * Short origin chip for a thread's home surface ("TG DM", "TG TOPIC",
 * "SLACK DM", "SLACK", …); null for web threads, which need no badge.
 */
function channelChip(c: ChatConversationSummary): string | null {
	if (c.channel === 'web') return null;
	if (c.kind === 'coworker') return c.channel.toUpperCase();
	const inTopic = c.external_thread_id?.includes(':') ?? false;
	if (c.channel === 'telegram') return inTopic ? 'TG TOPIC' : 'TG DM';
	return `${c.channel.toUpperCase()} DM`;
}
