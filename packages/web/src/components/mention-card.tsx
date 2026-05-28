import type { BoardMentionItem } from '@hezo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { MessageSquare } from 'lucide-react';
import { useMarkMentionRead } from '../hooks/use-board-mentions';
import { Badge } from './ui/badge';

interface MentionCardProps {
	mention: BoardMentionItem;
	showTeam?: boolean;
}

const baseCardClass = 'block p-4 border border-border rounded-radius-md text-left w-full';
const linkCardClass = `${baseCardClass} hover:bg-bg-subtle transition-colors`;

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
			markRead.mutate({ teamSlug: mention.team_slug, mentionId: mention.id });
		}
		navigate({
			to: '/teams/$teamId/tasks/$taskId' as never,
			params: {
				teamId: mention.team_slug,
				taskId: mention.task_identifier.toLowerCase(),
			} as never,
			hash: `comment-${mention.comment_id}`,
		});
	};

	const author = mention.author_slug ? `@${mention.author_slug}` : mention.author_display_name;

	return (
		<button
			type="button"
			onClick={handleClick}
			className={linkCardClass}
			data-testid="mention-card"
		>
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				<Badge color="blue">
					<MessageSquare className="w-3 h-3 mr-1 inline" />
					mention
				</Badge>
				{showTeam && <span className="text-xs text-text-muted">{mention.team_slug}</span>}
				<span className="text-xs text-text-muted">{relativeTime(mention.created_at)}</span>
			</div>
			<p className="text-xs text-text-muted mb-1">
				<span className="font-medium">{author}</span> asked you on{' '}
				<Link
					to={'/teams/$teamId/tasks/$taskId' as never}
					params={
						{
							teamId: mention.team_slug,
							taskId: mention.task_identifier.toLowerCase(),
						} as never
					}
					className="font-medium text-accent-blue-text hover:underline"
					onClick={(e) => e.stopPropagation()}
				>
					{mention.task_identifier}
				</Link>
			</p>
			{mention.snippet && (
				<p className="text-sm text-text-subtle break-words line-clamp-3">{mention.snippet}</p>
			)}
		</button>
	);
}
