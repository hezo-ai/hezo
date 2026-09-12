import { useChatDockOpen } from '../../contexts/chat-dock-context';
import { CEO_ROOM } from '../../hooks/use-chat';
import { useI18n } from '../../lib/i18n';
import { ChatSurface } from './chat-surface';

/**
 * The fresh-instance landing: the CEO's live stream rendered full-pane as the
 * home content (a landing state, not a route - decision: chat lives in rooms).
 * The empty state carries the CEO's proactive greeting and starter chips; a
 * chip click sends its text as the operator's first message, so onboarding
 * starts as a conversation. Once the first project exists the dashboard takes
 * over and the CEO continues in the dock.
 */
export function CeoLandingChat({ onCreateProject }: { onCreateProject: () => void }) {
	const { t } = useI18n();
	// The dock renders this same room. Two live mounts would double-render every
	// message and double-mark reads, so the landing yields while the dock is open.
	const dockOpen = useChatDockOpen();
	const starters = [
		t('chat.starter.createProject'),
		t('chat.starter.whatCanHezo'),
		t('chat.starter.importRepo'),
	];

	if (dockOpen) {
		return (
			<div className="mb-6" data-testid="home-ceo-landing">
				<div className="flex h-[200px] items-center justify-center rounded-2xl border border-border bg-surface text-[13px] text-text-3">
					{t('chat.landing.inDock')}
				</div>
			</div>
		);
	}

	return (
		<div className="mb-6" data-testid="home-ceo-landing">
			<div className="flex h-[min(680px,calc(100dvh-220px))] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-border bg-surface">
				<ChatSurface
					room={CEO_ROOM}
					active
					emptyState={(send) => (
						<div
							className="flex flex-col items-center gap-4 px-4 py-10 text-center"
							data-testid="ceo-landing-greeting"
						>
							<span className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-surface-3 text-[10px] font-semibold text-text-2">
								CEO
							</span>
							<p className="max-w-md text-[14px] leading-relaxed text-text-1">
								{t('chat.landing.greeting')}
							</p>
							<div className="flex flex-wrap justify-center gap-1.5">
								{starters.map((text) => (
									<button
										key={text}
										type="button"
										data-testid="ceo-landing-starter"
										onClick={() => send(text).catch(() => undefined)}
										className="rounded-full border border-accent px-3 py-1.5 text-[12px] text-accent transition-colors hover:bg-accent-solid hover:text-accent-solid-fg"
									>
										{text}
									</button>
								))}
							</div>
						</div>
					)}
				/>
			</div>
			{/* The dialog path stays one click away for operators who would rather
			    fill in a form than talk it through. */}
			<p className="mt-2 text-center text-[12px] text-text-3">
				<button
					type="button"
					onClick={onCreateProject}
					data-testid="ceo-landing-create-project"
					className="underline-offset-2 hover:text-text-1 hover:underline"
				>
					{t('chat.landing.createProjectLink')}
				</button>
			</p>
		</div>
	);
}
