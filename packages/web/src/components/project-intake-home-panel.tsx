import { CommentContentType } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Loader2, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useComments, useCreateComment } from '../hooks/use-comments';
import type { ProjectIntake } from '../hooks/use-project-intake';
import { CaptainIntakeChat } from './captain-intake-chat';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Textarea } from './ui/textarea';

interface ProjectIntakeHomePanelProps {
	intake: ProjectIntake;
}

/**
 * The CEO-assisted project-intake conversation surfaced on the home view. The
 * thread itself lives in the HQ project; the admin chats with the CEO to scope
 * the project. The CEO creates the project and its team once the admin approves
 * here in the conversation.
 */
export function ProjectIntakeHomePanel({ intake }: ProjectIntakeHomePanelProps) {
	const projectId = intake.project_slug;
	const taskId = intake.task_identifier.toLowerCase();
	const createComment = useCreateComment(projectId, taskId);
	const { data: comments } = useComments(projectId, taskId);
	const [message, setMessage] = useState('');
	const [awaitingReply, setAwaitingReply] = useState(false);

	const lastChatMessage = useMemo(() => {
		const textComments = (comments ?? []).filter((c) => c.content_type === CommentContentType.Text);
		return textComments[textComments.length - 1];
	}, [comments]);

	useEffect(() => {
		if (lastChatMessage?.author_type === 'agent') {
			setAwaitingReply(false);
		}
	}, [lastChatMessage]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const text = message.trim();
		if (!text) return;
		setMessage('');
		setAwaitingReply(true);
		try {
			await createComment.mutateAsync({ content: text, wake_assignee: true });
		} catch {
			setAwaitingReply(false);
		}
	}

	return (
		<Card className="overflow-hidden" data-testid="home-project-intake">
			<div className="flex flex-col gap-3 p-4 md:p-5">
				<div className="flex items-center justify-between gap-2 border-b border-border pb-3">
					<span className="text-[13px] font-medium text-text-1">{intake.ceo_title}</span>
					<Link
						to="/projects/$projectId/tasks/$taskId"
						params={{ projectId, taskId }}
						className="text-xs text-info hover:underline shrink-0"
					>
						Open full thread
					</Link>
				</div>

				<CaptainIntakeChat
					projectSlug={projectId}
					taskIdentifier={taskId}
					captainTitle={intake.ceo_title}
					awaitingCaptainReply={awaitingReply}
				/>

				<form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
					<Textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						placeholder="Tell the CEO what you're looking to achieve…"
						rows={3}
						className="min-h-[80px] resize-y"
						data-testid="home-project-intake-input"
					/>
					<div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-end">
						<Button type="submit" disabled={!message.trim() || createComment.isPending}>
							{createComment.isPending ? (
								<Loader2 className="w-4 h-4 animate-spin" />
							) : (
								<Send className="w-4 h-4" />
							)}
							Send
						</Button>
					</div>
				</form>
			</div>
		</Card>
	);
}
