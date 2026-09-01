import {
	assetBasename,
	ChatMessageStatus,
	ChatSystemMessageKind,
	displayToolName,
	extractActiveAgentMentionSlugs,
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
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ChatLaunch } from '../../contexts/chat-launch-context';
import { useAutoGrowTextarea } from '../../hooks/use-auto-grow-textarea';
import {
	type ChatConversationSummary,
	type ChatConvertedTaskRef,
	type ChatMessage,
	type ChatRoom,
	useChat,
} from '../../hooks/use-chat';
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
import { MarkdownProse } from '../markdown-prose';
import { RunLinkedText } from '../run-linked-text';
import { Tooltip } from '../ui/tooltip';
import { ConvertMessageDialog } from './convert-message-dialog';

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

/** What the surface reports to a wrapping header (the dock's chrome). */
export interface ChatSurfaceHeaderCtx {
	streaming: boolean;
	/** Messages parked for the next turn. */
	queued: number;
	/** Copy the whole transcript; `copied` flips for 2s on success. */
	copyConversation: () => void;
	copied: boolean;
	canCopy: boolean;
}

interface ChatSurfaceProps {
	/** The room this surface shows. Room *selection* is the parent's business. */
	room: ChatRoom;
	/** Whether the surface is on screen — gates the history query and listeners. */
	active: boolean;
	/**
	 * A launch request's composer side: put the draft text in the composer and
	 * focus it. Applied once per nonce. Selecting the room is the parent's move.
	 */
	launch?: ChatLaunch | null;
	/** The active thread's summary when `room` is a thread — drives the
	 *  read-only / converted / History banners and composer lock. */
	thread?: ChatConversationSummary;
	/** Chrome above the thread (the dock's title row), fed the live status. */
	header?: (ctx: ChatSurfaceHeaderCtx) => ReactNode;
	/** Chrome between the header and the messages (the dock's room switcher). */
	beforeMessages?: ReactNode;
	/**
	 * Replaces the default empty-state line (a fresh conversation). Receives
	 * `send` so starter chips can post their text as the first message.
	 */
	emptyState?: (send: (text: string) => Promise<unknown>) => ReactNode;
}

/**
 * One chat room: history, streaming replies, queue, attachments and the
 * composer. The dock wraps it in its panel chrome; the fresh-instance landing
 * renders it full-pane. All state lives here so both presentations behave
 * identically; only room selection and panel chrome differ.
 */
export function ChatSurface({
	room,
	active,
	launch = null,
	thread,
	header,
	beforeMessages,
	emptyState,
}: ChatSurfaceProps) {
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
		participants,
		pendingTurns,
		cancelPendingTurn,
		groupNudge,
		conversationId,
	} = useChat(active, room);
	const { t } = useI18n();
	// The room's own project scopes labels and uploads; the CEO scope is HQ.
	const isProjectRoom = room.kind === 'agent' || room.kind === 'group';
	const roomProjectSlug = isProjectRoom ? room.projectSlug : null;
	const roomProjectMeta = useProjectMeta(roomProjectSlug ?? '');
	const hq = useHqProject();
	const [draft, setDraft] = useState('');
	const [copied, setCopied] = useState(false);
	const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
	// The message the operator is converting into a task, while the dialog is up.
	const [convertMessage, setConvertMessage] = useState<ChatMessage | null>(null);
	const uploadAttachment = useUploadChatAttachment(roomProjectSlug);
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
	// Pin to the latest message as it streams in, and re-pin whenever the scroll
	// box resizes. A reflow that changes its size does not move scrollTop, so the
	// newest message can silently drop below the fold while still mounted.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberate scroll-to-bottom triggers
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const pin = () => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
		pin();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(pin);
		observer.observe(el);
		return () => observer.disconnect();
	}, [lastId, lastLen, streaming, active]);

	// Apply a launch request's composer side. An empty launch draft (a room card
	// click) only opens the room - it never wipes text already in the composer.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one application per launch request
	useEffect(() => {
		if (!launch) return;
		if (launch.draft) setDraft(launch.draft);
		const id = requestAnimationFrame(() => {
			const el = inputRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
		return () => cancelAnimationFrame(id);
	}, [launch?.nonce]);

	useAutoGrowTextarea(inputRef, [draft, active]);

	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const activeReadOnly = thread?.kind === 'coworker';
	const activeConverted = thread?.converted_task_id != null;
	const activeClosed = thread?.closed_at != null;
	const convertedTask = thread?.converted_task ?? null;
	const threadTitle = thread?.title?.trim() || t('chat.thread.untitled');

	// Who the replying agent is, for the bubbles and the transcript labels. A
	// group room labels each reply by its own author instead (see labelFor).
	const assistantLabel = room.kind === 'agent' ? room.title : 'CEO';
	const assistantScope = isProjectRoom
		? (roomProjectMeta?.name ?? room.projectSlug)
		: HQ_PROJECT_NAME;
	// Group author lookup: the live roster first, then the label stored on the
	// message (an agent since removed keeps the name the room saw).
	const participantByMember = new Map(participants.map((p) => [p.member_id, p]));
	const labelFor = (m: ChatMessage): string => {
		if (room.kind !== 'group') return assistantLabel;
		const p = m.author_member_id ? participantByMember.get(m.author_member_id) : undefined;
		return p ? p.display_name || p.title : (m.author_label ?? t('chat.group.formerMember'));
	};

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
		if (!active) return;
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
	}, [active]);

	const coarsePointer = useMediaQuery('(pointer: coarse)');
	const armed = canInterrupt && canSubmit && (longPress.armed || modifierHeld);
	const buttonHint = !busy
		? 'Send message'
		: armed
			? 'Send now - stops the current reply'
			: !canInterrupt
				? t('chat.composer.queueHint')
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

	// "Ask @x" handoff chips: teammates the latest group reply named. A chip
	// only prefills the composer with the mention — the operator confirms by
	// sending, which is what keeps handoffs loop-safe.
	const tailAuthorSlug =
		tail?.author_member_id != null
			? participantByMember.get(tail.author_member_id)?.slug
			: undefined;
	const askChips =
		room.kind === 'group' &&
		!busy &&
		pendingTurns.length === 0 &&
		tail?.role === 'assistant' &&
		tail.status === ChatMessageStatus.Complete
			? extractActiveAgentMentionSlugs(tail.content).filter(
					(slug) => slug !== tailAuthorSlug && participants.some((p) => p.slug === slug),
				)
			: [];
	const askTeammate = (slug: string) => {
		setDraft((prev) => (prev.trim() === '' ? `@${slug} ` : `${prev} @${slug} `));
		inputRef.current?.focus();
	};

	// Copy the whole conversation as plain text, each turn labelled by speaker.
	const copyConversation = async () => {
		const transcript = messages
			.filter((m) => m.content.trim().length > 0)
			.map((m) => {
				const speaker =
					m.role === 'assistant'
						? `${labelFor(m)} · ${assistantScope}`
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

	const sendText = (text: string) => send(text);

	return (
		<>
			{header?.({
				streaming,
				queued: queue.length,
				copyConversation,
				copied,
				canCopy: messages.length > 0,
			})}

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{beforeMessages}

				{/* No container gate here for any room kind: a CEO turn claims a pool
				    container per exec exactly like a DM's, so capacity and container
				    states surface as system rows in the thread instead. */}
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
						{loaded &&
							messages.length === 0 &&
							compactedCount === 0 &&
							(emptyState ? (
								emptyState(sendText)
							) : (
								<p className="px-1 py-6 text-center text-[13px] text-text-2">
									{room.kind === 'agent'
										? t('chat.empty.agent', { name: room.title })
										: room.kind === 'group'
											? t('chat.empty.group')
											: t('chat.empty.ceo')}
								</p>
							))}
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
								assistantLabel={labelFor(m)}
								assistantScope={assistantScope}
								projectSlug={roomProjectSlug ?? hq?.slug}
								convertedTask={convertedTask}
								toolActivity={toolActivity}
								onConvert={
									!composerLocked &&
									m.role !== 'system' &&
									m.status === ChatMessageStatus.Complete &&
									m.content.trim().length > 0
										? () => setConvertMessage(m)
										: undefined
								}
							/>
						))}
						{room.kind === 'group' && pendingTurns.length > 0 && (
							<PendingTurnsStrip pending={pendingTurns} onCancel={cancelPendingTurn} />
						)}
						{room.kind === 'group' && groupNudge && pendingTurns.length === 0 && (
							<div
								data-testid="chat-group-nudge"
								className="flex items-center gap-2 px-1 py-1 text-[11px] text-text-3"
							>
								<span className="h-px flex-1 bg-border" />
								<span className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface-2 px-2.5 py-0.5">
									{t('chat.group.nudge')}
								</span>
								<span className="h-px flex-1 bg-border" />
							</div>
						)}
						{askChips.length > 0 && (
							<div className="flex flex-wrap justify-end gap-1.5" data-testid="chat-ask-chips">
								{askChips.map((slug) => (
									<button
										key={slug}
										type="button"
										data-testid="chat-ask-chip"
										onClick={() => askTeammate(slug)}
										className="rounded-full border border-border px-3 py-1.5 text-[12px] text-text-2 hover:border-border-strong hover:text-text-1 transition-colors"
									>
										{t('chat.group.ask', { slug: `@${slug}` })}
									</button>
								))}
							</div>
						)}
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
						{activeReadOnly && thread && (
							<div
								data-testid="chat-readonly-banner"
								className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2"
							>
								<Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
								<span>
									This conversation lives in <b>{threadTitle}</b> on{' '}
									{channelDisplayName(thread.channel)}. Hezo replies there when mentioned - continue
									it by mentioning Hezo in the channel.
								</span>
							</div>
						)}
						{activeConverted && (
							<div
								data-testid="chat-converted-banner"
								className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2"
							>
								<SquareCheckBig aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
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
								projectId={roomProjectSlug ?? hq?.slug}
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
												? `Read-only - reply from ${channelDisplayName(thread?.channel ?? '')}`
												: busy
													? 'Queue your next message…'
													: room.kind === 'agent'
														? t('chat.composer.agentPlaceholder', { name: room.title })
														: room.kind === 'group'
															? t('chat.composer.groupPlaceholder')
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
			</div>

			{convertMessage && (
				<ConvertMessageDialog
					room={room}
					conversationId={room.kind === 'group' ? room.conversationId : (conversationId ?? null)}
					message={convertMessage}
					participants={participants}
					onClose={() => setConvertMessage(null)}
				/>
			)}
		</>
	);
}

/**
 * The replies still queued behind the latest group message: one cancellable
 * chip per agent, in the order they will speak. Server state, mirrored from
 * the pending-turns broadcasts — cancelling asks the server and the strip
 * updates when the queue actually changes.
 */
function PendingTurnsStrip({
	pending,
	onCancel,
}: {
	pending: readonly import('../../hooks/use-chat').GroupPendingTurn[];
	onCancel: (memberId: string) => void;
}) {
	const { t } = useI18n();
	return (
		<div className="flex flex-col gap-1.5" data-testid="chat-pending-turns">
			<span className="text-eyebrow px-1 text-text-3">{t('chat.group.pendingLabel')}</span>
			<div className="flex flex-wrap gap-1.5">
				{pending.map((turn) => (
					<span
						key={turn.memberId}
						data-testid="chat-pending-turn"
						className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[12px] text-text-2"
					>
						<Dots />
						{turn.label}
						<button
							type="button"
							onClick={() => onCancel(turn.memberId)}
							aria-label={t('chat.group.cancelTurn', { name: turn.label })}
							data-testid="chat-pending-turn-cancel"
							className="flex h-4 w-4 items-center justify-center rounded-full text-text-3 hover:text-text-1"
						>
							<X className="h-3 w-3" />
						</button>
					</span>
				))}
			</div>
		</div>
	);
}

/** Human name of an external chat channel ("Telegram", "Slack", …). */
export function channelDisplayName(channel: string): string {
	if (channel === 'telegram') return 'Telegram';
	if (channel === 'slack') return 'Slack';
	if (channel === 'discord') return 'Discord';
	if (channel === 'whatsapp') return 'WhatsApp';
	return channel;
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
	const { t } = useI18n();
	return (
		<div className="flex flex-col gap-1.5" data-testid="chat-queue">
			<span className="text-eyebrow self-end px-1 text-purple-soft-fg">
				{t('chat.queue.upNext')}{' '}
				<span className="font-normal normal-case tracking-normal text-text-3">
					{t('chat.queue.hint')}
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
	onConvert,
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
	/** Opens the convert-to-task dialog for this message; absent when it cannot convert. */
	onConvert?: () => void;
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
					<span className="flex items-center gap-0.5 self-start">
						<MessageCopyButton text={message.content} align="start" />
						{onConvert && <MessageConvertButton onConvert={onConvert} />}
					</span>
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
			{message.content.length > 0 && (
				<span className="flex items-center gap-0.5 self-end">
					{onConvert && <MessageConvertButton onConvert={onConvert} />}
					<MessageCopyButton text={message.content} align="end" />
				</span>
			)}
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
 * The per-message convert affordance, beside the copy button: one message
 * becomes one task, and the conversation survives. The dialog does the rest.
 */
function MessageConvertButton({ onConvert }: { onConvert: () => void }) {
	const { t } = useI18n();
	return (
		<Tooltip content={t('chat.convert.action')} side="top">
			<button
				type="button"
				onClick={onConvert}
				aria-label={t('chat.convert.action')}
				data-testid="chat-message-convert"
				className="flex h-6 w-6 items-center justify-center rounded-md text-text-3 opacity-100 transition-opacity hover:bg-surface-2 hover:text-text-1 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 group-hover:opacity-100"
			>
				<SquareCheckBig className="h-3 w-3" />
			</button>
		</Tooltip>
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
export function Dots() {
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
	const { t } = useI18n();
	return (
		<div
			className="flex max-w-[90%] flex-col gap-1.5"
			data-testid="chat-typing"
			role="status"
			aria-label={t('chat.typing', { name: label })}
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
	const { t } = useI18n();
	return (
		<span
			className="flex min-w-0 items-center gap-2 px-1 pt-0.5"
			data-testid="chat-streaming-dots"
			role="status"
			aria-label={t('chat.stillTyping', { name: label })}
		>
			<Dots />
			{tool && <ToolActivity tool={tool} />}
		</span>
	);
}
