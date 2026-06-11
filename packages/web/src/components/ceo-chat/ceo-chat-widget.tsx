import { Loader2, MessageSquare, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type CeoMessage, useCeoChat } from '../../hooks/use-ceo-chat';

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
			<button
				type="button"
				onClick={() => setOpen(true)}
				data-testid="ceo-chat-launcher"
				aria-label="Chat with the CEO"
				className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white shadow-lg hover:opacity-90"
			>
				<MessageSquare className="h-5 w-5" />
			</button>
		);
	}

	return (
		<div
			data-testid="ceo-chat-panel"
			className="fixed z-50 flex flex-col border border-border bg-bg shadow-xl inset-x-2 bottom-2 top-16 rounded-radius-md md:inset-auto md:bottom-4 md:right-4 md:top-auto md:h-[560px] md:w-[380px]"
		>
			<header className="flex items-center justify-between border-b border-border px-3 py-2.5">
				<div className="flex flex-col">
					<span className="text-sm font-semibold text-text">CEO</span>
					<span className="text-[11px] text-text-muted">
						{streaming ? 'Typing…' : 'Ask about any project'}
					</span>
				</div>
				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-label="Close chat"
					data-testid="ceo-chat-close"
					className="flex h-9 w-9 items-center justify-center rounded-radius-md text-text-muted hover:text-text hover:bg-bg-subtle"
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
					<div className="flex items-center justify-center py-6 text-[13px] text-text-muted">
						<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						Loading…
					</div>
				)}
				{loaded && messages.length === 0 && (
					<p className="px-1 py-6 text-center text-[13px] text-text-muted">
						Say hello to the CEO. Ask about active projects, blockers, or what to do next.
					</p>
				)}
				{messages.map((m) => (
					<MessageBubble key={m.id} message={m} />
				))}
				{streaming && <TypingIndicator />}
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
						className="max-h-32 min-h-[2.25rem] flex-1 resize-none rounded-radius-md border border-border bg-bg-subtle px-3 py-2 text-[13px] text-text outline-none focus:border-primary"
					/>
					<button
						type="button"
						onClick={submit}
						disabled={!draft.trim()}
						aria-label="Send message"
						data-testid="ceo-chat-send"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-radius-md bg-primary text-white disabled:opacity-40 hover:opacity-90"
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

	if (isCeo) {
		return (
			<div
				className="flex flex-col gap-1 max-w-[90%]"
				data-testid="ceo-chat-message"
				data-role="ceo"
			>
				<div className="rounded-radius-md rounded-bl-sm border border-border bg-bg-subtle px-3 py-2 text-[13px] leading-relaxed text-text whitespace-pre-wrap">
					{message.content || (failed ? 'Something went wrong.' : '')}
					{interrupted && (
						<span className="ml-1 text-[11px] italic text-text-subtle">(interrupted)</span>
					)}
				</div>
				<span className="text-[10px] text-text-subtle">{formatTime(message.created_at)}</span>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col items-end gap-1 self-end max-w-[90%]"
			data-testid="ceo-chat-message"
			data-role="user"
		>
			<div className="rounded-radius-md rounded-br-sm border border-accent-blue-text/20 bg-accent-blue-bg px-3 py-2 text-[13px] leading-relaxed text-text whitespace-pre-wrap">
				{message.content}
			</div>
			<span className="text-[10px] text-text-subtle">{formatTime(message.created_at)}</span>
		</div>
	);
}

function TypingIndicator() {
	return (
		<div className="flex items-center gap-1" data-testid="ceo-chat-typing" aria-live="polite">
			<span className="h-1.5 w-1.5 rounded-full bg-text-subtle animate-pulse" />
			<span className="h-1.5 w-1.5 rounded-full bg-text-subtle animate-pulse [animation-delay:150ms]" />
			<span className="h-1.5 w-1.5 rounded-full bg-text-subtle animate-pulse [animation-delay:300ms]" />
		</div>
	);
}
