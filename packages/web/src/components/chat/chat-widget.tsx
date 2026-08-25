import {
	assetBasename,
	ChatMessageStatus,
	ChatSystemMessageKind,
	displayToolName,
	HQ_PROJECT_NAME,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import {
	ArrowRight,
	Check,
	Copy,
	ExternalLink,
	History,
	Hourglass,
	ListPlus,
	Loader2,
	Lock,
	SquareCheckBig,
	StepForward,
	TriangleAlert,
	X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { ChatLaunch } from '../../contexts/chat-launch-context';
import { useActiveProject } from '../../hooks/use-active-project';
import { useAutoGrowTextarea } from '../../hooks/use-auto-grow-textarea';
import {
	CEO_ROOM,
	type ChatConversationSummary,
	type ChatConvertedTaskRef,
	type ChatMessage,
	type ChatRoom,
	chatRoomKey,
	readStoredRoom,
	useChat,
	useChatConversations,
	useProjectChatRooms,
	writeStoredRoom,
} from '../../hooks/use-chat';
import { useCloseOnRouteChange } from '../../hooks/use-close-on-route-change';
import { useContainerHealth } from '../../hooks/use-container-health';
import { useCopyFeedback } from '../../hooks/use-copy-feedback';
import { useFileAttachments } from '../../hooks/use-file-attachments';
import { LONG_PRESS_MS, useLongPress } from '../../hooks/use-long-press';
import { useMediaQuery } from '../../hooks/use-media-query';
import { useHqProject, useProjectMeta } from '../../hooks/use-projects';
import { useUploadChatAttachment } from '../../hooks/use-upload-chat-attachment';
import { copyToClipboard } from '../../lib/clipboard';
import { Trans, useI18n } from '../../lib/i18n';
import { AssetIcon } from '../asset-icon';
import {
	ATTACHMENT_ACCEPT,
	AttachmentChips,
	FileDropZone,
	UploadButton,
} from '../file-attachments';
import { HqContainerNotice } from '../hq-container-notice';
import { MarkdownProse } from '../markdown-prose';
import { RunLinkedText } from '../run-linked-text';
import { Tooltip } from '../ui/tooltip';

/**
 * System-message kinds rendered as a full-sentence row rather than a marker,
 * and how each row looks: a warning is amber, a wait or pause is quiet. Any
 * kind not listed here renders as a centred marker row.
 */
const SYSTEM_ROW_STYLE: Partial<
	Record<ChatSystemMessageKind, { icon: typeof TriangleAlert; className: string }>
> = {
	[ChatSystemMessageKind.HandoffNotDelivered]: {
		icon: TriangleAlert,
		className: 'bg-warning-soft text-warning-soft-fg',
	},
	[ChatSystemMessageKind.ConnectorRefused]: {
		icon: TriangleAlert,
		className: 'bg-warning-soft text-warning-soft-fg',
	},
	[ChatSystemMessageKind.CredentialWait]: {
		icon: Hourglass,
		className: 'bg-surface-2 text-text-3',
	},
	[ChatSystemMessageKind.BudgetExceeded]: {
		icon: TriangleAlert,
		className: 'bg-warning-soft text-warning-soft-fg',
	},
	[ChatSystemMessageKind.CapacityWait]: {
		icon: Hourglass,
		className: 'bg-surface-2 text-text-3',
	},
};

/**
 * The chat dock: the app-wide chat surface, anchored bottom-right on desktop
 * and near-full-screen on mobile. Chat lives in rooms, not routes - the dock's
 * switcher carries the pinned CEO (HQ) on top and, inside a project, that
 * project's agent DMs; team channels and History follow. There is no expand
 * mode and no separate chat page.
 *
 * The composer stays usable while a reply streams, and the send button is the
 * only thing that changes to say what will happen:
 *
 * - **Queue** (the default, and what Enter or a tap does): the message parks as
 *   a dashed bubble and can be pulled back out until the queue flushes. The
 *   whole queue then posts as ONE turn, so a single reply answers all of it.
 * - **Send now** (deliberate: hold the button, or ⌘/Ctrl+Enter): posts straight
 *   away, which server-side aborts the in-flight reply and starts a fresh turn.
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

export function ChatWidget({ open, onOpenChange, launch = null }: ChatWidgetProps) {
	const setOpen = onOpenChange;
	// The selected room (default: the CEO's live stream). Seeded from the last
	// room the operator switched to, so reopening the dock resumes it.
	const [room, setRoom] = useState<ChatRoom>(() => readStoredRoom() ?? CEO_ROOM);
	const selectRoom = useCallback((next: ChatRoom) => {
		setRoom(next);
		writeStoredRoom(next);
	}, []);
	const {
		messages,
		send,
		streaming,
		sending,
		loaded,
		compactedCount,
		queue,
		enqueue,
		dequeue,
		toolActivity,
	} = useChat(open, room);
	const { conversations, loaded: threadsLoaded } = useChatConversations(open);
	// The current (non-internal) project's DM rooms for the switcher section.
	const active = useActiveProject();
	const activeProjectMeta = useProjectMeta(active?.slug ?? '');
	const projectSlug = activeProjectMeta && !activeProjectMeta.is_internal ? active?.slug : null;
	const { rooms: projectRooms } = useProjectChatRooms(projectSlug, open);
	const { t } = useI18n();
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// A stopped HQ container is no blocker — sending a message lazy-starts it.
	// Only genuine errors and in-flight transitions swap the chat body for the
	// container state. CEO-scope rooms only; a DM's capacity states surface as
	// system rows in the thread instead.
	const blockedHealth =
		room.kind !== 'agent' && hqHealth && hqHealth.kind !== 'healthy' && hqHealth.kind !== 'stopped'
			? hqHealth
			: null;
	const [draft, setDraft] = useState('');
	const [copied, setCopied] = useState(false);
	const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
	const uploadAttachment = useUploadChatAttachment(room.kind === 'agent' ? room.projectSlug : null);
	const {
		isDragActive,
		visibleAttachments,
		uploading,
		errors,
		hasAnyChip,
		handleFiles,
		removeAttachment,
		dropZoneProps,
	} = useFileAttachments({
		value: pendingAttachmentIds,
		onChange: setPendingAttachmentIds,
		uploadFile: (file) => uploadAttachment.mutateAsync(file),
	});
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const lastId = messages.at(-1)?.id;
	const lastLen = messages.at(-1)?.content.length ?? 0;
	// Pin to the latest message as it streams in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberate scroll-to-bottom triggers
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [lastId, lastLen, streaming, open]);

	// Apply a launch request: show its room and put its text in the composer. An
	// empty launch draft (a room card click) only opens the room - it never wipes
	// text already sitting in the composer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one application per launch request
	useEffect(() => {
		if (!launch) return;
		selectRoom(launch.room);
		if (launch.draft) setDraft(launch.draft);
		const id = requestAnimationFrame(() => {
			const el = inputRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
		return () => cancelAnimationFrame(id);
	}, [launch?.nonce]);

	// Escape closes the chat.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [open, setOpen]);

	// Navigating away only strands the reader in the blocking presentation - the
	// mobile full-screen panel with its backdrop. The anchored desktop corner
	// panel is a deliberately persistent companion and survives navigation.
	const isDesktop = useMediaQuery('(min-width: 768px)');
	useCloseOnRouteChange(open && !isDesktop, () => setOpen(false));

	useAutoGrowTextarea(inputRef, [draft, open]);

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

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
	const activeReadOnly = activeThread?.kind === 'coworker';
	const activeConverted = activeThread?.converted_task_id != null;
	const activeClosed = activeThread?.closed_at != null;
	const convertedTask = activeThread?.converted_task ?? null;
	const threadLabel = (c: ChatConversationSummary) => c.title?.trim() || t('chat.thread.untitled');

	// Who the operator is talking to, for the header and bubbles.
	const roomTitle =
		room.kind === 'agent'
			? room.title
			: room.kind === 'thread'
				? activeThread
					? threadLabel(activeThread)
					: t('chat.thread.untitled')
				: 'CEO';
	const roomScope =
		room.kind === 'agent' ? (activeProjectMeta?.name ?? room.projectSlug) : HQ_PROJECT_NAME;
	const assistantLabel = room.kind === 'agent' ? room.title : 'CEO';

	// A remembered thread can be closed later; a remembered agent can be fired.
	// Once the lists have loaded, a selection they no longer carry falls back to
	// the CEO. History threads stay selectable - readable, composer locked.
	useEffect(() => {
		if (!open || room.kind !== 'thread' || !threadsLoaded) return;
		if (!conversations.some((c) => c.id === room.id)) selectRoom(CEO_ROOM);
	}, [open, room, threadsLoaded, conversations, selectRoom]);

	// The room is busy from the moment a send leaves until its reply settles.
	const busy = sending || streaming;
	const canInterrupt = streaming && !sending;
	const hasContent = draft.trim().length > 0 || visibleAttachments.length > 0;
	// Coworker threads write in their channel; History (closed / converted)
	// threads are a record. All lock the composer.
	const composerLocked = activeReadOnly || activeConverted || activeClosed;
	const canSubmit = !composerLocked && hasContent && uploading.length === 0;

	const submit = (sendNow = false) => {
		if (!canSubmit) return;
		const text = draft.trim();
		const attachments = visibleAttachments;
		setDraft('');
		setPendingAttachmentIds([]);
		if (busy && !(sendNow && canInterrupt)) {
			enqueue(text, attachments);
			return;
		}
		send(text, attachments).catch(() => undefined);
	};

	const longPress = useLongPress({
		onPress: () => submit(false),
		onLongPress: () => submit(true),
		enabled: canInterrupt && canSubmit,
	});
	const [modifierHeld, setModifierHeld] = useState(false);
	useEffect(() => {
		if (!open) return;
		const isModifier = (e: KeyboardEvent) => e.key === 'Meta' || e.key === 'Control';
		const onDown = (e: KeyboardEvent) => isModifier(e) && setModifierHeld(true);
		const onUp = (e: KeyboardEvent) => isModifier(e) && setModifierHeld(false);
		const onBlur = () => setModifierHeld(false);
		window.addEventListener('keydown', onDown);
		window.addEventListener('keyup', onUp);
		window.addEventListener('blur', onBlur);
		return () => {
			window.removeEventListener('keydown', onDown);
			window.removeEventListener('keyup', onUp);
			window.removeEventListener('blur', onBlur);
		};
	}, [open]);

	const coarsePointer = useMediaQuery('(pointer: coarse)');
	const armed = canInterrupt && canSubmit && (longPress.armed || modifierHeld);
	const buttonHint = !busy
		? 'Send message'
		: armed
			? 'Send now - stops the current reply'
			: !canInterrupt
				? 'Queue - sends when the reply finishes'
				: coarsePointer
					? 'Queue - hold to send now'
					: 'Queue (Enter) - hold, or Cmd/Ctrl Enter, to send now';

	// The latest completed assistant reply's one-tap suggestions. Cleared the
	// moment the operator types, queues, or a newer message lands.
	const tail = messages.at(-1);
	const suggestedReplies =
		!busy && draft.trim() === '' && queue.length === 0 && tail?.role === 'assistant'
			? (tail.suggested_replies ?? null)
			: null;

	// Copy the whole conversation as plain text, each turn labelled by speaker.
	const copyConversation = async () => {
		const transcript = messages
			.filter((m) => m.content.trim().length > 0)
			.map((m) => {
				const speaker =
					m.role === 'assistant'
						? `${assistantLabel} · ${roomScope}`
						: m.role === 'system'
							? 'System'
							: 'You';
				return `${speaker}: ${m.content}`;
			})
			.join('\n\n');
		if (!transcript) return;
		if (await copyToClipboard(transcript)) {
			setCopied(true);
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
			copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
		}
	};

	// The dock renders nothing while closed: the header monogram is the launcher.
	if (!open) return null;

	// A selected agent room from ANOTHER project (the operator navigated away)
	// stays reachable: it renders as its own option so the switcher never shows
	// a value it does not carry.
	const foreignAgentRoom =
		room.kind === 'agent' && (!projectSlug || room.projectSlug !== projectSlug) ? room : null;
	// The switcher's option values. The current project's DM options are keyed by
	// bare agent slug (the project is implied by the optgroup); only the foreign
	// room's own option carries the full room key.
	const roomValue =
		room.kind === 'agent' && !foreignAgentRoom ? `agent:${room.agentSlug}` : chatRoomKey(room);
	const onSwitcherChange = (value: string) => {
		if (value === roomValue) return;
		if (value === 'ceo') return selectRoom(CEO_ROOM);
		if (value.startsWith('thread:')) return selectRoom({ kind: 'thread', id: value.slice(7) });
		if (value.startsWith('agent:')) {
			const slug = value.slice(6);
			const row = projectRooms.find((r) => r.slug === slug);
			if (row && projectSlug) {
				selectRoom({ kind: 'agent', projectSlug, agentSlug: row.slug, title: row.title });
			}
		}
	};

	return (
		<>
			{/* Modal scrim on mobile, where the panel floats over the page. The
			    anchored desktop corner panel is a persistent companion and needs none. */}
			<button
				type="button"
				aria-label="Close chat"
				data-testid="chat-overlay"
				onClick={() => setOpen(false)}
				className="fixed inset-x-0 bottom-0 top-12 z-40 bg-[var(--overlay)] cursor-default md:hidden"
			/>
			<div
				data-testid="chat-panel"
				className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl inset-x-2 bottom-2 top-16 md:inset-auto md:bottom-4 md:right-4 md:top-auto md:h-[560px] md:w-[420px]"
			>
				<header className="flex items-center justify-between border-b border-border px-4 py-3">
					<div className="flex min-w-0 items-center gap-2">
						<span
							className="truncate text-sm font-semibold text-text-1"
							data-testid="chat-room-title"
						>
							{roomTitle}
						</span>
						<span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">
							{roomScope}
						</span>
						{streaming && (
							<span data-testid="chat-header-dots" className="pl-0.5">
								<Dots />
							</span>
						)}
						{queue.length > 0 && (
							<span
								data-testid="chat-queue-count"
								className="rounded-sm border border-purple-soft-fg bg-purple-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-soft-fg"
							>
								{queue.length} queued
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={copyConversation}
							disabled={messages.length === 0}
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

				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{/* Room switcher: the pinned CEO on top, the current project's DMs,
					    then team channels and History. No "All chats" - the dock and the
					    project menu are the whole chat surface. */}
					<div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
						<select
							data-testid="chat-room-select"
							aria-label={t('chat.room.switcher')}
							value={roomValue}
							onChange={(e) => onSwitcherChange(e.target.value)}
							className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-1"
						>
							<option value="ceo">CEO · {HQ_PROJECT_NAME}</option>
							{foreignAgentRoom && (
								<option value={roomValue}>
									{foreignAgentRoom.title} · {foreignAgentRoom.projectSlug}
								</option>
							)}
							{projectSlug && projectRooms.length > 0 && (
								<optgroup label={activeProjectMeta?.name ?? projectSlug}>
									{projectRooms.map((r) => (
										<option key={r.member_id} value={`agent:${r.slug}`}>
											{r.title}
											{r.unread ? ' ●' : ''}
										</option>
									))}
								</optgroup>
							)}
							{externalThreads.length > 0 && (
								<optgroup label={t('chat.room.externalGroup')}>
									{externalThreads.map((c) => (
										<option key={c.id} value={`thread:${c.id}`}>
											{threadLabel(c)}
											{channelChip(c) ? ` · ${channelChip(c)}` : ''}
										</option>
									))}
								</optgroup>
							)}
							{coworkerThreads.length > 0 && (
								<optgroup label={t('chat.room.channelsGroup')}>
									{coworkerThreads.map((c) => (
										<option key={c.id} value={`thread:${c.id}`}>
											{threadLabel(c)} 🔒{channelChip(c) ? ` · ${channelChip(c)}` : ''}
										</option>
									))}
								</optgroup>
							)}
							{historyThreads.length > 0 && (
								<optgroup label={t('chat.room.historyGroup')}>
									{historyThreads.map((c) => (
										<option key={c.id} value={`thread:${c.id}`}>
											{threadLabel(c)}
										</option>
									))}
								</optgroup>
							)}
						</select>
					</div>

					{hq && blockedHealth ? (
						<div
							data-testid="chat-messages"
							className="flex flex-1 items-center justify-center overflow-y-auto"
						>
							<HqContainerNotice
								health={blockedHealth}
								description="The CEO is unavailable until the HQ container is running."
							/>
						</div>
					) : (
						<FileDropZone
							isDragActive={isDragActive}
							dropZoneProps={dropZoneProps}
							className="flex flex-1 flex-col overflow-hidden"
							data-testid="chat-drop"
							overlayTestId="chat-drop-overlay"
						>
							<div
								ref={scrollRef}
								data-testid="chat-messages"
								className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 scroll-smooth"
							>
								{!loaded && (
									<div className="flex items-center justify-center py-6 text-[13px] text-text-2">
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										Loading…
									</div>
								)}
								{loaded && messages.length === 0 && compactedCount === 0 && (
									<p className="px-1 py-6 text-center text-[13px] text-text-2">
										{room.kind === 'agent'
											? t('chat.empty.agent', { name: room.title })
											: t('chat.empty.ceo')}
									</p>
								)}
								{loaded && compactedCount > 0 && (
									<div
										data-testid="chat-compacted-banner"
										className="flex items-center gap-2 px-1 pt-1 text-[11px] text-text-3"
										title="Older messages were summarized into long-term memory and removed from the live chat."
									>
										<span className="h-px flex-1 bg-border" />
										<span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-0.5">
											<History className="h-3 w-3" aria-hidden="true" />
											Earlier messages compacted into memory
										</span>
										<span className="h-px flex-1 bg-border" />
									</div>
								)}
								{messages.map((m) => (
									<MessageBubble
										key={m.id}
										message={m}
										assistantLabel={assistantLabel}
										assistantScope={roomScope}
										projectSlug={room.kind === 'agent' ? room.projectSlug : hq?.slug}
										convertedTask={convertedTask}
										toolActivity={toolActivity}
									/>
								))}
								{queue.length > 0 && <QueuedMessages queue={queue} onRemove={dequeue} />}
								{suggestedReplies && suggestedReplies.length > 0 && (
									<div
										className="flex flex-wrap justify-end gap-1.5"
										data-testid="chat-suggested-replies"
									>
										{suggestedReplies.map((reply) => (
											<button
												key={reply}
												type="button"
												data-testid="chat-suggested-reply"
												onClick={() => send(reply).catch(() => undefined)}
												className="rounded-full border border-accent px-3 py-1.5 text-[12px] text-accent hover:bg-accent-solid hover:text-accent-solid-fg transition-colors"
											>
												{reply}
											</button>
										))}
									</div>
								)}
							</div>

							<div className="border-t border-border p-3">
								{activeReadOnly && activeThread && (
									<div
										data-testid="chat-readonly-banner"
										className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2"
									>
										<Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
										<span>
											This conversation lives in <b>{threadLabel(activeThread)}</b> on{' '}
											{channelDisplayName(activeThread.channel)}. Hezo replies there when mentioned
											- continue it by mentioning Hezo in the channel.
										</span>
									</div>
								)}
								{activeConverted && (
									<div
										data-testid="chat-converted-banner"
										className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2"
									>
										<SquareCheckBig
											aria-hidden
											className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3"
										/>
										<span>
											{convertedTask ? (
												<Trans
													k="chat.converted.banner"
													vars={{ task: <ConvertedTaskLink task={convertedTask} /> }}
												/>
											) : (
												t('chat.converted.bannerTaskGone')
											)}
										</span>
									</div>
								)}
								{activeClosed && !activeConverted && !activeReadOnly && (
									<div
										data-testid="chat-history-banner"
										className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2"
									>
										<History aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
										<span>{t('chat.history.banner')}</span>
									</div>
								)}
								{hasAnyChip && (
									<AttachmentChips
										attachments={visibleAttachments}
										uploading={uploading}
										errors={errors}
										onRemove={removeAttachment}
										projectId={room.kind === 'agent' ? room.projectSlug : hq?.slug}
										rowTestId="chat-attachment-row"
										chipTestId="chat-attachment-chip"
										previewTestId="chat-attachment-preview"
										errorTestId="chat-attachment-error"
									/>
								)}
								<div
									className={`flex items-end gap-1 rounded-2xl border border-border bg-surface px-1.5 py-1 transition-colors focus-within:border-border-strong ${
										composerLocked ? 'opacity-50' : ''
									}`}
								>
									<UploadButton
										onFiles={handleFiles}
										accept={ATTACHMENT_ACCEPT}
										iconOnly
										label="Attach files"
										data-testid="chat-attach"
									/>
									<textarea
										ref={inputRef}
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter' && !e.shiftKey) {
												e.preventDefault();
												submit(e.metaKey || e.ctrlKey);
											}
										}}
										rows={1}
										disabled={composerLocked}
										placeholder={
											activeConverted
												? t('chat.converted.composerPlaceholder', {
														identifier: convertedTask?.identifier ?? '',
													})
												: activeClosed && !activeReadOnly
													? t('chat.history.composerPlaceholder')
													: activeReadOnly
														? `Read-only - reply from ${channelDisplayName(activeThread?.channel ?? '')}`
														: busy
															? 'Queue your next message…'
															: room.kind === 'agent'
																? t('chat.composer.agentPlaceholder', { name: room.title })
																: 'Ask the CEO anything, across every project…'
										}
										data-testid="chat-input"
										className="max-h-32 min-h-[2.25rem] min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-[13px] leading-5 text-text-1 outline-none placeholder:text-text-3"
									/>
									<Tooltip content={buttonHint} side="top">
										<button
											type="button"
											{...longPress.handlers}
											disabled={!canSubmit}
											aria-label={buttonHint}
											data-testid="chat-send"
											data-mode={!busy ? 'send' : armed ? 'send-now' : 'queue'}
											className={`relative flex h-9 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
												busy && !armed
													? 'w-auto px-3 bg-purple-soft text-purple-soft-fg hover:bg-purple-soft/80'
													: busy
														? 'w-auto px-3 bg-accent-solid text-accent-solid-fg hover:bg-accent-hover'
														: 'w-9 bg-accent-solid text-accent-solid-fg hover:bg-accent-hover'
											}`}
										>
											{busy && !armed && longPress.pressing && (
												<span
													aria-hidden
													data-testid="chat-send-sweep"
													style={{ '--chat-hold-ms': `${LONG_PRESS_MS}ms` } as React.CSSProperties}
													className="chat-hold-sweep absolute inset-0 bg-accent-solid/25"
												/>
											)}
											<span className="relative flex items-center gap-1.5">
												{!busy ? (
													<ArrowRight className="h-4 w-4" />
												) : armed ? (
													<>
														<StepForward className="h-3.5 w-3.5" />
														Send now
													</>
												) : (
													<>
														<ListPlus className="h-3.5 w-3.5" />
														Queue
													</>
												)}
											</span>
										</button>
									</Tooltip>
								</div>
							</div>
						</FileDropZone>
					)}
				</div>
			</div>
		</>
	);
}

/** Human name of an external chat channel ("Telegram", "Slack", …). */
function channelDisplayName(channel: string): string {
	if (channel === 'telegram') return 'Telegram';
	if (channel === 'slack') return 'Slack';
	if (channel === 'discord') return 'Discord';
	if (channel === 'whatsapp') return 'WhatsApp';
	return channel;
}

/**
 * Short origin chip for a thread's home surface ("TG DM", "TG TOPIC",
 * "SLACK DM", "SLACK", …); null for web threads, which need no badge.
 */
function channelChip(t: ChatConversationSummary): string | null {
	if (t.channel === 'web') return null;
	if (t.kind === 'coworker') return t.channel.toUpperCase();
	const inTopic = t.external_thread_id?.includes(':') ?? false;
	if (t.channel === 'telegram') return inTopic ? 'TG TOPIC' : 'TG DM';
	return `${t.channel.toUpperCase()} DM`;
}

/**
 * Messages parked for the next turn, rendered at the tail of the thread exactly
 * where they will land. Dashed and violet: clearly the operator's own voice,
 * clearly not sent yet.
 */
function QueuedMessages({
	queue,
	onRemove,
}: {
	queue: readonly import('../../hooks/use-chat').QueuedChatMessage[];
	onRemove: (id: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5" data-testid="chat-queue">
			<span className="text-eyebrow self-end px-1 text-purple-soft-fg">
				Up next{' '}
				<span className="font-normal normal-case tracking-normal text-text-3">
					sends when the reply finishes
				</span>
			</span>
			{queue.map((m) => (
				<div key={m.id} className="flex items-center justify-end gap-1.5">
					<button
						type="button"
						onClick={() => onRemove(m.id)}
						aria-label={`Remove "${m.text}" from the queue`}
						data-testid="chat-queue-remove"
						className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-text-3 hover:border-border-strong hover:text-text-1"
					>
						<X className="h-3 w-3" />
					</button>
					<div
						data-testid="chat-queued-message"
						className="max-w-[80%] rounded-2xl rounded-br-sm border border-dashed border-purple-soft-fg bg-purple-soft px-3.5 py-2 text-sm leading-relaxed text-text-2 whitespace-pre-wrap"
					>
						{m.text}
						{m.attachments.length > 0 && (
							<span className="mt-1 block text-[11px] text-text-3">
								{m.attachments.length} file{m.attachments.length > 1 ? 's' : ''} attached
							</span>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

/** The small uppercase eyebrow above each bubble ("YOU" / "CEO · HQ"). */
function RoleLabel({ children }: { children: ReactNode }) {
	return <span className="text-eyebrow px-1 text-text-3">{children}</span>;
}

/**
 * The task link a converted thread points at — shared by the in-thread meta
 * message and the locked-composer banner.
 */
function ConvertedTaskLink({ task }: { task: ChatConvertedTaskRef }) {
	return (
		<Link
			to="/projects/$projectId/tasks/$taskId"
			params={{ projectId: task.project_slug, taskId: task.identifier.toLowerCase() }}
			data-testid="chat-converted-task-link"
			className="font-semibold text-info-soft-fg hover:underline"
		>
			{task.identifier}
		</Link>
	);
}

function MessageBubble({
	message,
	assistantLabel,
	assistantScope,
	projectSlug,
	convertedTask,
	toolActivity,
}: {
	message: ChatMessage;
	/** Who the replying agent is in this room ("CEO", or the agent's title). */
	assistantLabel: string;
	/** Where they work ("HQ", or the project name). */
	assistantScope: string;
	/** Project slug whose asset library holds this room's uploads. */
	projectSlug?: string;
	/** The thread's converted-task reference — renders the system meta message as a link. */
	convertedTask?: ChatConvertedTaskRef | null;
	/** Tool the in-flight reply is working with; only ever set on the streaming row. */
	toolActivity?: string | null;
}) {
	const isAssistant = message.role === 'assistant';
	const interrupted = message.status === ChatMessageStatus.Interrupted;
	const failed = message.status === ChatMessageStatus.Failed;
	const streaming = message.status === ChatMessageStatus.Streaming;

	// System rows are meta markers, not bubbles. Which marker is a property of
	// the MESSAGE, never of the thread.
	const rowStyle =
		message.role === 'system' && message.system_kind
			? SYSTEM_ROW_STYLE[message.system_kind]
			: undefined;
	if (rowStyle) {
		const Icon = rowStyle.icon;
		return (
			<div
				className={`flex items-start gap-2 rounded-md px-3 py-2 text-[11.5px] leading-relaxed ${rowStyle.className}`}
				data-testid="chat-message"
				data-role="system"
				data-system-kind={message.system_kind}
			>
				<Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span className="min-w-0">
					<RunLinkedText text={message.content} />
				</span>
			</div>
		);
	}

	// Marker rows: the converted-task pointer and the task breadcrumbs share the
	// centred pill idiom; a breadcrumb's own text names the task.
	if (message.role === 'system') {
		return (
			<div
				className="flex items-center gap-2 px-1 py-1 text-[11px] text-text-3"
				data-testid="chat-message"
				data-role="system"
				data-system-kind={message.system_kind ?? undefined}
			>
				<span className="h-px flex-1 bg-border" />
				<span className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-0.5">
					<SquareCheckBig className="h-3 w-3 shrink-0" aria-hidden="true" />
					{message.system_kind === ChatSystemMessageKind.ConvertedTask && convertedTask ? (
						<Trans
							k="chat.converted.metaMessage"
							vars={{ task: <ConvertedTaskLink task={convertedTask} /> }}
						/>
					) : (
						<span className="truncate">
							<RunLinkedText text={message.content} />
						</span>
					)}
				</span>
				<span className="h-px flex-1 bg-border" />
			</div>
		);
	}

	if (isAssistant) {
		if (streaming && message.content.length === 0) {
			return (
				<TypingIndicator label={`${assistantLabel} · ${assistantScope}`} tool={toolActivity} />
			);
		}
		return (
			<div
				className="group flex max-w-[90%] flex-col gap-1"
				data-testid="chat-message"
				data-role="ceo"
			>
				<RoleLabel>
					{assistantLabel} · {assistantScope}
				</RoleLabel>
				<div className="rounded-2xl rounded-bl-sm bg-surface-2 px-3.5 py-2.5 text-text-1">
					{message.content ? (
						<MarkdownProse testId="chat-markdown" instance>
							{message.content}
						</MarkdownProse>
					) : failed ? (
						<span className="text-[13px] leading-relaxed" data-testid="chat-failure">
							{message.error ? <RunLinkedText text={message.error} /> : 'Something went wrong.'}
						</span>
					) : null}
					{interrupted && <div className="mt-1 text-[11px] italic text-text-3">(interrupted)</div>}
				</div>
				{streaming && <StreamingDots label={assistantLabel} tool={toolActivity} />}
				{!streaming && message.content.length > 0 && (
					<MessageCopyButton text={message.content} align="start" />
				)}
			</div>
		);
	}

	return (
		<div
			className="group flex max-w-[90%] flex-col items-end gap-1 self-end"
			data-testid="chat-message"
			data-role="user"
		>
			<RoleLabel>You</RoleLabel>
			{message.content.length > 0 && (
				<div className="rounded-2xl rounded-br-sm bg-inverse px-3.5 py-2.5 text-sm leading-relaxed text-inverse-fg whitespace-pre-wrap wrap-anywhere">
					{message.content}
				</div>
			)}
			{message.attachments && message.attachments.length > 0 && (
				<SentAttachments attachments={message.attachments} projectSlug={projectSlug} />
			)}
			{message.content.length > 0 && <MessageCopyButton text={message.content} align="end" />}
		</div>
	);
}

const SENT_ATTACHMENT_ICON_CLASSES = 'h-3.5 w-3.5 shrink-0 text-text-3';

/**
 * Read-only linked chips for the files sent with a message, aligned under the
 * (right-aligned) user bubble. Each opens the in-app asset viewer (uploads land
 * in the room's project library); before the slug resolves the chip degrades to
 * the raw signed URL in a new tab.
 */
function SentAttachments({
	attachments,
	projectSlug,
}: {
	attachments: NonNullable<ChatMessage['attachments']>;
	projectSlug?: string;
}) {
	const chipClasses =
		'flex items-center gap-1.5 rounded-sm border border-border bg-surface-3 px-2 py-1 text-[12px] text-text-1 hover:underline';
	return (
		<div
			className="flex max-w-full flex-wrap justify-end gap-1.5"
			data-testid="chat-message-attachments"
		>
			{attachments.map((a) =>
				projectSlug ? (
					<Link
						key={a.id}
						to="/projects/$projectId/assets/view"
						params={{ projectId: projectSlug }}
						search={{ file: a.original_filename }}
						data-testid="chat-message-attachment"
						className={chipClasses}
					>
						<AssetIcon contentType={a.content_type} className={SENT_ATTACHMENT_ICON_CLASSES} />
						<span className="max-w-[160px] truncate">{assetBasename(a.original_filename)}</span>
					</Link>
				) : (
					<a
						key={a.id}
						href={a.url}
						target="_blank"
						rel="noopener noreferrer"
						data-testid="chat-message-attachment"
						className={chipClasses}
					>
						<AssetIcon contentType={a.content_type} className={SENT_ATTACHMENT_ICON_CLASSES} />
						<span className="max-w-[160px] truncate">{assetBasename(a.original_filename)}</span>
						<ExternalLink className="h-3 w-3 shrink-0 text-text-3" />
					</a>
				),
			)}
		</div>
	);
}

/**
 * A mini copy affordance for a single message, fading in when its bubble is
 * hovered (or the button is focused).
 */
function MessageCopyButton({ text, align }: { text: string; align: 'start' | 'end' }) {
	const { copied, copy } = useCopyFeedback();

	const handleCopy = async () => {
		await copy(text);
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			aria-label={copied ? 'Message copied' : 'Copy message'}
			data-testid="chat-message-copy"
			className={`${align === 'end' ? 'self-end' : 'self-start'} flex h-6 w-6 items-center justify-center rounded-md text-text-3 opacity-100 transition-opacity hover:bg-surface-2 hover:text-text-1 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100`}
		>
			{copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
		</button>
	);
}

/** Three pulsing dots — the agent's resting "thinking" / "still typing" animation. */
function Dots() {
	return (
		<span className="flex items-center gap-1.5" aria-hidden>
			<span className="h-1.5 w-1.5 rounded-full bg-text-3 animate-pulse" />
			<span className="h-1.5 w-1.5 rounded-full bg-text-3 animate-pulse [animation-delay:150ms]" />
			<span className="h-1.5 w-1.5 rounded-full bg-text-3 animate-pulse [animation-delay:300ms]" />
		</span>
	);
}

/**
 * The tool the reply is working with right now, beside the dots.
 */
function ToolActivity({ tool }: { tool: string }) {
	const { t } = useI18n();
	return (
		<span className="truncate text-[11px] text-text-3" data-testid="chat-tool-activity">
			{t('chat.toolActivity', { tool: displayToolName(tool) })}
		</span>
	);
}

/**
 * The agent has begun a reply but produced no text yet — the label + bare dots
 * stand in for the (otherwise empty) bubble until the first tokens land.
 */
function TypingIndicator({ label, tool }: { label: string; tool?: string | null }) {
	return (
		<div
			className="flex max-w-[90%] flex-col gap-1.5"
			data-testid="chat-typing"
			role="status"
			aria-label={`${label} is typing`}
		>
			<RoleLabel>{label}</RoleLabel>
			<span className="flex min-w-0 items-center gap-2 px-1">
				<Dots />
				{tool && <ToolActivity tool={tool} />}
			</span>
		</div>
	);
}

/**
 * Dots pinned just below an in-flight reply bubble — signals the agent is still
 * working after the first tokens have already landed.
 */
function StreamingDots({ label, tool }: { label: string; tool?: string | null }) {
	return (
		<span
			className="flex min-w-0 items-center gap-2 px-1 pt-0.5"
			data-testid="chat-streaming-dots"
			role="status"
			aria-label={`${label} is still typing`}
		>
			<Dots />
			{tool && <ToolActivity tool={tool} />}
		</span>
	);
}
