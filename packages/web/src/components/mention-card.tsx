import type { AdminMentionItem } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMarkMentionRead } from '../hooks/use-admin-mentions';
import { agentAvatarUrl } from '../lib/agent-avatar';
import { formatDateTime, formatRelativeTime } from '../lib/format-date';
import { inboxRowKind, inboxRowLead } from '../lib/inbox-row-kind';
import { Avatar, getInitials } from './ui/avatar';
import { Badge } from './ui/badge';

interface MentionCardProps {
	mention: AdminMentionItem;
	showTeam?: boolean;
}

const baseCardClass = 'block p-4 border border-border rounded-md text-left w-full';
const linkCardClass = `${baseCardClass} hover:bg-surface-2 transition-colors`;

export function MentionCard({ mention, showTeam = false }: MentionCardProps) {
	const navigate = useNavigate();
	const markRead = useMarkMentionRead();

	const handleClick = (e: React.MouseEvent) => {
		e.preventDefault();
		if (!mention.read_at) {
			markRead.mutate({ projectSlug: mention.project_slug, mentionId: mention.id });
		}
		navigate({
			to: '/projects/$projectId/tasks/$taskId' as never,
			params: {
				projectId: mention.project_slug,
				taskId: mention.task_identifier.toLowerCase(),
			} as never,
			hash: `comment-${mention.comment_public_id}`,
		});
	};

	const author = mention.author_slug ? `@${mention.author_slug}` : mention.author_display_name;
	const unread = !mention.read_at;
	// A credential request is an inbox row too - same read/archive semantics, its
	// own badge and verb. Clicking still lands on the comment, where the paste
	// form lives.
	const kind = inboxRowKind(mention.content_type);
	const lead = inboxRowLead(mention);

	const stateClass = unread
		? ' border-l-4 border-l-accent bg-accent-soft shadow-sm'
		: ' border-l-4 border-l-transparent bg-transparent opacity-65 hover:opacity-100';

	return (
		<button
			type="button"
			onClick={handleClick}
			className={`${linkCardClass}${stateClass}`}
			data-testid="mention-card"
			data-unread={unread}
		>
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				{unread && (
					<span
						role="img"
						aria-label="Unread"
						className="w-2.5 h-2.5 rounded-full bg-accent shrink-0"
					/>
				)}
				<Badge variant="dot" color={kind.tagColor}>
					{kind.tag}
				</Badge>
				{showTeam && <span className="text-xs text-text-2">{mention.team_slug}</span>}
				<time
					dateTime={mention.created_at}
					title={formatDateTime(mention.created_at)}
					className="text-xs text-text-2"
				>
					{formatRelativeTime(mention.created_at)}
				</time>
			</div>
			{/* A div, not a p: Avatar renders a div and cannot legally nest in a p. */}
			<div className={`text-xs mb-1 ${unread ? 'text-text-1' : 'text-text-2'}`}>
				<Avatar
					size="sm"
					initials={getInitials(mention.author_display_name)}
					imageUrl={
						mention.author_icon_url ??
						agentAvatarUrl({ slug: mention.author_slug, avatar_spec: mention.author_avatar_spec })
					}
					className="mr-1.5 align-middle"
				/>
				<span className={`align-middle ${unread ? 'font-semibold' : 'font-medium'}`}>{author}</span>{' '}
				{lead ? <>needs you to {lead} on </> : <>asked you on </>}
				<Link
					to={'/projects/$projectId/tasks/$taskId' as never}
					params={
						{
							projectId: mention.project_slug,
							taskId: mention.task_identifier.toLowerCase(),
						} as never
					}
					className="font-medium text-accent hover:underline"
					onClick={(e) => e.stopPropagation()}
				>
					{mention.task_identifier}
				</Link>
			</div>
			{mention.snippet && (
				<p className="text-sm text-text-3 break-words line-clamp-3">{mention.snippet}</p>
			)}
		</button>
	);
}
