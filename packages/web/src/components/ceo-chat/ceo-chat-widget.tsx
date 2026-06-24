import { HQ_PROJECT_NAME } from '@hezo/shared';
import { ArrowRight, Loader2, MessageSquare, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type CeoMessage, useCeoChat } from '../../hooks/use-ceo-chat';
import { MarkdownProse } from '../markdown-prose';
import { Tooltip } from '../ui/tooltip';

/**
 * Floating chat with the CEO, pinned bottom-right. Talks to the single global CEO
 * conversation; messages stream in over the `ceo:global` WebSocket room. Sending a
 * new message while a reply is in flight interrupts it (handled server-side) and
 * starts a fresh turn. The CEO is the instance-level singleton living in the HQ
 * team, so every reply is labelled `CEO · HQ`.
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
			className="fixed z-50 flex flex-col overflow-hidden border border-border bg-surface shadow-xl inset-x-2 bottom-2 top-16 rounded-2xl md:inset-auto md:bottom-4 md:right-4 md:top-auto md:h-[560px] md:w-[420px]"
		>
			<header className="flex items-center justify-between border-b border-border px-4 py-3">
				<div className="flex items-center gap-2">
					<span className="text-sm font-semibold text-text-1">CEO</span>
					<span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-2">
						{HQ_PROJECT_NAME}
					</span>
				</div>
				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-label="Close chat"
					data-testid="ceo-chat-close"
					className="flex h-9 w-9 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
				>
					<X className="h-4 w-4" />
				</button>
			</header>

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
						Say hello to the CEO. Ask about anything, including active projects, notifications, task
						blockers, etc
					</p>
				)}
				{messages.map((m) => (
					<MessageBubble key={m.id} message={m} />
				))}
			</div>

			<div className="border-t border-border p-3">
				<div className="flex items-end gap-2 rounded-2xl border border-border bg-surface px-2 py-1.5 transition-colors focus-within:border-border-strong">
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
						placeholder="Ask the CEO anything, across every project…"
						data-testid="ceo-chat-input"
						className="max-h-32 min-h-[2.25rem] flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-5 text-text-1 outline-none placeholder:text-text-3"
					/>
					<button
						type="button"
						onClick={submit}
						disabled={!draft.trim()}
						aria-label="Send message"
						data-testid="ceo-chat-send"
						className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
					>
						<ArrowRight className="h-4 w-4" />
					</button>
				</div>
			</div>
		</div>
	);
}

/** The small uppercase eyebrow above each bubble ("YOU" / "CEO · HQ"). */
function RoleLabel({ children }: { children: ReactNode }) {
	return <span className="text-eyebrow px-1 text-text-3">{children}</span>;
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
				className="flex max-w-[90%] flex-col gap-1"
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
			</div>
		);
	}

	return (
		<div
			className="flex max-w-[90%] flex-col items-end gap-1 self-end"
			data-testid="ceo-chat-message"
			data-role="user"
		>
			<RoleLabel>You</RoleLabel>
			<div className="rounded-2xl rounded-br-sm bg-inverse px-3.5 py-2.5 text-sm leading-relaxed text-inverse-fg whitespace-pre-wrap">
				{message.content}
			</div>
		</div>
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
