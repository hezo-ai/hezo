import { Loader2, MessageSquare, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type CeoMessage, useCeoChat } from '../../hooks/use-ceo-chat';
import { MarkdownProse } from '../markdown-prose';
import { Tooltip } from '../ui/tooltip';

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * LinkedIn-style floating chat with the CEO, pinned bottom-right. Talks to the
 * single global CEO conversation; messages stream in over the `ceo:global`
 * WebSocket room. Sending a new message while a reply is in flight interrupts
 * it (handled server-side) and starts a fresh turn.
 */
export function CeoChatWidget() {
	const [open, setOpen] = useState(false);
	const { messages, send, streaming, loaded } = useCeoChat(open);
	const [draft, setDraft] = useState('');
	const scrollRef = useRef<HTMLDivElement>(null);

	const lastId = messages.at(-1)?.id;
	const lastLen = messages.at(-1)?.content.length ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll as messages stream
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [lastId, lastLen, streaming, open]);

	const submit = () => {
		const text = draft.trim();
		if (!text) return;
		setDraft('');
		send(text).catch(() => undefined);
	};

	if (!open) {
		return (
			<Tooltip content="Chat with CEO" side="left">
				<button
					type="button"
					onClick={() => setOpen(true)}
					data-testid="ceo-chat-launcher"
					aria-label="Chat with the CEO"
					className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-inverse text-inverse-fg shadow-lg hover:opacity-90"
				>
					<MessageSquare className="h-5 w-5" />
				</button>
			</Tooltip>
		);
	}

	return (
		<div
			data-testid="ceo-chat-panel"
			className="fixed z-50 flex flex-col border border-border bg-surface shadow-xl inset-x-2 bottom-2 top-16 rounded-md md:inset-auto md:bottom-4 md:right-4 md:top-auto md:h-[560px] md:w-[380px]"
		>
			<header className="flex items-center justify-between border-b border-border px-3 py-2.5">
				<div className="flex flex-col">
					<span className="text-sm font-semibold text-text-1">🧑‍💼 CEO</span>
					<span className="text-[11px] text-text-2">Ask about any project</span>
				</div>
				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-label="Close chat"
					data-testid="ceo-chat-close"
					className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:text-text-1 hover:bg-surface-2"
				>
					<X className="h-4 w-4" />
				</button>
			</header>

			<div
				ref={scrollRef}
				data-testid="ceo-chat-messages"
				className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 scroll-smooth"
			>
				{!loaded && (
					<div className="flex items-center justify-center py-6 text-[13px] text-text-2">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						Loading…
					</div>
				)}
				{loaded && messages.length === 0 && (
					<p className="px-1 py-6 text-center text-[13px] text-text-2">
						Say hello to the CEO. Ask about anything, including active projects, notifications, task
						blockers, etc
					</p>
				)}
				{messages.map((m) => (
					<MessageBubble key={m.id} message={m} />
				))}
			</div>

			<div className="border-t border-border p-2">
				<div className="flex items-end gap-2">
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								submit();
							}
						}}
						rows={1}
						placeholder="Message the CEO…"
						data-testid="ceo-chat-input"
						className="max-h-32 min-h-[2.25rem] flex-1 resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-[13px] text-text-1 outline-none focus:border-inverse"
					/>
					<button
						type="button"
						onClick={submit}
						disabled={!draft.trim()}
						aria-label="Send message"
						data-testid="ceo-chat-send"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-inverse text-inverse-fg disabled:opacity-40 hover:opacity-90"
					>
						<Send className="h-4 w-4" />
					</button>
				</div>
			</div>
		</div>
	);
}

function MessageBubble({ message }: { message: CeoMessage }) {
	const isCeo = message.role === 'assistant';
	const interrupted = message.status === 'interrupted';
	const failed = message.status === 'failed';
	const streaming = message.status === 'streaming';

	if (isCeo) {
		// Still composing with no text yet → the typing indicator stands in for
		// the (otherwise empty) bubble.
		if (streaming && message.content.length === 0) {
			return <TypingIndicator />;
		}
		return (
			<div
				className="flex flex-col gap-1 max-w-[90%]"
				data-testid="ceo-chat-message"
				data-role="ceo"
			>
				<div className="rounded-md rounded-bl-sm border border-border bg-surface-2 px-3 py-2 text-text-1">
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
					{/* Reply has begun but the CEO is still working → dots pinned to
					    the bottom of the same bubble. */}
					{streaming && <StreamingDots />}
				</div>
				<span className="text-[10px] text-text-3">{formatTime(message.created_at)}</span>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col items-end gap-1 self-end max-w-[90%]"
			data-testid="ceo-chat-message"
			data-role="user"
		>
			<div className="rounded-md rounded-br-sm border border-info-soft-fg/20 bg-info-soft px-3 py-2 text-sm leading-relaxed text-text-1 whitespace-pre-wrap">
				{message.content}
			</div>
			<span className="text-[10px] text-text-3">{formatTime(message.created_at)}</span>
		</div>
	);
}

function TypingIndicator() {
	return (
		<div
			className="flex items-center gap-2 max-w-[90%]"
			data-testid="ceo-chat-typing"
			role="status"
			aria-label="CEO is typing"
		>
			<span
				aria-hidden
				className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-base leading-none"
			>
				🧑‍💼
			</span>
			<div className="flex items-center gap-1.5 rounded-md rounded-bl-sm border border-border bg-surface-2 px-3 py-3">
				<span className="h-2.5 w-2.5 rounded-full bg-text-3 animate-pulse" />
				<span className="h-2.5 w-2.5 rounded-full bg-text-3 animate-pulse [animation-delay:150ms]" />
				<span className="h-2.5 w-2.5 rounded-full bg-text-3 animate-pulse [animation-delay:300ms]" />
			</div>
		</div>
	);
}

/**
 * Small dots pinned to the bottom of an in-flight reply bubble — signals the CEO
 * is still working after the first tokens have already landed. (Display:flex
 * breaks it onto its own line below the streamed text.)
 */
function StreamingDots() {
	return (
		<span
			className="mt-1.5 flex items-center gap-1"
			data-testid="ceo-chat-streaming-dots"
			role="status"
			aria-label="CEO is still typing"
		>
			<span className="h-1.5 w-1.5 rounded-full bg-text-3 animate-pulse" />
			<span className="h-1.5 w-1.5 rounded-full bg-text-3 animate-pulse [animation-delay:150ms]" />
			<span className="h-1.5 w-1.5 rounded-full bg-text-3 animate-pulse [animation-delay:300ms]" />
		</span>
	);
}
