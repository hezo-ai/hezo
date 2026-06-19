import type { AdminMentionItem } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMarkMentionRead } from '../hooks/use-admin-mentions';
import { Badge } from './ui/badge';

interface MentionCardProps {
	mention: AdminMentionItem;
	showTeam?: boolean;
}

const baseCardClass = 'block p-4 border border-border rounded-md text-left w-full';
const linkCardClass = `${baseCardClass} hover:bg-surface-2 transition-colors`;

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return '';
	const diff = Date.now() - then;
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

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

	return (
		<button
			type="button"
			onClick={handleClick}
			className={`${linkCardClass}${unread ? ' border-l-2 border-l-accent bg-surface-2' : ''}`}
			data-testid="mention-card"
			data-unread={unread}
		>
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				{unread && (
					<span
						role="img"
						aria-label="Unread"
						className="w-2 h-2 rounded-full bg-inverse shrink-0"
					/>
				)}
				<Badge variant="dot" color="info">
					mention
				</Badge>
				{showTeam && <span className="text-xs text-text-2">{mention.team_slug}</span>}
				<span className="text-xs text-text-2">{relativeTime(mention.created_at)}</span>
			</div>
			<p className="text-xs text-text-2 mb-1">
				<span className="font-medium">{author}</span> asked you on{' '}
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
			</p>
			{mention.snippet && (
				<p className="text-sm text-text-3 break-words line-clamp-3">{mention.snippet}</p>
			)}
		</button>
	);
}
