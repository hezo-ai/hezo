import { Bot, UserRound } from 'lucide-react';
import { Tooltip } from './tooltip';

/**
 * Small icon suffix that flags whether an action was taken by a human admin
 * (via the web UI) or by a connected agent (an approved external MCP client).
 * Roster agents and system/automation actors render nothing — only the
 * human-vs-connected-agent distinction is surfaced.
 *
 * Actor-type values differ by surface: the audit log uses `admin` for humans,
 * while task comments use the member type `user`. Both are treated as human.
 */
export function ActorBadge({
	actorType,
	name,
	className,
}: {
	actorType: string | null | undefined;
	name?: string | null;
	className?: string;
}) {
	if (actorType === 'connected_agent') {
		return (
			<Tooltip
				content={name ? `${name} — connected agent (external MCP client)` : 'Connected agent'}
			>
				<span
					role="img"
					className={`inline-flex items-center align-middle text-text-3 ${className ?? ''}`}
					data-testid="actor-badge-connected-agent"
					aria-label="Connected agent"
				>
					<Bot className="w-3 h-3" aria-hidden="true" />
				</span>
			</Tooltip>
		);
	}
	if (actorType === 'admin' || actorType === 'user') {
		return (
			<Tooltip content={name ? `${name} — human admin (via web)` : 'Human admin (via web)'}>
				<span
					role="img"
					className={`inline-flex items-center align-middle text-text-3 ${className ?? ''}`}
					data-testid="actor-badge-human"
					aria-label="Human admin"
				>
					<UserRound className="w-3 h-3" aria-hidden="true" />
				</span>
			</Tooltip>
		);
	}
	return null;
}
