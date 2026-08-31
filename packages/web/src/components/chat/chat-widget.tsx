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
	Maximize2,
	MessageSquare,
	Minimize2,
	Plus,
	SquareCheckBig,
	StepForward,
	TriangleAlert,
	X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { ChatLaunch } from '../../contexts/chat-launch-context';
import { useAutoGrowTextarea } from '../../hooks/use-auto-grow-textarea';
import {
	type ChatConversationSummary,
	type ChatConvertedTaskRef,
	type ChatMessage,
	type QueuedChatMessage,
	readStoredThreadId,
	useChat,
	useChatConversations,
	writeStoredThreadId,
} from '../../hooks/use-chat';
import { useCloseOnRouteChange } from '../../hooks/use-close-on-route-change';
import { useContainerHealth } from '../../hooks/use-container-health';
import { useCopyFeedback } from '../../hooks/use-copy-feedback';
import { useDraggableFab } from '../../hooks/use-draggable-fab';
import { useFileAttachments } from '../../hooks/use-file-attachments';
import { LONG_PRESS_MS, useLongPress } from '../../hooks/use-long-press';
import { useMediaQuery } from '../../hooks/use-media-query';
import { useHqProject } from '../../hooks/use-projects';
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
import { CountOverlayBadge } from '../ui/count-overlay-badge';
import { Tooltip } from '../ui/tooltip';
import { ConvertToTaskDialog } from './convert-to-task-dialog';

/**
 * System-message kinds rendered as a full-sentence row rather than a marker,
 * and how each row looks: a warning is amber, a notice is quiet. Any kind not
 * listed here is the converted-task marker.
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
};

/**
 * Floating chat with the CEO, pinned bottom-right (on portrait mobile screens
 * the launcher can be dragged elsewhere). Talks to the single global CEO
 * conversation; messages stream in over the `chat:global` WebSocket room. The CEO
 * is the instance-level singleton living in the HQ team, so every reply is
 * labelled `CEO · HQ`.
 *
 * The composer stays usable while a reply streams, and the send button is the
 * only thing that changes to say what will happen — no banner above the input:
 *
 * - **Queue** (the default, and what Enter or a tap does): the message parks as a
 *   dashed bubble and can be pulled back out until the queue flushes. The whole
 *   queue then posts as ONE turn, so a single reply answers all of it.
 * - **Send now** (deliberate: hold the button, or ⌘/Ctrl+Enter): posts straight
 *   away, which server-side aborts the in-flight reply and starts a fresh turn.
 *   Only offered while a reply is actually running — before that there is
 *   nothing to interrupt, so holding does nothing and pressing queues.
 */
interface ChatWidgetProps {
	/** Open state is lifted to the shell so sibling surfaces (the floating
	 *  new-task button) can react to the chat being open. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * A route asking for a specific thread with a prefilled composer (see
	 * `ChatLaunchContext`). Applied once per `nonce`, never sent.
	 */
	launch?: ChatLaunch | null;
}

export function ChatWidget({ open, onOpenChange, launch = null }: ChatWidgetProps) {
	const setOpen = onOpenChange;
	const [expanded, setExpanded] = useState(false);
	// Draggable launcher on portrait mobile screens (the panel itself never
	// moves). Must be called before the `if (!open)` early return below.
	const fab = useDraggableFab('chat');
	// The selected thread (undefined = the default web thread). The switcher lets the
	// operator create/switch/close parallel conversation threads. Seeded from the
	// last thread they switched to, so reopening the chat resumes it rather than
	// jumping back to the default thread.
	const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>(
		readStoredThreadId,
	);
	const {
		messages,
		send,
		streaming,
		sending,
		loaded,
		unread,
		compactedCount,
		queue,
		enqueue,
		dequeue,
		toolActivity,
		conversationId: activeConversationId,
	} = useChat(open, selectedConversationId);
	const {
		conversations,
		loaded: threadsLoaded,
		createThread,
		closeThread,
		convertThread,
		converting,
	} = useChatConversations(open);
	const { t } = useI18n();
	// Convert-to-task dialog visibility (header action, assistant web threads only).
	const [convertOpen, setConvertOpen] = useState(false);
	// The one writer for the thread selection — dropdown, rail, new thread, and the
	// fall-back-to-default paths all go through it, so what's rendered and what's
	// remembered can never drift. `undefined` (back to the server's default web
	// thread) clears the memory rather than pinning the default's id, keeping the
	// untouched-switcher case behaving exactly as it did before.
	const selectThread = useCallback((id: string | undefined) => {
		setSelectedConversationId(id);
		writeStoredThreadId(id);
	}, []);
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// A stopped HQ container is no blocker — sending a message lazy-starts it.
	// Only genuine errors and in-flight transitions (provisioning/rebuilding)
	// swap the chat body for the container state + a link to fix it.
	const blockedHealth =
		hqHealth && hqHealth.kind !== 'healthy' && hqHealth.kind !== 'stopped' ? hqHealth : null;
	const [draft, setDraft] = useState('');
	const [copied, setCopied] = useState(false);
	// Files staged for the next message; the reusable attachment kit owns the
	// upload lifecycle and resolves ids → metadata (chips).
	const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
	const uploadAttachment = useUploadChatAttachment();
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
	// Pin to the latest message as it streams in, and re-pin whenever the panel
	// resizes (expand/collapse). A size change reflows the scroll area without
	// moving scrollTop, so without `expanded` here the newest message silently
	// drops below the fold on collapse even though it's still mounted.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberate scroll-to-bottom triggers
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const pin = () => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
		pin();
		// Collapsing can add a scrollbar after the first layout, narrowing message
		// bubbles and growing the list. Re-pin when the scroll box reaches its final
		// size instead of guessing how many animation frames the reflow needs.
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(pin);
		observer.observe(el);
		return () => observer.disconnect();
	}, [lastId, lastLen, streaming, open, expanded]);

	// A thread just created by a launch request. The thread list is cached, so on a
	// second open it can report "loaded" from data that predates this thread — which
	// the stale-selection effect below would read as a closed thread and drop. Held
	// until the refetch actually lists it, then cleared so closing it later still
	// drops correctly.
	const launchedThreadRef = useRef<string | null>(null);

	// Apply a launch request: show its thread and put its text in the composer.
	// Keyed on the nonce so the same request re-applies, and deliberately stopping
	// short of sending - see `ChatLaunchContext` for why.
	// biome-ignore lint/correctness/useExhaustiveDependencies: one application per launch request
	useEffect(() => {
		if (!launch) return;
		launchedThreadRef.current = launch.conversationId;
		selectThread(launch.conversationId);
		setDraft(launch.draft);
		// Focus after the panel has painted, cursor at the end so typing continues
		// the sentence rather than replacing it.
		const id = requestAnimationFrame(() => {
			const el = inputRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
		return () => cancelAnimationFrame(id);
	}, [launch?.nonce]);

	// A remembered thread can be closed later (from the ✕ here, another tab, or its
	// own platform), and the server still serves a closed thread's history by id —
	// so a stale id would restore as a thread that reads fine but rejects every
	// send. Once the thread list has loaded, a selection it doesn't list is dropped
	// back to the default thread.
	useEffect(() => {
		if (!open || !threadsLoaded || !selectedConversationId) return;
		if (conversations.some((t) => t.id === selectedConversationId)) {
			if (launchedThreadRef.current === selectedConversationId) launchedThreadRef.current = null;
			return;
		}
		// A just-launched thread is real even when this list has not caught up yet.
		if (launchedThreadRef.current === selectedConversationId) return;
		selectThread(undefined);
	}, [open, threadsLoaded, selectedConversationId, conversations, selectThread]);

	// Escape closes the chat from any open state (anchored or the expanded modal).
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [open, setOpen]);

	// Navigating away only strands the reader in the BLOCKING presentations: the
	// mobile full-screen panel and the desktop expanded view, both of which carry
	// the backdrop below. The anchored desktop corner panel is a deliberately
	// persistent companion — it doesn't cover the page, and it is meant to survive
	// navigation — so it is excluded. Expanding is a view mode rather than a
	// session, so desktop collapses back to anchored instead of closing, keeping
	// the thread up while the page is unblocked. (`md` matches the backdrop's
	// `md:hidden`.)
	const isDesktop = useMediaQuery('(min-width: 768px)');
	useCloseOnRouteChange(open && (!isDesktop || expanded), () => {
		if (isDesktop) setExpanded(false);
		else setOpen(false);
	});

	// Grow the composer with its content (capped by `max-h-32`, then it scrolls),
	// and collapse it back to a single row when the draft is cleared on submit.
	// `open` re-measures when the panel (re)mounts so a draft kept across a
	// close/open is sized correctly rather than clipped to a single row.
	useAutoGrowTextarea(inputRef, [draft, open]);

	// Clear the "copied" reset timer on unmount so it can't fire into a gone component.
	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	// The web view is the hub: it lists every thread from every surface. Assistant
	// threads (web + app DMs/topics) are interactive; coworker (team-channel)
	// threads are read-only here — their write surface is the channel itself.
	const assistantThreads = conversations.filter((t) => t.kind !== 'coworker');
	const coworkerThreads = conversations.filter((t) => t.kind === 'coworker');
	const activeThread = conversations.find((t) => t.id === activeConversationId);
	const activeReadOnly = activeThread?.kind === 'coworker';
	// A converted thread stays listed as a read-only record; its meta message and
	// banner link the task that continues it.
	const activeConverted = activeThread?.converted_task_id != null;
	const convertedTask = activeThread?.converted_task ?? null;
	// Convert is offered on interactive web threads with something to convert.
	// Disabled (not hidden) while a reply streams — converting would abort it.
	const canConvert =
		!!activeThread &&
		activeThread.kind !== 'coworker' &&
		activeThread.channel === 'web' &&
		!activeConverted &&
		!activeThread.closed_at &&
		messages.length > 0;
	// Untitled threads render as "New thread" until the CEO auto-titles them from the
	// conversation; there is no special "Main" default anymore.
	const threadLabel = (t: (typeof conversations)[number]) => t.title?.trim() || 'New thread';
	// Resolved outside the thread-map callbacks, whose `(t)` params shadow i18n's `t`.
	const convertedBadgeLabel = t('chat.converted.badge');

	// The thread is busy from the moment a send leaves until its reply settles.
	// `canInterrupt` narrows that to a reply that is actually running: during
	// `sending` the turn hasn't started server-side yet, so there is nothing to
	// abort and the only honest option is to queue.
	const busy = sending || streaming;
	const canInterrupt = streaming && !sending;
	const hasContent = draft.trim().length > 0 || visibleAttachments.length > 0;
	// Coworker threads write in their channel; converted threads continue on
	// their task. Both lock the composer here.
	const composerLocked = activeReadOnly || activeConverted;
	const canSubmit = !composerLocked && hasContent && uploading.length === 0;

	/**
	 * Commit the draft. `sendNow` is the deliberate interrupt (button held, or
	 * ⌘/Ctrl+Enter); everything else queues while the thread is busy. A `sendNow`
	 * that arrives before the turn has started still queues — see `canInterrupt`.
	 */
	const submit = (sendNow = false) => {
		// A message needs text or at least one attachment; files still uploading
		// block. Coworker (team-channel) threads are read-only here — never send.
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

	// Holding the button arms the interrupt; `armed` flips at the threshold so the
	// button can say what a release will do before the finger lifts.
	const longPress = useLongPress({
		onPress: () => submit(false),
		onLongPress: () => submit(true),
		enabled: canInterrupt && canSubmit,
	});
	// ⌘/Ctrl is the keyboard route to the same armed state, tracked globally so the
	// button morphs on the modifier alone — the consequence is visible before Enter.
	const [modifierHeld, setModifierHeld] = useState(false);
	useEffect(() => {
		if (!open) return;
		const isModifier = (e: KeyboardEvent) => e.key === 'Meta' || e.key === 'Control';
		const onDown = (e: KeyboardEvent) => isModifier(e) && setModifierHeld(true);
		const onUp = (e: KeyboardEvent) => isModifier(e) && setModifierHeld(false);
		// Tabbing away can swallow the keyup, which would strand the button armed.
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

	// Touch has no modifier key, so the tooltip teaches the gesture instead of a shortcut.
	const coarsePointer = useMediaQuery('(pointer: coarse)');
	const armed = canInterrupt && canSubmit && (longPress.armed || modifierHeld);
	const buttonHint = !busy
		? 'Send message'
		: armed
			? 'Send now - stops the current reply'
			: !canInterrupt
				? 'Queue - sends when the CEO is ready'
				: coarsePointer
					? 'Queue - hold to send now'
					: 'Queue (Enter) - hold, or Cmd/Ctrl Enter, to send now';

	const handleNewThread = async () => {
		const res = (await createThread().catch(() => null)) as {
			conversation?: { id: string };
		} | null;
		if (res?.conversation?.id) selectThread(res.conversation.id);
	};
	// Close a thread (defaults to the active one). If it was the active thread, fall
	// back to the default web thread afterwards.
	const handleCloseThread = async (id?: string) => {
		const target = id ?? activeConversationId;
		if (!target) return;
		await closeThread(target).catch(() => undefined);
		if (target === activeConversationId) selectThread(undefined);
	};

	// Copy the whole conversation as plain text, each turn labelled by speaker.
	const copyConversation = async () => {
		const transcript = messages
			.filter((m) => m.content.trim().length > 0)
			.map((m) => {
				const speaker =
					m.role === 'assistant'
						? `CEO · ${HQ_PROJECT_NAME}`
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

	if (!open) {
		return (
			<Tooltip content="Chat with CEO" side="left">
				<button
					ref={fab.ref}
					type="button"
					onClick={() => setOpen(true)}
					{...fab.handlers}
					style={fab.style}
					data-testid="chat-launcher"
					aria-label={unread > 0 ? `Chat with the CEO (${unread} unread)` : 'Chat with the CEO'}
					className="fixed bottom-4 right-4 z-50 flex h-12 w-12 touch-none items-center justify-center rounded-full bg-inverse text-inverse-fg shadow-lg hover:opacity-90"
				>
					<MessageSquare className="h-5 w-5" />
					{/* Unread CEO replies overlay the launcher, mirroring the inbox icon. */}
					<CountOverlayBadge count={unread} testId="chat-unread-badge" />
				</button>
			</Tooltip>
		);
	}

	// `top-16` (64px) keeps both layouts clear of the 48px app header. The default
	// is an anchored corner panel on desktop; expanded fills the viewport below the
	// nav bar (full-width with a small margin), never covering the header.
	const sizeClass = expanded
		? 'inset-x-2 bottom-2 top-16 md:inset-x-4 md:bottom-4 md:top-16'
		: 'inset-x-2 bottom-2 top-16 md:inset-auto md:bottom-4 md:right-4 md:top-auto md:h-[560px] md:w-[420px]';

	return (
		<>
			{/* Modal scrim behind the panel: a dark translucent layer dims and occludes
			    the page content below the nav bar (the header stays clear and usable,
			    matching the panel's own top-12 boundary), so the panel reads clearly
			    against the page. It always shows on mobile (where the panel floats over
			    the page with margins around it) and, on desktop, only in expanded mode -
			    the anchored corner panel doesn't need one. Clicking it dismisses the chat. */}
			<button
				type="button"
				aria-label="Close chat"
				data-testid="chat-overlay"
				onClick={() => setOpen(false)}
				className={`fixed inset-x-0 bottom-0 top-12 z-40 bg-[var(--overlay)] cursor-default ${
					expanded ? '' : 'md:hidden'
				}`}
			/>
			<div
				data-testid="chat-panel"
				data-expanded={expanded}
				className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl ${sizeClass}`}
			>
				<header className="flex items-center justify-between border-b border-border px-4 py-3">
					<div className="flex items-center gap-2">
						<span className="text-sm font-semibold text-text-1">CEO</span>
						<span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">
							{HQ_PROJECT_NAME}
						</span>
						{/* Mirror the in-thread typing dots up here so the "CEO is working"
						    signal stays visible even when the latest reply is scrolled out of
						    view. Decorative only - the in-thread indicator carries the aria
						    live-region announcement, so this stays aria-hidden to avoid a
						    duplicate read. */}
						{streaming && (
							<span data-testid="chat-header-dots" className="pl-0.5">
								<Dots />
							</span>
						)}
						{/* Parked messages live at the bottom of the thread, so the count rides
						    up here to survive scrolling away from them. */}
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
						{/* Convert this conversation into a task (assistant web threads only).
						    Disabled while a reply streams - converting aborts the in-flight
						    turn, so the honest affordance is to wait it out. */}
						{canConvert && (
							<Tooltip content={t('chat.convert.action')} side="bottom">
								<button
									type="button"
									onClick={() => setConvertOpen(true)}
									disabled={busy}
									aria-label={t('chat.convert.action')}
									data-testid="chat-convert"
									className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1 disabled:pointer-events-none disabled:opacity-40"
								>
									<SquareCheckBig className="h-4 w-4" />
								</button>
							</Tooltip>
						)}
						{/* Copy the full transcript to the clipboard. Disabled until there's
					    something to copy; the icon flips to a check for 2s on success. */}
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
						{/* Expand/collapse is desktop-only; the panel is already near-full-screen
					    on mobile, where the toggle would be a no-op. */}
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							aria-label={expanded ? 'Collapse chat' : 'Expand chat'}
							data-testid="chat-expand"
							className="hidden h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1 md:flex"
						>
							{expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
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

				{/* Body: on desktop-expanded the thread switcher becomes a left rail
				    alongside the conversation column; otherwise it's a single column with
				    the top dropdown switcher. */}
				<div className={`flex min-h-0 flex-1 ${expanded ? 'flex-col md:flex-row' : 'flex-col'}`}>
					{/* Expanded desktop only: threads as a left sidebar (mobile/collapsed keep
					    the dropdown below). */}
					{expanded && (
						<aside
							data-testid="chat-thread-rail"
							className="hidden w-60 shrink-0 flex-col border-r border-border md:flex"
						>
							<div className="flex items-center justify-between px-3 pb-2 pt-3">
								<span className="text-eyebrow text-text-3">Your chats</span>
								<button
									type="button"
									onClick={handleNewThread}
									aria-label="New thread"
									data-testid="chat-thread-new-rail"
									className="flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
								>
									<Plus className="h-4 w-4" />
								</button>
							</div>
							<div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
								{assistantThreads.length === 0 && (
									<span className="px-2.5 py-2 text-[13px] italic text-text-3">New thread</span>
								)}
								{assistantThreads.map((t) => {
									const isActive = t.id === activeConversationId;
									const chip = channelChip(t);
									return (
										<div
											key={t.id}
											data-testid="chat-thread-row"
											data-active={isActive}
											className={`group/thread flex items-center gap-1 rounded-lg pl-2.5 pr-1 py-1.5 text-[13px] ${
												isActive
													? 'bg-surface-2 font-medium text-text-1'
													: 'text-text-2 hover:bg-surface-2 hover:text-text-1'
											}`}
										>
											<button
												type="button"
												onClick={() => selectThread(t.id)}
												className="flex min-w-0 flex-1 items-center gap-1 truncate text-left"
											>
												<span className="truncate">{threadLabel(t)}</span>
												{/* Converted marker as a suffix to the name, mirroring the
												    coworker Lock idiom. */}
												{t.converted_task_id && (
													<SquareCheckBig
														aria-label={convertedBadgeLabel}
														className="h-3 w-3 shrink-0 text-text-3"
													/>
												)}
											</button>
											{chip && (
												<span className="shrink-0 rounded-sm border border-border px-1 text-[9px] font-semibold tracking-wide text-text-3">
													{chip}
												</span>
											)}
											{/* No ✕ on a converted thread: close is a no-op on an
											    already-closed row, and the record is meant to stay. */}
											{conversations.length > 1 && !t.converted_task_id && (
												<button
													type="button"
													onClick={() => handleCloseThread(t.id)}
													aria-label="Close thread"
													data-testid="chat-thread-close-rail"
													className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 opacity-0 hover:bg-surface-3 hover:text-text-1 focus-visible:opacity-100 group-hover/thread:opacity-100"
												>
													<X className="h-3.5 w-3.5" />
												</button>
											)}
										</div>
									);
								})}
								{coworkerThreads.length > 0 && (
									<>
										<span className="text-eyebrow px-1 pb-1 pt-3 text-text-3">Team channels</span>
										{coworkerThreads.map((t) => {
											const isActive = t.id === activeConversationId;
											const chip = channelChip(t);
											return (
												<div
													key={t.id}
													data-testid="chat-thread-row"
													data-active={isActive}
													data-kind="coworker"
													className={`group/thread flex items-center gap-1 rounded-lg pl-2.5 pr-1 py-1.5 text-[13px] ${
														isActive
															? 'bg-surface-2 font-medium text-text-1'
															: 'text-text-2 hover:bg-surface-2 hover:text-text-1'
													}`}
												>
													<button
														type="button"
														onClick={() => selectThread(t.id)}
														className="flex min-w-0 flex-1 items-center gap-1 truncate text-left"
													>
														<span className="truncate">{threadLabel(t)}</span>
														{/* Read-only marker as a suffix to the name (approved design). */}
														<Lock aria-label="read-only" className="h-3 w-3 shrink-0 text-text-3" />
													</button>
													{chip && (
														<span className="shrink-0 rounded-sm border border-border px-1 text-[9px] font-semibold tracking-wide text-text-3">
															{chip}
														</span>
													)}
												</div>
											);
										})}
									</>
								)}
							</div>
						</aside>
					)}

					{/* Conversation column: dropdown switcher (hidden when the rail shows it) +
					    messages + composer. */}
					<div className="flex min-h-0 min-w-0 flex-1 flex-col">
						{/* Thread switcher: every thread from every surface, grouped like the
						    rail - your own chats first, then team channels (read-only). */}
						<div
							className={`flex items-center gap-1 border-b border-border px-3 py-1.5 ${
								expanded ? 'md:hidden' : ''
							}`}
						>
							<select
								data-testid="chat-thread-select"
								aria-label="Conversation thread"
								value={activeConversationId ?? ''}
								onChange={(e) => selectThread(e.target.value || undefined)}
								className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-1"
							>
								{conversations.length === 0 && <option value="">New thread</option>}
								{assistantThreads.map((t) => {
									const chip = channelChip(t);
									return (
										<option key={t.id} value={t.id}>
											{threadLabel(t)}
											{chip ? ` · ${chip}` : ''}
										</option>
									);
								})}
								{coworkerThreads.length > 0 && (
									<optgroup label="Team channels">
										{coworkerThreads.map((t) => {
											const chip = channelChip(t);
											return (
												<option key={t.id} value={t.id}>
													{threadLabel(t)} 🔒{chip ? ` · ${chip}` : ''}
												</option>
											);
										})}
									</optgroup>
								)}
							</select>
							<button
								type="button"
								onClick={handleNewThread}
								aria-label="New thread"
								data-testid="chat-thread-new"
								className="flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
							>
								<Plus className="h-4 w-4" />
							</button>
							{activeThread && conversations.length > 1 && !activeConverted && (
								<button
									type="button"
									onClick={() => handleCloseThread()}
									aria-label="Close thread"
									data-testid="chat-thread-close"
									className="flex h-7 w-7 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
								>
									<X className="h-4 w-4" />
								</button>
							)}
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
											Say hello to the CEO. Ask about anything, including active projects,
											notifications, task blockers, etc
										</p>
									)}
									{loaded && compactedCount > 0 && (
										<div
											data-testid="chat-compacted-banner"
											className="flex items-center gap-2 px-1 pt-1 text-[11px] text-text-3"
											title="Older messages were summarized into the CEO's long-term memory and removed from the live chat."
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
											projectSlug={hq?.slug}
											convertedTask={convertedTask}
											toolActivity={toolActivity}
										/>
									))}
									{queue.length > 0 && <QueuedMessages queue={queue} onRemove={dequeue} />}
								</div>

								<div className="border-t border-border p-3">
									{/* Coworker threads are read-only here: the channel is the write
									    surface, so the composer locks and points people back there. */}
									{activeReadOnly && activeThread && (
										<div
											data-testid="chat-readonly-banner"
											className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12px] text-text-2"
										>
											<Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-3" />
											<span>
												This conversation lives in <b>{threadLabel(activeThread)}</b> on{' '}
												{channelDisplayName(activeThread.channel)}. Hezo replies there when
												mentioned - continue it by mentioning Hezo in the channel.
											</span>
										</div>
									)}
									{/* Converted threads stay readable but continue on their task; the
									    banner links it. Falls back to a plain closed notice if the task
									    was since deleted (the thread then drops from the list anyway). */}
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
									{hasAnyChip && (
										<AttachmentChips
											attachments={visibleAttachments}
											uploading={uploading}
											errors={errors}
											onRemove={removeAttachment}
											projectId={hq?.slug}
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
													: activeReadOnly
														? `Read-only - reply from ${channelDisplayName(activeThread?.channel ?? '')}`
														: busy
															? 'Queue your next message…'
															: 'Ask the CEO anything, across every project…'
											}
											data-testid="chat-input"
											// `min-w-0` lets the row absorb the send button's widened labelled
											// states: a textarea's intrinsic min width would otherwise push
											// the composer past the panel edge on a 375px viewport.
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
												// `overflow-hidden` clips the hold sweep to the pill; the label
												// sits above it. Width animates as it morphs between the bare
												// circle and the two labelled states.
												className={`relative flex h-9 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full text-[11px] font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
													busy && !armed
														? 'w-auto px-3 bg-purple-soft text-purple-soft-fg hover:bg-purple-soft/80'
														: busy
															? 'w-auto px-3 bg-accent-solid text-accent-solid-fg hover:bg-accent-hover'
															: 'w-9 bg-accent-solid text-accent-solid-fg hover:bg-accent-hover'
												}`}
											>
												{/* The hold's own progress bar: accent sweeps across the soft
												    violet over LONG_PRESS_MS, then `armed` flips the whole pill. */}
												{busy && !armed && longPress.pressing && (
													<span
														aria-hidden
														data-testid="chat-send-sweep"
														style={
															{ '--chat-hold-ms': `${LONG_PRESS_MS}ms` } as React.CSSProperties
														}
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
			</div>
			{activeThread && (
				<ConvertToTaskDialog
					open={convertOpen}
					onOpenChange={setConvertOpen}
					thread={activeThread}
					convertThread={convertThread}
					converting={converting}
				/>
			)}
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
 * clearly not sent yet. Each carries its own remove control, which exists for
 * precisely as long as removal is possible — once the queue flushes these become
 * ordinary sent bubbles and there is nothing left to pull back.
 */
function QueuedMessages({
	queue,
	onRemove,
}: {
	queue: readonly QueuedChatMessage[];
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
	projectSlug,
	convertedTask,
	toolActivity,
}: {
	message: ChatMessage;
	/** HQ project slug — chat uploads land in its asset library. */
	projectSlug?: string;
	/** The thread's converted-task reference — renders the system meta message as a link. */
	convertedTask?: ChatConvertedTaskRef | null;
	/** Tool the in-flight reply is working with; only ever set on the streaming row. */
	toolActivity?: string | null;
}) {
	const isCeo = message.role === 'assistant';
	const interrupted = message.status === ChatMessageStatus.Interrupted;
	const failed = message.status === ChatMessageStatus.Failed;
	const streaming = message.status === ChatMessageStatus.Streaming;

	// System rows are meta markers, not bubbles — same centred idiom as the
	// compaction banner. Which marker is a property of the MESSAGE, never of the
	// thread: reading it off the conversation would make every system row in a
	// converted thread render as the converted-task link.
	//
	// A warning or notice carries a full sentence rather than a label, so unlike
	// the converted marker it wraps instead of truncating — its whole point is
	// naming the task and the teammate who was not notified, the connector that
	// refused the turn and what Hezo found when it re-checked, or the run this
	// turn is waiting on for its credential (linked, so the operator can go look).
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

	// Convert-to-task marker. When the thread's converted-task reference is gone
	// (task deleted) the raw server-baked text still names the identifier.
	if (message.role === 'system') {
		return (
			<div
				className="flex items-center gap-2 px-1 py-1 text-[11px] text-text-3"
				data-testid="chat-message"
				data-role="system"
			>
				<span className="h-px flex-1 bg-border" />
				<span className="inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-0.5">
					<SquareCheckBig className="h-3 w-3 shrink-0" aria-hidden="true" />
					{convertedTask ? (
						<Trans
							k="chat.converted.metaMessage"
							vars={{ task: <ConvertedTaskLink task={convertedTask} /> }}
						/>
					) : (
						<span className="truncate">{message.content}</span>
					)}
				</span>
				<span className="h-px flex-1 bg-border" />
			</div>
		);
	}

	if (isCeo) {
		// Still composing with no text yet → the typing indicator stands in for
		// the (otherwise empty) bubble.
		if (streaming && message.content.length === 0) {
			return <TypingIndicator tool={toolActivity} />;
		}
		return (
			<div
				className="group flex max-w-[90%] flex-col gap-1"
				data-testid="chat-message"
				data-role="ceo"
			>
				<RoleLabel>CEO · {HQ_PROJECT_NAME}</RoleLabel>
				<div className="rounded-2xl rounded-bl-sm bg-surface-2 px-3.5 py-2.5 text-text-1">
					{/* The CEO's replies are LLM-authored markdown. The global chat has
					    no single project scope, so mentions resolve instance-wide:
					    references that are unique across all projects (TO-1, prd.md,
					    @agent, …) render as client-side links; ambiguous ones stay
					    plain text. */}
					{message.content ? (
						<MarkdownProse testId="chat-markdown" instance>
							{message.content}
						</MarkdownProse>
					) : failed ? (
						// The server's own reason where it recorded one - it names the run
						// holding a busy credential, for instance - else the bare fact.
						<span className="text-[13px] leading-relaxed" data-testid="chat-failure">
							{message.error ? <RunLinkedText text={message.error} /> : 'Something went wrong.'}
						</span>
					) : null}
					{interrupted && <div className="mt-1 text-[11px] italic text-text-3">(interrupted)</div>}
				</div>
				{/* Reply has begun but the CEO is still working → dots sit just below
				    the same bubble. */}
				{streaming && <StreamingDots tool={toolActivity} />}
				{/* Once the reply has settled, a hover-revealed copy affordance for this
				    single message sits just under the bubble. */}
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
				// wrap-anywhere (not break-words): the bubble is a fit-content flex
				// item, so an unbreakable token — a pasted URL — would otherwise set a
				// min-content width wider than the panel and push the message list into
				// horizontal scroll. `anywhere` is the one overflow-wrap value that also
				// shrinks the intrinsic size, keeping the bubble inside max-w-[90%].
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
 * (right-aligned) user bubble. Each opens the in-app asset viewer (chat
 * uploads land in the HQ project's library); before the HQ slug resolves the
 * chip degrades to the raw signed URL in a new tab.
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
 * hovered (or the button is focused). Each instance tracks its own copied state
 * so the check only flips on the message you actually copied. Keyed on hover
 * *capability*, not screen size: pointer devices hide it until the bubble is
 * hovered; touch devices (no hover, any size) keep it visible so it stays
 * reachable. `group-hover` is itself auto-scoped to `(hover: hover)` by Tailwind.
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

/** Three pulsing dots — the CEO's resting "thinking" / "still typing" animation. */
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
 * The tool the reply is working with right now, beside the dots. The runtimes
 * emit whole assistant messages rather than token deltas, so a turn that calls a
 * tool after writing its text would otherwise be indistinguishable from one that
 * has finished — the operator sees dots and no reason for them.
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
 * The CEO has begun a reply but produced no text yet — the label + bare dots
 * stand in for the (otherwise empty) bubble until the first tokens land.
 */
function TypingIndicator({ tool }: { tool?: string | null }) {
	return (
		<div
			className="flex max-w-[90%] flex-col gap-1.5"
			data-testid="chat-typing"
			role="status"
			aria-label="CEO is typing"
		>
			<RoleLabel>CEO · {HQ_PROJECT_NAME}</RoleLabel>
			<span className="flex min-w-0 items-center gap-2 px-1">
				<Dots />
				{tool && <ToolActivity tool={tool} />}
			</span>
		</div>
	);
}

/**
 * Dots pinned just below an in-flight reply bubble — signals the CEO is still
 * working after the first tokens have already landed.
 */
function StreamingDots({ tool }: { tool?: string | null }) {
	return (
		<span
			className="flex min-w-0 items-center gap-2 px-1 pt-0.5"
			data-testid="chat-streaming-dots"
			role="status"
			aria-label="CEO is still typing"
		>
			<Dots />
			{tool && <ToolActivity tool={tool} />}
		</span>
	);
}
