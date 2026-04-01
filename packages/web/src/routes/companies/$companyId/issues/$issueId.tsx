import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Loader2, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { Textarea } from '../../../../components/ui/textarea';
import { useAgents } from '../../../../hooks/use-agents';
import { useComments, useCreateComment } from '../../../../hooks/use-comments';
import { useExecutionLock } from '../../../../hooks/use-execution-locks';
import {
	useCreateSubIssue,
	useDeleteIssue,
	useIssue,
	useIssueDependencies,
	useRemoveDependency,
	useUpdateIssue,
} from '../../../../hooks/use-issues';

const statusFlow = ['backlog', 'open', 'in_progress', 'review', 'done', 'closed'] as const;
const statusColors: Record<string, string> = {
	backlog: 'gray',
	open: 'blue',
	in_progress: 'purple',
	review: 'yellow',
	blocked: 'red',
	done: 'green',
	closed: 'gray',
	cancelled: 'gray',
};
function IssueDetailPage() {
	const { companyId, issueId } = Route.useParams();
	const { data: issue, isLoading } = useIssue(companyId, issueId);
	const { data: comments } = useComments(companyId, issueId);
	const { data: deps } = useIssueDependencies(companyId, issueId);
	const { data: agents } = useAgents(companyId);
	const { data: lock } = useExecutionLock(companyId, issueId);
	const updateIssue = useUpdateIssue(companyId, issueId);
	const deleteIssue = useDeleteIssue(companyId);
	const createComment = useCreateComment(companyId, issueId);
	const createSubIssue = useCreateSubIssue(companyId, issueId);
	const removeDep = useRemoveDependency(companyId, issueId);
	const [commentText, setCommentText] = useState('');
	const [subIssueTitle, setSubIssueTitle] = useState('');
	const [showSubForm, setShowSubForm] = useState(false);

	if (isLoading || !issue) return <div className="p-6 text-text-muted">Loading...</div>;

	async function handleComment(e: React.FormEvent) {
		e.preventDefault();
		if (!commentText.trim()) return;
		await createComment.mutateAsync({ content: commentText });
		setCommentText('');
	}

	async function handleSubIssue(e: React.FormEvent) {
		e.preventDefault();
		if (!subIssueTitle.trim()) return;
		await createSubIssue.mutateAsync({ title: subIssueTitle });
		setSubIssueTitle('');
		setShowSubForm(false);
	}

	return (
		<div className="p-6 max-w-4xl">
			<Link
				to="/companies/$companyId/issues"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Issues
			</Link>

			<div className="flex gap-6">
				{/* Main content */}
				<div className="flex-1 min-w-0">
					<div className="flex items-start gap-3 mb-4">
						<span className="font-mono text-sm text-text-muted shrink-0">{issue.identifier}</span>
						<h1 className="text-lg font-semibold">{issue.title}</h1>
					</div>

					{lock && (
						<div className="flex items-center gap-2 mb-4 rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs">
							<span className="w-2 h-2 rounded-full bg-info animate-pulse" />
							<span className="text-info font-medium">{lock.member_name}</span>
							<span className="text-text-muted">is working on this issue</span>
							<span className="text-text-subtle ml-auto">
								since {new Date(lock.locked_at).toLocaleTimeString()}
							</span>
						</div>
					)}

					{issue.description && (
						<p className="text-sm text-text-muted mb-6 whitespace-pre-wrap">{issue.description}</p>
					)}

					{/* Sub-issues */}
					{(deps?.length || 0) > 0 && (
						<div className="mb-6">
							<h3 className="text-sm font-medium text-text-muted mb-2">Blocked By</h3>
							<div className="flex flex-col gap-1">
								{deps?.map((d) => (
									<div key={d.id} className="flex items-center gap-2 text-sm">
										<Badge
											color={statusColors[d.blocked_by_status] as 'gray'}
											className="text-[10px]"
										>
											{d.blocked_by_status}
										</Badge>
										<span className="font-mono text-xs text-text-muted">
											{d.blocked_by_identifier}
										</span>
										<span className="text-text">{d.blocked_by_title}</span>
										<button
											type="button"
											onClick={() => removeDep.mutate(d.id)}
											className="text-text-subtle hover:text-danger ml-auto"
										>
											<Trash2 className="w-3 h-3" />
										</button>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Comments */}
					<div className="border-t border-border pt-4">
						<h3 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-1.5">
							<MessageSquare className="w-4 h-4" />
							Comments ({comments?.length ?? 0})
						</h3>
						<div className="flex flex-col gap-3 mb-4">
							{comments?.map((c) => (
								<Card key={c.id} className="p-3">
									<div className="flex items-center gap-2 mb-1.5">
										<span className="text-xs font-medium text-text">{c.author_name}</span>
										<Badge
											color={c.author_type === 'board' ? 'purple' : 'blue'}
											className="text-[10px]"
										>
											{c.author_type}
										</Badge>
										<span className="text-xs text-text-subtle ml-auto">
											{new Date(c.created_at).toLocaleString()}
										</span>
									</div>
									{c.content_type === 'system' ? (
										<p className="text-xs text-text-subtle italic">{c.content}</p>
									) : (
										<p className="text-sm text-text whitespace-pre-wrap">{c.content}</p>
									)}
								</Card>
							))}
						</div>

						<form onSubmit={handleComment} className="flex flex-col gap-2">
							<Textarea
								value={commentText}
								onChange={(e) => setCommentText(e.target.value)}
								placeholder="Add a comment..."
								className="min-h-[60px]"
							/>
							<div className="flex justify-end">
								<Button
									type="submit"
									size="sm"
									disabled={!commentText.trim() || createComment.isPending}
								>
									{createComment.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
									Comment
								</Button>
							</div>
						</form>
					</div>

					{/* Sub-issues */}
					<div className="border-t border-border pt-4 mt-4">
						<div className="flex items-center justify-between mb-2">
							<h3 className="text-sm font-medium text-text-muted">Sub-issues</h3>
							<Button variant="ghost" size="sm" onClick={() => setShowSubForm(!showSubForm)}>
								<Plus className="w-3 h-3" /> Add
							</Button>
						</div>
						{showSubForm && (
							<form onSubmit={handleSubIssue} className="flex gap-2 mb-3">
								<input
									value={subIssueTitle}
									onChange={(e) => setSubIssueTitle(e.target.value)}
									placeholder="Sub-issue title"
									className="flex-1 rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-sm text-text outline-none focus:border-primary"
								/>
								<Button type="submit" size="sm" disabled={!subIssueTitle.trim()}>
									Create
								</Button>
							</form>
						)}
					</div>
				</div>

				{/* Sidebar */}
				<div className="w-56 shrink-0 flex flex-col gap-4">
					<div>
						<span className="text-xs text-text-subtle block mb-1">Status</span>
						<div className="flex flex-wrap gap-1">
							{statusFlow.map((s) => (
								<button
									type="button"
									key={s}
									onClick={() => updateIssue.mutate({ status: s })}
									className={`px-2 py-0.5 rounded text-xs transition-colors cursor-pointer ${
										issue.status === s
											? 'bg-primary text-white'
											: 'bg-bg-muted text-text-muted hover:text-text'
									}`}
								>
									{s.replace('_', ' ')}
								</button>
							))}
						</div>
					</div>

					<label>
						<span className="text-xs text-text-subtle block mb-1">Priority</span>
						<select
							value={issue.priority}
							onChange={(e) => updateIssue.mutate({ priority: e.target.value })}
							className="w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-xs text-text outline-none"
						>
							{['low', 'medium', 'high', 'urgent'].map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</label>

					<label>
						<span className="text-xs text-text-subtle block mb-1">Assignee</span>
						<select
							value={issue.assignee_id ?? ''}
							onChange={(e) => updateIssue.mutate({ assignee_id: e.target.value || null })}
							className="w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-xs text-text outline-none"
						>
							<option value="">Unassigned</option>
							{agents
								?.filter((a) => a.status !== 'terminated')
								.map((a) => (
									<option key={a.id} value={a.id}>
										{a.title}
									</option>
								))}
						</select>
					</label>

					<div>
						<span className="text-xs text-text-subtle block mb-1">Project</span>
						<span className="text-sm text-text">{issue.project_name || '—'}</span>
					</div>

					{issue.progress_summary && (
						<div>
							<span className="text-xs text-text-subtle block mb-1">Progress</span>
							<p className="text-xs text-text-muted">{issue.progress_summary}</p>
						</div>
					)}

					<div className="mt-auto pt-4 border-t border-border-subtle">
						<Button
							variant="ghost"
							size="sm"
							className="text-danger w-full"
							onClick={() => {
								if (confirm('Delete this issue?')) deleteIssue.mutate(issueId);
							}}
						>
							<Trash2 className="w-3 h-3" /> Delete Issue
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/issues/$issueId')({
	component: IssueDetailPage,
});
