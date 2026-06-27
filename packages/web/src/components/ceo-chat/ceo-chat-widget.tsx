import { CeoMessageStatus, HQ_PROJECT_NAME } from '@hezo/shared';
import {
	ArrowRight,
	Check,
	Copy,
	Loader2,
	Maximize2,
	MessageSquare,
	Minimize2,
	X,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type CeoMessage, useCeoChat } from '../../hooks/use-ceo-chat';
import { useContainerHealth } from '../../hooks/use-container-health';
import { useHqProject } from '../../hooks/use-projects';
import { copyToClipboard } from '../../lib/clipboard';
import { HqContainerNotice } from '../hq-container-notice';
import { MarkdownProse } from '../markdown-prose';
import { CountOverlayBadge } from '../ui/count-overlay-badge';
import { Tooltip } from '../ui/tooltip';

/** Grow/shrink a textarea to fit its content, capped by its CSS `max-height`. */
function fitTextareaToContent(el: HTMLTextAreaElement): void {
	el.style.height = 'auto';
	el.style.height = `${el.scrollHeight}px`;
}

/**
 * Floating chat with the CEO, pinned bottom-right. Talks to the single global CEO
 * conversation; messages stream in over the `ceo:global` WebSocket room. Sending a
 * new message while a reply is in flight interrupts it (handled server-side) and
 * starts a fresh turn. The CEO is the instance-level singleton living in the HQ
 * team, so every reply is labelled `CEO · HQ`.
 */
interface CeoChatWidgetProps {
	/** Open state is lifted to the shell so sibling surfaces (the floating
	 *  new-task button) can react to the chat being open. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CeoChatWidget({ open, onOpenChange }: CeoChatWidgetProps) {
	const setOpen = onOpenChange;
	const [expanded, setExpanded] = useState(false);
	const { messages, send, streaming, sending, loaded, unread } = useCeoChat(open);
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// The CEO can only act while the HQ container is up. When it isn't, the chat
	// stays openable but swaps its body for the container state + a link to fix it.
	const blockedHealth = hqHealth && hqHealth.kind !== 'healthy' ? hqHealth : null;
	const [draft, setDraft] = useState('');
	const [copied, setCopied] = useState(false);
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
	// `open` re-runs it when the panel (re)mounts so a draft kept across a close/open
	// is sized correctly rather than clipped to a single row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on draft/open change (body reads the DOM via a stable ref)
	useEffect(() => {
		const el = inputRef.current;
		if (el) fitTextareaToContent(el);
	}, [draft, open]);

	// The content height also depends on the composer's *width*: expanding/collapsing
	// the panel, a viewport breakpoint change, or a web font swapping in all re-wrap
	// the text. Without re-measuring on those, the box keeps a stale height — too tall
	// after it widens, or clipping the top line after it narrows. A ResizeObserver
	// re-fits on any width change; the guard keeps our own height writes (which don't
	// change width) from feeding back into a resize loop.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-attach the observer when the composer (re)mounts on open
	useEffect(() => {
		const el = inputRef.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		let lastWidth = el.clientWidth;
		const ro = new ResizeObserver(() => {
			if (el.clientWidth === lastWidth) return;
			lastWidth = el.clientWidth;
			fitTextareaToContent(el);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [open]);

	// Clear the "copied" reset timer on unmount so it can't fire into a gone component.
	useEffect(() => {
		return () => {
			if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
		};
	}, []);

	const submit = () => {
		const text = draft.trim();
		// Block while a send is in flight or a reply is streaming — prevents the
		// impatient double-click (seeing the optimistic bubble "stuck" during the
		// egress check) that used to spawn duplicate CEO turns.
		if (!text || sending || streaming) return;
		setDraft('');
		send(text).catch(() => undefined);
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
					type="button"
					onClick={() => setOpen(true)}
					data-testid="ceo-chat-launcher"
					aria-label={unread > 0 ? `Chat with the CEO (${unread} unread)` : 'Chat with the CEO'}
					className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-inverse text-inverse-fg shadow-lg hover:opacity-90"
				>
					<MessageSquare className="h-5 w-5" />
					{/* Unread CEO replies overlay the launcher, mirroring the inbox icon. */}
					<CountOverlayBadge count={unread} testId="ceo-chat-unread-badge" />
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
			{/* In expanded mode the chat is modal: a scrim dims and occludes the page
			    content below the nav bar (the header stays clear and usable, matching
			    the panel's own top-12 boundary). Clicking it dismisses the chat. */}
			{expanded && (
				<button
					type="button"
					aria-label="Close chat"
					data-testid="ceo-chat-overlay"
					onClick={() => setOpen(false)}
					className="fixed inset-x-0 bottom-0 top-12 z-40 bg-[var(--overlay)] cursor-default"
				/>
			)}
			<div
				data-testid="ceo-chat-panel"
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
							<span data-testid="ceo-chat-header-dots" className="pl-0.5">
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
							data-testid="ceo-chat-copy"
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
							data-testid="ceo-chat-expand"
							className="hidden h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1 md:flex"
						>
							{expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
						</button>
						<button
							type="button"
							onClick={() => setOpen(false)}
							aria-label="Close chat"
							data-testid="ceo-chat-close"
							className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				</header>

				{hq && blockedHealth ? (
					<div
						data-testid="ceo-chat-messages"
						className="flex flex-1 items-center justify-center overflow-y-auto"
					>
						<HqContainerNotice
							health={blockedHealth}
							slug={hq.slug}
							description="The CEO is unavailable until the HQ container is running."
						/>
					</div>
				) : (
					<>
						<div
							ref={scrollRef}
							data-testid="ceo-chat-messages"
							className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 scroll-smooth"
						>
							{!loaded && (
								<div className="flex items-center justify-center py-6 text-[13px] text-text-2">
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Loading…
								</div>
							)}
							{loaded && messages.length === 0 && (
								<p className="px-1 py-6 text-center text-[13px] text-text-2">
									Say hello to the CEO. Ask about anything, including active projects,
									notifications, task blockers, etc
								</p>
							)}
							{messages.map((m) => (
								<MessageBubble key={m.id} message={m} />
							))}
						</div>

						<div className="border-t border-border p-3">
							<div className="flex items-end gap-2 rounded-2xl border border-border bg-surface px-2 py-1.5 transition-colors focus-within:border-border-strong">
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
									placeholder="Ask the CEO anything, across every project…"
									data-testid="ceo-chat-input"
									className="max-h-32 min-h-[2.25rem] flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-[13px] leading-5 text-text-1 outline-none placeholder:text-text-3"
								/>
								<button
									type="button"
									onClick={submit}
									disabled={!draft.trim() || sending || streaming}
									aria-label="Send message"
									data-testid="ceo-chat-send"
									className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
								>
									<ArrowRight className="h-4 w-4" />
								</button>
							</div>
						</div>
					</>
				)}
			</div>
		</>
	);
}

/** The small uppercase eyebrow above each bubble ("YOU" / "CEO · HQ"). */
function RoleLabel({ children }: { children: ReactNode }) {
	return <span className="text-eyebrow px-1 text-text-3">{children}</span>;
}

function MessageBubble({ message }: { message: CeoMessage }) {
	const isCeo = message.role === 'assistant';
	const interrupted = message.status === CeoMessageStatus.Interrupted;
	const failed = message.status === CeoMessageStatus.Failed;
	const streaming = message.status === CeoMessageStatus.Streaming;

	if (isCeo) {
		// Still composing with no text yet → the typing indicator stands in for
		// the (otherwise empty) bubble.
		if (streaming && message.content.length === 0) {
			return <TypingIndicator />;
		}
		return (
			<div
				className="group flex max-w-[90%] flex-col gap-1"
				data-testid="ceo-chat-message"
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
						<MarkdownProse testId="ceo-chat-markdown" instance>
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
			data-testid="ceo-chat-message"
			data-role="user"
		>
			<RoleLabel>You</RoleLabel>
			<div className="rounded-2xl rounded-br-sm bg-inverse px-3.5 py-2.5 text-sm leading-relaxed text-inverse-fg whitespace-pre-wrap">
				{message.content}
			</div>
			{message.content.length > 0 && <MessageCopyButton text={message.content} align="end" />}
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
			data-testid="ceo-chat-message-copy"
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
			data-testid="ceo-chat-typing"
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
			data-testid="ceo-chat-streaming-dots"
			role="status"
			aria-label="CEO is still typing"
		>
			<Dots />
		</span>
	);
}
