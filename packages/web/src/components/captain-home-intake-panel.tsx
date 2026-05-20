import { CommentContentType } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Loader2, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useComments, useCreateComment } from '../hooks/use-comments';
import { CaptainIntakeChat } from './captain-intake-chat';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Textarea } from './ui/textarea';

export interface CaptainHomeIntake {
	issue_id: string;
	issue_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_title: string;
	/** Distinguishes requirements vs hire-team for copy and test ids */
	kind: 'requirements' | 'hire-team';
}

interface CaptainHomeIntakePanelProps {
	teamId: string;
	intake: CaptainHomeIntake;
}

export function CaptainHomeIntakePanel({ teamId, intake }: CaptainHomeIntakePanelProps) {
	const issueId = intake.issue_identifier.toLowerCase();
	const createComment = useCreateComment(teamId, issueId);
	const { data: comments } = useComments(teamId, issueId);
	const [message, setMessage] = useState('');
	const [awaitingCaptainReply, setAwaitingCaptainReply] = useState(false);

	const issueLinkParams = {
		teamId,
		projectId: intake.project_slug,
		issueId,
	};

	const testId = intake.kind === 'hire-team' ? 'home-captain-hire-team' : 'home-captain-intake';

	const placeholder =
		intake.kind === 'hire-team'
			? 'Reply to confirm the proposed team structure, or ask questions…'
			: "Tell the Captain what you're looking to achieve…";

	const lastChatMessage = useMemo(() => {
		const textComments = (comments ?? []).filter((c) => c.content_type === CommentContentType.Text);
		return textComments[textComments.length - 1];
	}, [comments]);

	useEffect(() => {
		if (lastChatMessage?.author_type === 'agent') {
			setAwaitingCaptainReply(false);
		}
	}, [lastChatMessage]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const text = message.trim();
		if (!text) return;
		setMessage('');
		setAwaitingCaptainReply(true);
		try {
			await createComment.mutateAsync({
				content: text,
				wake_assignee: true,
			});
		} catch {
			setAwaitingCaptainReply(false);
		}
	}

	return (
		<Card className="overflow-hidden" data-testid={testId}>
			<div className="flex flex-col gap-3 p-4 md:p-5">
				<div className="flex items-center justify-between gap-2 border-b border-border pb-3">
					<span className="text-[13px] font-medium text-text">
						{intake.kind === 'hire-team' ? 'Hire the team' : intake.captain_title}
					</span>
					<Link
						to="/teams/$teamId/projects/$projectId/issues/$issueId"
						params={issueLinkParams}
						className="text-xs text-accent-blue hover:underline shrink-0"
					>
						Open full thread
					</Link>
				</div>

				<CaptainIntakeChat
					teamSlug={teamId}
					issueIdentifier={issueId}
					captainTitle={intake.captain_title}
					awaitingCaptainReply={awaitingCaptainReply}
				/>

				<form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
					<Textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						placeholder={placeholder}
						rows={3}
						className="min-h-[80px] resize-y"
						data-testid={`${testId}-input`}
					/>
					<div className="flex justify-end">
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
