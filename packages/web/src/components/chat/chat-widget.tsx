import { assetBasename, ChatMessageStatus, HQ_PROJECT_NAME } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import {
	ArrowRight,
	Check,
	Copy,
	ExternalLink,
	FileAudio,
	File as FileIcon,
	FileText,
	FileVideo,
	History,
	Image as ImageIcon,
	Loader2,
	Lock,
	Maximize2,
	MessageSquare,
	Minimize2,
	Plus,
	X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAutoGrowTextarea } from '../../hooks/use-auto-grow-textarea';
import {
	type ChatConversationSummary,
	type ChatMessage,
	useChat,
	useChatConversations,
} from '../../hooks/use-chat';
import { useContainerHealth } from '../../hooks/use-container-health';
import { useDraggableFab } from '../../hooks/use-draggable-fab';
import { useFileAttachments } from '../../hooks/use-file-attachments';
import { useHqProject } from '../../hooks/use-projects';
import { useUploadChatAttachment } from '../../hooks/use-upload-chat-attachment';
import { copyToClipboard } from '../../lib/clipboard';
import {
	ATTACHMENT_ACCEPT,
	AttachmentChips,
	FileDropZone,
	UploadButton,
} from '../file-attachments';
import { HqContainerNotice } from '../hq-container-notice';
import { MarkdownProse } from '../markdown-prose';
import { CountOverlayBadge } from '../ui/count-overlay-badge';
import { Tooltip } from '../ui/tooltip';

/**
 * Floating chat with the CEO, pinned bottom-right (on portrait mobile screens
 * the launcher can be dragged elsewhere). Talks to the single global CEO
 * conversation; messages stream in over the `chat:global` WebSocket room. Sending a
 * new message while a reply is in flight interrupts it (handled server-side) and
 * starts a fresh turn. The CEO is the instance-level singleton living in the HQ
 * team, so every reply is labelled `CEO · HQ`.
 */
interface ChatWidgetProps {
	/** Open state is lifted to the shell so sibling surfaces (the floating
	 *  new-task button) can react to the chat being open. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ChatWidget({ open, onOpenChange }: ChatWidgetProps) {
	const setOpen = onOpenChange;
	const [expanded, setExpanded] = useState(false);
	// Draggable launcher on portrait mobile screens (the panel itself never
	// moves). Must be called before the `if (!open)` early return below.
	const fab = useDraggableFab('chat');
	// The selected thread (undefined = the default web thread). The switcher lets the
	// operator create/switch/close parallel conversation threads.
	const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>(
		undefined,
	);
	const {
		messages,
		send,
		streaming,
		sending,
		loaded,
		unread,
		compactedCount,
		conversationId: activeConversationId,
	} = useChat(open, selectedConversationId);
	const { conversations, createThread, closeThread } = useChatConversations(open);
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// The CEO can only act while the HQ container is up. When it isn't, the chat
	// stays openable but swaps its body for the container state + a link to fix it.
	const blockedHealth = hqHealth && hqHealth.kind !== 'healthy' ? hqHealth : null;
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
		el.scrollTop = el.scrollHeight;
	}, [lastId, lastLen, streaming, open, expanded]);

	// Escape closes the chat from any open state (anchored or the expanded modal).
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [open, setOpen]);

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
	// Untitled threads render as "New thread" until the CEO auto-titles them from the
	// conversation; there is no special "Main" default anymore.
	const threadLabel = (t: (typeof conversations)[number]) => t.title?.trim() || 'New thread';

	const submit = () => {
		const text = draft.trim();
		// A message needs text or at least one attachment. Block while a send is in
		// flight or a reply is streaming — prevents the impatient double-click
		// (seeing the optimistic bubble "stuck" during the egress check) that used
		// to spawn duplicate CEO turns. Files still uploading also block the send.
		// Coworker (team-channel) threads are read-only here — never send.
		if (
			activeReadOnly ||
			(!text && visibleAttachments.length === 0) ||
			uploading.length > 0 ||
			sending ||
			streaming
		) {
			return;
		}
		const attachments = visibleAttachments;
		setDraft('');
		setPendingAttachmentIds([]);
		send(text, attachments).catch(() => undefined);
	};

	const handleNewThread = async () => {
		const res = (await createThread().catch(() => null)) as {
			conversation?: { id: string };
		} | null;
		if (res?.conversation?.id) setSelectedConversationId(res.conversation.id);
	};
	// Close a thread (defaults to the active one). If it was the active thread, fall
	// back to the default web thread afterwards.
	const handleCloseThread = async (id?: string) => {
		const target = id ?? activeConversationId;
		if (!target) return;
		await closeThread(target).catch(() => undefined);
		if (target === activeConversationId) setSelectedConversationId(undefined);
	};

	// Copy the whole conversation as plain text, each turn labelled by speaker.
	const copyConversation = async () => {
		const transcript = messages
			.filter((m) => m.content.trim().length > 0)
			.map((m) => `${m.role === 'assistant' ? `CEO · ${HQ_PROJECT_NAME}` : 'You'}: ${m.content}`)
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
			    the page with margins around it) and, on desktop, only in expanded mode —
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
						    view. Decorative only — the in-thread indicator carries the aria
						    live-region announcement, so this stays aria-hidden to avoid a
						    duplicate read. */}
						{streaming && (
							<span data-testid="chat-header-dots" className="pl-0.5">
								<Dots />
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
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
												onClick={() => setSelectedConversationId(t.id)}
												className="min-w-0 flex-1 truncate text-left"
											>
												{threadLabel(t)}
											</button>
											{chip && (
												<span className="shrink-0 rounded-sm border border-border px-1 text-[9px] font-semibold tracking-wide text-text-3">
													{chip}
												</span>
											)}
											{conversations.length > 1 && (
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
														onClick={() => setSelectedConversationId(t.id)}
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
						    rail — your own chats first, then team channels (read-only). */}
						<div
							className={`flex items-center gap-1 border-b border-border px-3 py-1.5 ${
								expanded ? 'md:hidden' : ''
							}`}
						>
							<select
								data-testid="chat-thread-select"
								aria-label="Conversation thread"
								value={activeConversationId ?? ''}
								onChange={(e) => setSelectedConversationId(e.target.value || undefined)}
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
							{activeThread && conversations.length > 1 && (
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
									slug={hq.slug}
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
										<MessageBubble key={m.id} message={m} projectSlug={hq?.slug} />
									))}
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
												mentioned — continue it by mentioning Hezo in the channel.
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
											activeReadOnly ? 'opacity-50' : ''
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
													submit();
												}
											}}
											rows={1}
											disabled={activeReadOnly}
											placeholder={
												activeReadOnly
													? `Read-only — reply from ${channelDisplayName(activeThread?.channel ?? '')}`
													: 'Ask the CEO anything, across every project…'
											}
											data-testid="chat-input"
											className="max-h-32 min-h-[2.25rem] flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-[13px] leading-5 text-text-1 outline-none placeholder:text-text-3"
										/>
										<button
											type="button"
											onClick={submit}
											disabled={
												activeReadOnly ||
												(!draft.trim() && visibleAttachments.length === 0) ||
												uploading.length > 0 ||
												sending ||
												streaming
											}
											aria-label="Send message"
											data-testid="chat-send"
											className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
										>
											<ArrowRight className="h-4 w-4" />
										</button>
									</div>
								</div>
							</FileDropZone>
						)}
					</div>
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

/** The small uppercase eyebrow above each bubble ("YOU" / "CEO · HQ"). */
function RoleLabel({ children }: { children: ReactNode }) {
	return <span className="text-eyebrow px-1 text-text-3">{children}</span>;
}

function MessageBubble({
	message,
	projectSlug,
}: {
	message: ChatMessage;
	/** HQ project slug — chat uploads land in its asset library. */
	projectSlug?: string;
}) {
	const isCeo = message.role === 'assistant';
	const interrupted = message.status === ChatMessageStatus.Interrupted;
	const failed = message.status === ChatMessageStatus.Failed;
	const streaming = message.status === ChatMessageStatus.Streaming;

	if (isCeo) {
		// Still composing with no text yet → the typing indicator stands in for
		// the (otherwise empty) bubble.
		if (streaming && message.content.length === 0) {
			return <TypingIndicator />;
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
						<span className="text-[13px] leading-relaxed">Something went wrong.</span>
					) : null}
					{interrupted && <div className="mt-1 text-[11px] italic text-text-3">(interrupted)</div>}
				</div>
				{/* Reply has begun but the CEO is still working → dots sit just below
				    the same bubble. */}
				{streaming && <StreamingDots />}
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
				<div className="rounded-2xl rounded-br-sm bg-inverse px-3.5 py-2.5 text-sm leading-relaxed text-inverse-fg whitespace-pre-wrap">
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

/** Type-based icon for a sent attachment chip. */
function attachmentIcon(contentType: string) {
	const cls = 'h-3.5 w-3.5 shrink-0 text-text-3';
	if (contentType.startsWith('image/')) return <ImageIcon className={cls} />;
	if (contentType.startsWith('audio/')) return <FileAudio className={cls} />;
	if (contentType.startsWith('video/')) return <FileVideo className={cls} />;
	if (contentType === 'application/pdf' || contentType === 'text/plain') {
		return <FileText className={cls} />;
	}
	return <FileIcon className={cls} />;
}

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
						{attachmentIcon(a.content_type)}
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
						{attachmentIcon(a.content_type)}
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
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	const handleCopy = async () => {
		if (await copyToClipboard(text)) {
			setCopied(true);
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => setCopied(false), 1500);
		}
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
 * The CEO has begun a reply but produced no text yet — the label + bare dots
 * stand in for the (otherwise empty) bubble until the first tokens land.
 */
function TypingIndicator() {
	return (
		<div
			className="flex max-w-[90%] flex-col gap-1.5"
			data-testid="chat-typing"
			role="status"
			aria-label="CEO is typing"
		>
			<RoleLabel>CEO · {HQ_PROJECT_NAME}</RoleLabel>
			<span className="px-1">
				<Dots />
			</span>
		</div>
	);
}

/**
 * Dots pinned just below an in-flight reply bubble — signals the CEO is still
 * working after the first tokens have already landed.
 */
function StreamingDots() {
	return (
		<span
			className="px-1 pt-0.5"
			data-testid="chat-streaming-dots"
			role="status"
			aria-label="CEO is still typing"
		>
			<Dots />
		</span>
	);
}
