import { createFileRoute } from '@tanstack/react-router';
import { ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgentStatusLabel } from '../../../../components/agent-status-label';
import { type CommentData, CommentRenderer } from '../../../../components/comment-renderers';
import { LiveChatPanel } from '../../../../components/live-chat-panel';
import { Avatar, avatarColorFromString } from '../../../../components/ui/avatar';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Textarea } from '../../../../components/ui/textarea';
import { useAgents } from '../../../../hooks/use-agents';
import { useChooseOption, useComments, useCreateComment } from '../../../../hooks/use-comments';
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
	backlog: 'neutral',
	open: 'info',
	in_progress: 'warning',
	review: 'purple',
	blocked: 'danger',
	done: 'success',
	closed: 'neutral',
	cancelled: 'neutral',
};

const priorityColors: Record<string, string> = {
	urgent: 'danger',
	high: 'warning',
	medium: 'info',
	low: 'neutral',
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
	const chooseOption = useChooseOption(companyId, issueId);
	const createSubIssue = useCreateSubIssue(companyId, issueId);
	const removeDep = useRemoveDependency(companyId, issueId);
	const [commentText, setCommentText] = useState('');
	const [subIssueTitle, setSubIssueTitle] = useState('');
	const [showSubForm, setShowSubForm] = useState(false);
	const [activeTab, setActiveTab] = useState<'comments' | 'chat'>('comments');
	const [editingSummary, setEditingSummary] = useState(false);
	const [summaryText, setSummaryText] = useState('');
	const [editingRules, setEditingRules] = useState(false);
	const [rulesText, setRulesText] = useState('');
	const [assigneeOpen, setAssigneeOpen] = useState(false);
	const assigneeRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!assigneeOpen) return;
		function onPointerDown(e: PointerEvent) {
			if (assigneeRef.current && !assigneeRef.current.contains(e.target as Node)) {
				setAssigneeOpen(false);
			}
		}
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [assigneeOpen]);

	const assignedAgent = agents?.find((a) => a.id === issue?.assignee_id);

	if (isLoading || !issue)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

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
		<div className="grid grid-cols-[1fr_190px] gap-5">
			{/* Main content */}
			<div className="min-w-0">
				<div className="mb-1 text-[13px] font-mono text-text-muted">{issue.identifier}</div>
				<h1 className="text-xl font-medium mb-3">{issue.title}</h1>

				<div className="flex flex-wrap gap-1.5 mb-4">
					<Badge color={statusColors[issue.status] as 'neutral'}>
						{issue.status.replace('_', ' ')}
					</Badge>
					<Badge color={priorityColors[issue.priority] as 'neutral'}>{issue.priority}</Badge>
					{issue.project_name && <Badge color="info">{issue.project_name}</Badge>}
				</div>

				<div className="flex flex-wrap gap-1.5 mb-5">
					{statusFlow.map((s) => (
						<button
							type="button"
							key={s}
							onClick={() => updateIssue.mutate({ status: s })}
							className={`px-2.5 py-1 rounded-radius-md text-xs cursor-pointer transition-colors ${
								issue.status === s
									? 'bg-primary text-bg font-medium'
									: 'bg-bg-subtle text-text-muted hover:text-text hover:bg-bg-muted'
							}`}
						>
							{s.replace('_', ' ')}
						</button>
					))}
				</div>

				{lock && (
					<div className="flex items-center gap-2 mb-4 rounded-radius-md bg-accent-blue-bg px-3 py-2 text-xs">
						<span className="w-2 h-2 rounded-full bg-accent-blue animate-pulse" />
						<span className="text-accent-blue-text font-medium">{lock.member_name}</span>
						<span className="text-text-muted">is working on this issue</span>
					</div>
				)}

				<div className="bg-bg-subtle rounded-radius-md p-3 mb-5 text-[13px] text-text-muted leading-relaxed">
					<div className="flex items-center justify-between mb-1">
						<span className="text-[11px] uppercase tracking-wider font-medium text-text-subtle">
							Progress Summary
						</span>
						{!editingSummary && (
							<button
								type="button"
								onClick={() => {
									setSummaryText(issue.progress_summary ?? '');
									setEditingSummary(true);
								}}
								className="text-[11px] text-text-subtle hover:text-text"
							>
								Edit
							</button>
						)}
					</div>
					{editingSummary ? (
						<div className="flex flex-col gap-2">
							<Textarea
								value={summaryText}
								onChange={(e) => setSummaryText(e.target.value)}
								className="min-h-[60px]"
							/>
							<div className="flex gap-2 justify-end">
								<Button size="sm" variant="secondary" onClick={() => setEditingSummary(false)}>
									Cancel
								</Button>
								<Button
									size="sm"
									onClick={() => {
										updateIssue.mutate({
											progress_summary: summaryText || null,
										});
										setEditingSummary(false);
									}}
								>
									Save
								</Button>
							</div>
						</div>
					) : (
						<span>{issue.progress_summary || 'No progress summary yet.'}</span>
					)}
				</div>

				<div className="bg-bg-subtle rounded-radius-md p-3 mb-5 text-[13px] text-text-muted leading-relaxed border-l-2 border-accent-blue">
					<div className="flex items-center justify-between mb-1">
						<span className="text-[11px] uppercase tracking-wider font-medium text-text-subtle">
							Rules
						</span>
						{!editingRules && (
							<button
								type="button"
								onClick={() => {
									setRulesText(issue.rules ?? '');
									setEditingRules(true);
								}}
								className="text-[11px] text-text-subtle hover:text-text"
							>
								Edit
							</button>
						)}
					</div>
					{editingRules ? (
						<div className="flex flex-col gap-2">
							<Textarea
								value={rulesText}
								onChange={(e) => setRulesText(e.target.value)}
								placeholder="e.g., Consult the architect before making changes..."
								className="min-h-[60px]"
							/>
							<div className="flex gap-2 justify-end">
								<Button size="sm" variant="secondary" onClick={() => setEditingRules(false)}>
									Cancel
								</Button>
								<Button
									size="sm"
									onClick={() => {
										updateIssue.mutate({ rules: rulesText || null });
										setEditingRules(false);
									}}
								>
									Save
								</Button>
							</div>
						</div>
					) : (
						<span>{issue.rules || 'No rules set.'}</span>
					)}
				</div>

				{issue.description && (
					<p className="text-[13px] text-text-muted mb-5 whitespace-pre-wrap leading-relaxed">
						{issue.description}
					</p>
				)}

				{/* Blocked by */}
				{(deps?.length || 0) > 0 && (
					<div className="mb-5">
						<h3 className="text-xs font-medium uppercase tracking-wider text-text-muted mb-2">
							Blocked By
						</h3>
						<div className="flex flex-col gap-1">
							{deps?.map((d) => (
								<div key={d.id} className="flex items-center gap-2 text-[13px]">
									<Badge color={statusColors[d.blocked_by_status] as 'neutral'}>
										{d.blocked_by_status}
									</Badge>
									<span className="font-mono text-xs text-text-muted">
										{d.blocked_by_identifier}
									</span>
									<span>{d.blocked_by_title}</span>
									<button
										type="button"
										onClick={() => removeDep.mutate(d.id)}
										className="text-text-subtle hover:text-accent-red ml-auto"
									>
										<Trash2 className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Comments / Chat tabs */}
				<div className="border-t border-border pt-4">
					<div className="flex border-b border-border mb-4">
						<button
							type="button"
							onClick={() => setActiveTab('comments')}
							className={`px-4 py-2 text-[13px] border-b-2 transition-colors ${
								activeTab === 'comments'
									? 'text-text font-medium border-text'
									: 'text-text-muted border-transparent hover:text-text'
							}`}
						>
							Comments
							<span className="ml-1.5 bg-bg-subtle px-[7px] py-px rounded-full text-[11px] font-normal">
								{comments?.length ?? 0}
							</span>
						</button>
						<button
							type="button"
							onClick={() => setActiveTab('chat')}
							className={`px-4 py-2 text-[13px] border-b-2 transition-colors ${
								activeTab === 'chat'
									? 'text-text font-medium border-text'
									: 'text-text-muted border-transparent hover:text-text'
							}`}
						>
							Live chat
						</button>
					</div>

					{activeTab === 'comments' ? (
						<>
							<div className="flex flex-col gap-4 mb-4">
								{comments?.map((c) => (
									<div key={c.id} className="flex gap-2.5">
										<Avatar
											initials={c.author_name?.slice(0, 2) ?? '??'}
											size="sm"
											color={avatarColorFromString(c.author_name ?? 'unknown')}
										/>
										<div className="flex-1 min-w-0">
											<div className="flex items-center gap-2 mb-1">
												<span className="text-xs font-medium">{c.author_name}</span>
												<span className="text-[11px] text-text-subtle">
													{new Date(c.created_at).toLocaleString()}
												</span>
											</div>
											<CommentRenderer
												comment={c as unknown as CommentData}
												onChooseOption={(commentId, chosenId) =>
													chooseOption.mutate({ commentId, chosen_id: chosenId })
												}
												companyId={companyId}
											/>
										</div>
									</div>
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
						</>
					) : (
						<div className="h-80 border border-border rounded-radius-lg overflow-hidden">
							<LiveChatPanel
								companyId={companyId}
								issueId={issueId}
								agents={agents?.map((a) => ({ slug: a.slug, title: a.title })) ?? []}
							/>
						</div>
					)}
				</div>

				{/* Sub-issues */}
				<div className="border-t border-border pt-4 mt-4">
					<div className="flex items-center justify-between mb-2">
						<h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
							Sub-issues
						</h3>
						<Button variant="secondary" size="sm" onClick={() => setShowSubForm(!showSubForm)}>
							<Plus className="w-3 h-3" /> Add
						</Button>
					</div>
					{showSubForm && (
						<form onSubmit={handleSubIssue} className="flex gap-2 mb-3">
							<input
								value={subIssueTitle}
								onChange={(e) => setSubIssueTitle(e.target.value)}
								placeholder="Sub-issue title"
								className="flex-1 rounded-radius-md border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none focus:border-border-hover"
							/>
							<Button type="submit" size="sm" disabled={!subIssueTitle.trim()}>
								Create
							</Button>
						</form>
					)}
				</div>
			</div>

			{/* Sidebar */}
			<div className="flex flex-col gap-4 text-xs">
				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Priority
					</span>
					<select
						value={issue.priority}
						onChange={(e) => updateIssue.mutate({ priority: e.target.value })}
						className="w-full rounded-radius-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
					>
						{['low', 'medium', 'high', 'urgent'].map((p) => (
							<option key={p} value={p}>
								{p}
							</option>
						))}
					</select>
				</div>

				<div ref={assigneeRef} className="relative">
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Assignee
					</span>
					<button
						type="button"
						onClick={() => setAssigneeOpen((o) => !o)}
						className="flex items-center gap-1 w-full text-left text-[13px] text-text rounded-radius-md hover:bg-bg-subtle px-1 py-0.5 transition-colors"
					>
						<AgentStatusLabel
							name={assignedAgent?.title ?? '—'}
							runtimeStatus={assignedAgent?.runtime_status ?? 'idle'}
							className="flex-1 min-w-0"
						/>
						<ChevronDown
							className={`w-3.5 h-3.5 text-text-subtle shrink-0 transition-transform ${assigneeOpen ? 'rotate-180' : ''}`}
						/>
					</button>
					{assigneeOpen && (
						<div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-radius-md border border-border bg-bg shadow-md max-h-48 overflow-y-auto">
							{agents
								?.filter((a) => a.admin_status !== 'terminated')
								.map((a) => (
									<button
										type="button"
										key={a.id}
										onClick={() => {
											updateIssue.mutate({ assignee_id: a.id });
											setAssigneeOpen(false);
										}}
										className={`flex items-center w-full px-2.5 py-1.5 text-xs text-left hover:bg-bg-subtle transition-colors ${
											a.id === issue.assignee_id ? 'bg-bg-subtle font-medium' : ''
										}`}
									>
										<AgentStatusLabel name={a.title} runtimeStatus={a.runtime_status} />
									</button>
								))}
						</div>
					)}
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Project
					</span>
					<span className="text-[13px] text-text">{issue.project_name || '—'}</span>
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Created
					</span>
					<span className="text-[13px] text-text">
						{new Date(issue.created_at).toLocaleDateString()}
					</span>
				</div>

				<div className="mt-auto pt-4 border-t border-border">
					<Button
						variant="danger-text"
						size="sm"
						className="w-full"
						onClick={() => {
							if (confirm('Delete this issue?')) deleteIssue.mutate(issueId);
						}}
					>
						<Trash2 className="w-3 h-3" /> Delete Issue
					</Button>
				</div>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/issues/$issueId')({
	component: IssueDetailPage,
});
