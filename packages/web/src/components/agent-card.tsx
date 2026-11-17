import { TOOLTIP_Z } from '@hezo/ui';
import * as Popover from '@radix-ui/react-popover';
import { Link } from '@tanstack/react-router';
import { ChevronRight, MessageSquare, UserRound } from 'lucide-react';
import {
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';
import { useLaunchChat } from '../contexts/chat-launch-context';
import { useAgentLookup } from '../hooks/use-agent-lookup';
import { agentChatRoom } from '../hooks/use-chat';
import { useProjectMeta } from '../hooks/use-projects';
import { agentAvatarUrl } from '../lib/agent-avatar';
import { useI18n } from '../lib/i18n';
import { agentRuntimeStatusMeta } from '../lib/status-meta';
import { agentDisplayName } from './agent-identity-tooltip';
import { agentPageParams } from './agent-link';
import { Avatar, getInitials } from './ui/avatar';
import { Badge } from './ui/badge';

/** What the card shows. `slug` is required: both of its actions address the agent by it. */
export interface AgentCardIdentity {
	slug: string;
	human_name?: string | null;
	title?: string | null;
	role_description?: string | null;
	is_instance?: boolean;
	avatar_spec?: unknown;
	/** Shown as a status badge when the caller has it. */
	runtime_status?: string | null;
}

/** Hover delays, matching the tooltip provider's open delay so the two feel alike. */
const OPEN_DELAY_MS = 150;
/** Long enough to cross the gap from the name to the card without it closing. */
const CLOSE_DELAY_MS = 200;

const ACTION =
	'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-text-1 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none';

interface AgentCardProps {
	agent: AgentCardIdentity;
	/** The current project's slug. HQ agents' page links re-point to HQ. */
	projectId: string;
	children: ReactNode;
	className?: string;
	testId?: string;
	/** Extra `data-*` attributes for the name link, e.g. a mention's passive flag. */
	dataAttributes?: Record<`data-${string}`, string | undefined>;
}

/**
 * An agent's name that opens a small card instead of navigating: the agent's
 * identity, then a link to its page and a shortcut to chat with it.
 *
 * The name stays a real link to the agent's page, so a modified or middle
 * click still opens the page in a new tab. A plain click opens the card and
 * pins it; a mouse resting on the name opens it unpinned, and it closes again
 * when the pointer leaves both the name and the card. Touch has no hover, so a
 * tap is the click that opens it.
 *
 * Clicks are stopped at the name and at the card: React bubbles a portal's
 * events to its React ancestors, and several names sit inside clickable rows.
 */
export function AgentCard({
	agent,
	projectId,
	children,
	className,
	testId,
	dataAttributes,
}: AgentCardProps) {
	const [open, setOpen] = useState(false);
	// Opened by a click: the pointer leaving no longer closes it.
	const pinned = useRef(false);
	// Opened from the keyboard: focus moves into the card, and back on close.
	const viaKeyboard = useRef(false);
	const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const clearTimers = useCallback(() => {
		clearTimeout(openTimer.current);
		clearTimeout(closeTimer.current);
	}, []);
	useEffect(() => clearTimers, [clearTimers]);

	const close = useCallback(() => {
		clearTimers();
		pinned.current = false;
		setOpen(false);
	}, [clearTimers]);

	const hoverIn = (e: PointerEvent) => {
		if (e.pointerType !== 'mouse') return;
		clearTimeout(closeTimer.current);
		if (open) return;
		openTimer.current = setTimeout(() => {
			viaKeyboard.current = false;
			setOpen(true);
		}, OPEN_DELAY_MS);
	};
	const hoverOut = (e: PointerEvent) => {
		if (e.pointerType !== 'mouse') return;
		clearTimeout(openTimer.current);
		if (pinned.current) return;
		closeTimer.current = setTimeout(close, CLOSE_DELAY_MS);
	};

	const onNameClick = (e: MouseEvent<HTMLAnchorElement>) => {
		e.stopPropagation();
		// A modified or middle click keeps the browser's own link behaviour.
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		if (open && pinned.current) {
			close();
			return;
		}
		clearTimers();
		pinned.current = true;
		// A keyboard-activated click has no pointer position.
		viaKeyboard.current = e.detail === 0;
		setOpen(true);
	};

	const name = agentDisplayName(agent) || agent.slug;
	const pageParams = agentPageParams(projectId, agent.slug, agent.is_instance);

	return (
		<Popover.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) close();
			}}
		>
			<Popover.Trigger asChild>
				<Link
					to="/projects/$projectId/agents/$agentId"
					params={pageParams}
					className={className}
					data-testid={testId}
					onClick={onNameClick}
					onPointerEnter={hoverIn}
					onPointerLeave={hoverOut}
					{...dataAttributes}
				>
					{children}
				</Link>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={8}
					aria-label={name}
					data-testid="agent-card"
					onOpenAutoFocus={(e) => {
						if (!viaKeyboard.current) e.preventDefault();
					}}
					onCloseAutoFocus={(e) => {
						if (!viaKeyboard.current) e.preventDefault();
					}}
					onPointerEnter={hoverIn}
					onPointerLeave={hoverOut}
					onClick={(e) => e.stopPropagation()}
					className={`${TOOLTIP_Z} w-[min(18rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface text-text-1 shadow-md outline-none`}
				>
					<AgentCardBody agent={agent} projectId={projectId} onClose={close} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/**
 * The card's content. Mounted only while the card is open, so the roster
 * lookup below costs nothing for the many names on a page that stay closed.
 * The live roster entry wins over what the caller passed: a mention or a system
 * note carries only what was baked into it, without status or avatar.
 */
function AgentCardBody({
	agent: passed,
	projectId,
	onClose,
}: {
	agent: AgentCardIdentity;
	projectId: string;
	onClose: () => void;
}) {
	const { t } = useI18n();
	const { bySlug } = useAgentLookup(projectId);
	const live = bySlug.get(passed.slug);
	const agent: AgentCardIdentity = live ? { ...passed, ...live } : passed;

	const name = agentDisplayName(agent) || agent.slug;
	const role = agent.title?.trim();
	const description = agent.role_description?.trim();
	const status = agent.runtime_status ? agentRuntimeStatusMeta(agent.runtime_status) : null;

	const launchChat = useLaunchChat();
	const projectUuid = useProjectMeta(projectId)?.id;
	const chatRoom = agentChatRoom(agent, projectId, projectUuid);
	const pageParams = agentPageParams(projectId, agent.slug, agent.is_instance);

	return (
		<>
			<div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
				<Avatar
					initials={getInitials(name)}
					imageUrl={agentAvatarUrl(agent)}
					size="sm"
					className="shrink-0"
				/>
				<div className="min-w-0 space-y-1">
					<p className="text-[12px] font-semibold leading-tight">{name}</p>
					{role && role !== name && <p className="text-[11px] leading-snug text-text-2">{role}</p>}
					{description && <p className="text-[11px] leading-relaxed text-text-2">{description}</p>}
					{status && (
						<Badge color={status.color} testId="agent-card-status">
							{status.label}
						</Badge>
					)}
				</div>
			</div>
			<div className="border-t border-border p-1">
				<Link
					to="/projects/$projectId/agents/$agentId"
					params={pageParams}
					onClick={onClose}
					className={ACTION}
					data-testid="agent-card-page-link"
				>
					<UserRound className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
					<span className="min-w-0 flex-1 truncate">{t('agents.card.openPage')}</span>
					<ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
				</Link>
				{chatRoom && (
					<button
						type="button"
						onClick={() => {
							onClose();
							launchChat({ room: chatRoom, draft: '' });
						}}
						className={ACTION}
						data-testid="agent-card-chat"
					>
						<MessageSquare className="h-3.5 w-3.5 shrink-0 text-text-3" aria-hidden />
						<span className="min-w-0 flex-1 truncate">{t('agents.card.chatWith', { name })}</span>
					</button>
				)}
			</div>
		</>
	);
}
