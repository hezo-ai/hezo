import { CommentContentType, ONBOARDING_INTAKE_SKIP_SIGNAL_TEXT } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { FastForward, Loader2, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useComments, useCreateComment } from '../hooks/use-comments';
import { useSkipOnboardingQuestions } from '../hooks/use-onboarding-intake';
import { CaptainIntakeChat } from './captain-intake-chat';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Textarea } from './ui/textarea';

function commentTextEquals(content: unknown, target: string): boolean {
	if (typeof content === 'string') {
		if (content === target) return true;
		try {
			const parsed = JSON.parse(content) as { text?: unknown };
			return parsed?.text === target;
		} catch {
			return false;
		}
	}
	if (typeof content === 'object' && content !== null && 'text' in content) {
		return (content as { text?: unknown }).text === target;
	}
	return false;
}

export interface CaptainHomeIntake {
	task_id: string;
	task_identifier: string;
	project_slug: string;
	captain_greeting: string;
	captain_title: string;
}

interface CaptainHomeIntakePanelProps {
	teamId: string;
	intake: CaptainHomeIntake;
}

export function CaptainHomeIntakePanel({ teamId, intake }: CaptainHomeIntakePanelProps) {
	const taskId = intake.task_identifier.toLowerCase();
	const createComment = useCreateComment(teamId, taskId);
	const { data: comments } = useComments(teamId, taskId);
	const skipQuestions = useSkipOnboardingQuestions(teamId);
	const [message, setMessage] = useState('');
	const [awaitingCaptainReply, setAwaitingCaptainReply] = useState(false);

	const taskLinkParams = { teamId, projectId: intake.project_slug, taskId };

	const lastChatMessage = useMemo(() => {
		const textComments = (comments ?? []).filter((c) => c.content_type === CommentContentType.Text);
		return textComments[textComments.length - 1];
	}, [comments]);

	const skipSignaled = useMemo(
		() =>
			(comments ?? []).some(
				(c) =>
					c.content_type === CommentContentType.System &&
					c.author_member_id === null &&
					commentTextEquals(c.content, ONBOARDING_INTAKE_SKIP_SIGNAL_TEXT),
			),
		[comments],
	);

	const showSkip = !skipSignaled && !skipQuestions.isSuccess;

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
			await createComment.mutateAsync({ content: text, wake_assignee: true });
		} catch {
			setAwaitingCaptainReply(false);
		}
	}

	async function handleSkip() {
		setAwaitingCaptainReply(true);
		try {
			await skipQuestions.mutateAsync();
		} catch {
			setAwaitingCaptainReply(false);
		}
	}

	return (
		<Card className="overflow-hidden" data-testid="home-captain-intake">
			<div className="flex flex-col gap-3 p-4 md:p-5">
				<div className="flex items-center justify-between gap-2 border-b border-border pb-3">
					<span className="text-[13px] font-medium text-text">{intake.captain_title}</span>
					<Link
						to="/teams/$teamId/projects/$projectId/tasks/$taskId"
						params={taskLinkParams}
						className="text-xs text-accent-blue hover:underline shrink-0"
					>
						Open full thread
					</Link>
				</div>

				<CaptainIntakeChat
					teamSlug={teamId}
					taskIdentifier={taskId}
					captainTitle={intake.captain_title}
					awaitingCaptainReply={awaitingCaptainReply}
				/>

				<form onSubmit={handleSubmit} className="flex flex-col gap-2 border-t border-border pt-3">
					<Textarea
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						placeholder="Tell the Captain what you're looking to achieve…"
						rows={3}
						className="min-h-[80px] resize-y"
						data-testid="home-captain-intake-input"
					/>
					<div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-end">
						{showSkip && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={handleSkip}
								disabled={skipQuestions.isPending}
								className="sm:mr-auto"
								data-testid="home-captain-intake-skip"
							>
								{skipQuestions.isPending ? (
									<Loader2 className="w-3 h-3 animate-spin" />
								) : (
									<FastForward className="w-3 h-3" />
								)}
								Skip questions — propose now
							</Button>
						)}
						<Button type="submit" disabled={!message.trim() || createComment.isPending}>
							{createComment.isPending ? (
								<Loader2 className="w-4 h-4 animate-spin" />
							) : (
								<Send className="w-4 h-4" />
							)}
							Send
						</Button>
					</div>
					{showSkip && skipQuestions.error && (
						<p className="text-[12px] text-accent-red">
							{(skipQuestions.error as { message?: string }).message ||
								'Could not signal Captain — try again.'}
						</p>
					)}
				</form>
			</div>
		</Card>
	);
}
