import {
	AgentEffort,
	CEO_AGENT_SLUG,
	DEFAULT_EFFORT,
	IssueStatus,
	OPERATIONS_PROJECT_SLUG,
} from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, Info, Loader2, Plus, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { AgentStatusLabel } from '../../../../../../components/agent-status-label';
import { type CommentData, CommentRenderer } from '../../../../../../components/comment-renderers';
import { MarkdownProse } from '../../../../../../components/markdown-prose';
import { MentionTextarea } from '../../../../../../components/mention-textarea';
import { Avatar, avatarColorFromString } from '../../../../../../components/ui/avatar';
import { Badge } from '../../../../../../components/ui/badge';
import { Button } from '../../../../../../components/ui/button';
import { ConfirmDialog } from '../../../../../../components/ui/confirm-dialog';
import { Tooltip } from '../../../../../../components/ui/tooltip';
import { useAgents } from '../../../../../../hooks/use-agents';
import {
	useChooseOption,
	useComments,
	useCreateComment,
} from '../../../../../../hooks/use-comments';
import { type ExecutionLock, useExecutionLock } from '../../../../../../hooks/use-execution-locks';
import {
	useCreateSubIssue,
	useIssue,
	useIssueDependencies,
	useIssues,
	useRemoveDependency,
	useUpdateIssue,
} from '../../../../../../hooks/use-issues';

const statusColors: Record<string, string> = {
	backlog: 'neutral',
	in_progress: 'warning',
	review: 'purple',
	approved: 'success',
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

const EFFORT_LEVELS: { value: AgentEffort; label: string }[] = [
	{ value: AgentEffort.Minimal, label: 'Minimal' },
	{ value: AgentEffort.Low, label: 'Low' },
	{ value: AgentEffort.Medium, label: 'Medium' },
	{ value: AgentEffort.High, label: 'High' },
	{ value: AgentEffort.Max, label: 'Max (ultrathink)' },
];

function IssueDetailPage() {
	const { companyId, projectId, issueId } = Route.useParams();
	const navigate = useNavigate();
	const { data: issue, isLoading } = useIssue(companyId, issueId);

	useEffect(() => {
		if (!issue?.identifier || !issue?.project_slug) return;
		const friendlyId = issue.identifier.toLowerCase();
		const canonicalProject = issue.project_slug;
		const needsIdNormalization = UUID_RE.test(issueId) && issueId !== friendlyId;
		const needsProjectNormalization = projectId !== canonicalProject;
		if (needsIdNormalization || needsProjectNormalization) {
			navigate({
				to: '/companies/$companyId/projects/$projectId/issues/$issueId',
				params: { companyId, projectId: canonicalProject, issueId: friendlyId },
				replace: true,
			});
		}
	}, [issue?.identifier, issue?.project_slug, issueId, projectId, companyId, navigate]);
	const { data: comments } = useComments(companyId, issueId);
	const { data: deps } = useIssueDependencies(companyId, issueId);
	const { data: subIssues } = useIssues(
		companyId,
		issue?.id ? { parent_issue_id: issue.id } : undefined,
		{ enabled: !!issue?.id },
	);
	const { data: agents } = useAgents(companyId);
	const { data: lock } = useExecutionLock(companyId, issueId);
	const updateIssue = useUpdateIssue(companyId, issueId);
	const createComment = useCreateComment(companyId, issueId);
	const chooseOption = useChooseOption(companyId, issueId);
	const createSubIssue = useCreateSubIssue(companyId, issueId);
	const removeDep = useRemoveDependency(companyId, issueId);
	const [commentText, setCommentText] = useState('');
	// Per-comment reasoning effort. `null` = user hasn't touched the dropdown, so
	// leave effort unset on submit and let the server resolve the agent default.
	const [commentEffort, setCommentEffort] = useState<AgentEffort | null>(null);
	const [wakeAssignee, setWakeAssignee] = useState(true);
	const [subIssueTitle, setSubIssueTitle] = useState('');
	const [showSubForm, setShowSubForm] = useState(false);
	const [subIssuesOpen, setSubIssuesOpen] = useState(false);
	const [editingSummary, setEditingSummary] = useState(false);
	const [summaryText, setSummaryText] = useState('');
	const [editingRules, setEditingRules] = useState(false);
	const [rulesText, setRulesText] = useState('');
	const [assigneeOpen, setAssigneeOpen] = useState(false);
	const [closeOpen, setCloseOpen] = useState(false);
	const [reopenOpen, setReopenOpen] = useState(false);
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

	useEffect(() => {
		if (!comments || comments.length === 0) return;
		if (typeof window === 'undefined') return;
		if (window.location.hash !== '#setup-repo') return;
		const target = document.querySelector('[data-setup-repo-anchor]');
		if (!target) return;
		target.scrollIntoView({ behavior: 'smooth', block: 'center' });
		window.history.replaceState(null, '', window.location.pathname + window.location.search);
	}, [comments]);

	const assignedAgent = agents?.find((a) => a.id === issue?.assignee_id);
	const effectiveDefaultEffort: AgentEffort =
		assignedAgent?.slug === CEO_AGENT_SLUG
			? AgentEffort.Max
			: (assignedAgent?.default_effort ?? DEFAULT_EFFORT);
	const isOperationsProject = issue?.project_slug === OPERATIONS_PROJECT_SLUG;
	const assigneeOptions = agents
		?.filter((a) => a.admin_status !== 'disabled')
		.filter((a) => !isOperationsProject || a.slug === CEO_AGENT_SLUG);

	if (isLoading || !issue)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	async function handleComment(e: React.FormEvent) {
		e.preventDefault();
		if (!commentText.trim()) return;
		await createComment.mutateAsync({
			content: commentText,
			...(commentEffort ? { effort: commentEffort } : {}),
			...(issue?.assignee_id ? { wake_assignee: wakeAssignee } : {}),
		});
		setCommentText('');
		setCommentEffort(null);
		setWakeAssignee(true);
	}

	async function handleSubIssue(e: React.FormEvent) {
		e.preventDefault();
		if (!subIssueTitle.trim()) return;
		try {
			await createSubIssue.mutateAsync({ title: subIssueTitle });
			setSubIssueTitle('');
			setShowSubForm(false);
		} catch {
			// error rendered below the form via createSubIssue.error
		}
	}

	const issueProjectSlug = issue.project_slug ?? projectId;

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
					{issue.project_name && issue.project_slug && (
						<Link
							to="/companies/$companyId/projects/$projectId"
							params={{ companyId, projectId: issue.project_slug }}
							className="hover:opacity-80 transition-opacity"
						>
							<Badge color="info">{issue.project_name}</Badge>
						</Link>
					)}
				</div>

				{lock && lock.locks.length > 0 && (
					<RunningAgentsLine locks={lock.locks} comments={comments ?? []} />
				)}

				{issue.description && (
					<div
						className="mb-5 rounded-md border border-border bg-bg-elevated overflow-hidden"
						data-testid="issue-description-card"
					>
						<div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-muted">
							<span className="text-xs font-medium text-text-muted">Description</span>
						</div>
						<div className="px-3 py-2.5">
							<MarkdownProse
								testId="issue-description"
								companyId={companyId}
								projectSlug={issueProjectSlug}
							>
								{issue.description}
							</MarkdownProse>
						</div>
					</div>
				)}

				<div
					data-testid="pinned-progress-summary"
					className="bg-bg-subtle rounded-radius-md p-3 mb-3 text-[13px] text-text-muted leading-relaxed"
				>
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
							<MentionTextarea
								companyId={companyId}
								projectSlug={issueProjectSlug}
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
					) : issue.progress_summary ? (
						<MarkdownProse companyId={companyId} projectSlug={issueProjectSlug}>
							{issue.progress_summary}
						</MarkdownProse>
					) : (
						<span>No progress summary yet.</span>
					)}
				</div>

				<div
					data-testid="pinned-rules"
					className="bg-bg-subtle rounded-radius-md p-3 mb-5 text-[13px] text-text-muted leading-relaxed border-l-2 border-accent-blue"
				>
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
							<MentionTextarea
								companyId={companyId}
								projectSlug={issueProjectSlug}
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
					) : issue.rules ? (
						<MarkdownProse companyId={companyId} projectSlug={issueProjectSlug}>
							{issue.rules}
						</MarkdownProse>
					) : (
						<span>No rules set.</span>
					)}
				</div>

				{/* Sub-issues */}
				<div
					className="mb-5 rounded-md border border-border overflow-hidden"
					data-testid="sub-issues-card"
				>
					<div className="flex items-center px-3 py-2 bg-bg-muted">
						<button
							type="button"
							onClick={() => setSubIssuesOpen((o) => !o)}
							className="flex items-center gap-2 flex-1 text-left cursor-pointer"
							data-testid="sub-issues-toggle"
							aria-expanded={subIssuesOpen}
						>
							<ChevronDown
								className={`w-3.5 h-3.5 text-text-subtle transition-transform ${
									subIssuesOpen ? '' : '-rotate-90'
								}`}
							/>
							<span className="text-xs font-medium text-text-muted">Sub-issues</span>
							<span className="bg-bg-subtle px-[7px] py-px rounded-full text-[11px] text-text-muted">
								{subIssues?.data.length ?? 0}
							</span>
						</button>
						<button
							type="button"
							onClick={() => {
								setSubIssuesOpen(true);
								setShowSubForm((s) => !s);
							}}
							className="text-[11px] text-text-subtle hover:text-text flex items-center gap-1 cursor-pointer"
							data-testid="sub-issues-add"
						>
							<Plus className="w-3 h-3" /> Add
						</button>
					</div>
					{subIssuesOpen && (
						<div
							className="px-3 py-2.5 flex flex-col gap-1.5 border-t border-border"
							data-testid="sub-issues-list"
						>
							{showSubForm && (
								<>
									<form onSubmit={handleSubIssue} className="flex gap-2 mb-1">
										<input
											value={subIssueTitle}
											onChange={(e) => setSubIssueTitle(e.target.value)}
											placeholder="Sub-issue title"
											className="flex-1 rounded-radius-md border border-border bg-bg px-3 py-1.5 text-[13px] text-text outline-none focus:border-border-hover"
											data-testid="sub-issue-title-input"
										/>
										<Button type="submit" size="sm" disabled={!subIssueTitle.trim()}>
											Create
										</Button>
									</form>
									{createSubIssue.error && (
										<div className="text-[12px] text-red-500 mb-1" data-testid="sub-issue-error">
											{(createSubIssue.error as { message?: string }).message ??
												'Failed to create sub-issue'}
										</div>
									)}
								</>
							)}
							{(subIssues?.data.length ?? 0) === 0 && !showSubForm && (
								<span className="text-[13px] text-text-muted">No sub-issues.</span>
							)}
							{subIssues?.data.map((s) => (
								<Link
									key={s.id}
									to="/companies/$companyId/projects/$projectId/issues/$issueId"
									params={{
										companyId,
										projectId: s.project_slug ?? issueProjectSlug,
										issueId: s.identifier.toLowerCase(),
									}}
									className="flex items-center gap-2 text-[13px] hover:bg-bg-subtle rounded px-2 py-1"
									data-testid="sub-issue-item"
								>
									<Badge color={statusColors[s.status] as 'neutral'}>
										{s.status.replace('_', ' ')}
									</Badge>
									<span className="font-mono text-xs text-text-muted">{s.identifier}</span>
									<span className="truncate">{s.title}</span>
								</Link>
							))}
						</div>
					)}
				</div>

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

				{/* Comments */}
				<div className="border-t border-border pt-4">
					<div className="flex items-center gap-1.5 mb-4">
						<h3 className="text-[13px] text-text font-medium">Comments</h3>
						<span className="bg-bg-subtle px-[7px] py-px rounded-full text-[11px] text-text-muted">
							{comments?.length ?? 0}
						</span>
					</div>

					<div className="flex flex-col gap-4 mb-4">
						{comments?.map((c) => {
							const authorName = c.author_name ?? 'Board';
							const isAgent = c.author_type === 'agent';
							const content =
								typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
							const isPendingSetupRepo =
								c.content_type === 'action' && content?.kind === 'setup_repo' && !c.chosen_option;
							return (
								<div
									key={c.id}
									id={`comment-${c.id}`}
									className="flex gap-2.5 scroll-mt-20"
									data-testid="comment-item"
									{...(isPendingSetupRepo ? { 'data-setup-repo-anchor': '' } : {})}
								>
									<Avatar
										initials={authorName.slice(0, 2)}
										size="sm"
										color={avatarColorFromString(authorName)}
									/>
									<div className="flex-1 min-w-0 rounded-md border border-border bg-bg-elevated overflow-hidden">
										<div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-muted">
											<span
												className={`text-xs font-medium ${isAgent ? 'text-text' : 'text-text-muted'}`}
												data-testid="comment-author"
											>
												{authorName}
											</span>
											<span className="text-[11px] text-text-subtle">
												{new Date(c.created_at).toLocaleString()}
											</span>
										</div>
										<div className="px-3 py-2.5">
											<CommentRenderer
												comment={c as unknown as CommentData}
												onChooseOption={(commentId, chosenId) =>
													chooseOption.mutate({ commentId, chosen_id: chosenId })
												}
												companyId={companyId}
												projectId={issue?.project_id ?? undefined}
												projectSlug={issueProjectSlug}
												issueId={issue?.id ?? undefined}
											/>
										</div>
									</div>
								</div>
							);
						})}
					</div>

					<form onSubmit={handleComment} className="flex flex-col gap-2">
						<MentionTextarea
							companyId={companyId}
							projectSlug={issueProjectSlug}
							value={commentText}
							onChange={(e) => setCommentText(e.target.value)}
							placeholder="Add a comment..."
							className="min-h-[60px]"
						/>
						<div className="flex items-center justify-end gap-2">
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
			</div>

			{/* Sidebar */}
			<div
				data-testid="issue-sidebar"
				className="flex flex-col gap-4 text-xs lg:sticky lg:top-0 lg:self-start"
			>
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
					{issue.has_active_run ? (
						<div className="flex items-center gap-1 w-full text-[13px] text-text px-1 py-0.5">
							<AgentStatusLabel
								name={assignedAgent?.title ?? '—'}
								runtimeStatus={assignedAgent?.runtime_status ?? 'idle'}
								className="flex-1 min-w-0"
							/>
							<Tooltip content="Cannot change assignee while an agent is running on this issue">
								<button
									type="button"
									aria-label="Assignee locked: agent is running"
									className="shrink-0 text-text-subtle hover:text-text transition-colors"
								>
									<Info className="w-3.5 h-3.5" />
								</button>
							</Tooltip>
						</div>
					) : (
						<>
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
									{assigneeOptions?.map((a) => (
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
						</>
					)}
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Project
					</span>
					{issue.project_name && issue.project_slug ? (
						<Link
							to="/companies/$companyId/projects/$projectId"
							params={{ companyId, projectId: issue.project_slug }}
							className="text-[13px] text-text hover:text-accent-blue-text transition-colors"
						>
							{issue.project_name}
						</Link>
					) : (
						<span className="text-[13px] text-text">—</span>
					)}
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Created
					</span>
					<span className="text-[13px] text-text">
						{new Date(issue.created_at).toLocaleDateString()}
					</span>
				</div>

				<div>
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Effort
					</span>
					<select
						value={commentEffort ?? effectiveDefaultEffort}
						onChange={(e) => setCommentEffort(e.target.value as AgentEffort)}
						className="w-full rounded-radius-md border border-border bg-bg px-2.5 py-1.5 text-xs text-text outline-none"
						aria-label="Reasoning effort for the agent run triggered by this comment"
					>
						{EFFORT_LEVELS.map(({ value, label }) => (
							<option key={value} value={value}>
								{label}
								{value === effectiveDefaultEffort ? ' (default)' : ''}
							</option>
						))}
					</select>
				</div>

				{issue.assignee_id && (
					<label className="flex items-center gap-2 text-[13px] text-text cursor-pointer select-none">
						<input
							type="checkbox"
							checked={wakeAssignee}
							onChange={(e) => setWakeAssignee(e.target.checked)}
							className="rounded"
							aria-label="Wake assignee on submit"
						/>
						<span>Wake assignee</span>
					</label>
				)}

				<div className="mt-auto pt-4 border-t border-border">
					{issue.status === IssueStatus.Closed ? (
						<Button
							variant="secondary"
							size="sm"
							className="w-full"
							onClick={() => setReopenOpen(true)}
							data-testid="issue-reopen-button"
						>
							Re-open issue
						</Button>
					) : (
						<Button
							variant="danger-text"
							size="sm"
							className="w-full"
							onClick={() => setCloseOpen(true)}
							data-testid="issue-close-button"
						>
							Close issue
						</Button>
					)}
				</div>
			</div>

			<ConfirmDialog
				open={closeOpen}
				onOpenChange={setCloseOpen}
				title="Close this issue?"
				description="The issue will be marked as closed. This skips the coach review step that runs when an issue is marked done."
				confirmLabel="Close issue"
				variant="danger"
				loading={updateIssue.isPending}
				onConfirm={async () => {
					await updateIssue.mutateAsync({ status: IssueStatus.Closed });
				}}
			/>

			<ConfirmDialog
				open={reopenOpen}
				onOpenChange={setReopenOpen}
				title="Re-open this issue?"
				description="Status will be set back to backlog."
				confirmLabel="Re-open"
				loading={updateIssue.isPending}
				onConfirm={async () => {
					await updateIssue.mutateAsync({ status: IssueStatus.Backlog });
				}}
			/>
		</div>
	);
}

type RunCommentRef = { id: string; content_type: string; content: unknown };

function RunningAgentsLine({
	locks,
	comments,
}: {
	locks: ExecutionLock[];
	comments: RunCommentRef[];
}) {
	const runCommentIdByAgentId = new Map<string, string>();
	for (const c of comments) {
		if (c.content_type !== 'run') continue;
		const agentId =
			c.content && typeof c.content === 'object'
				? (c.content as { agent_id?: string }).agent_id
				: undefined;
		if (agentId) runCommentIdByAgentId.set(agentId, c.id);
	}

	const ordered = [...locks].sort((a, b) => a.locked_at.localeCompare(b.locked_at));

	const nameNodes = ordered.map((l) => {
		const commentId = runCommentIdByAgentId.get(l.member_id);
		if (!commentId) {
			return (
				<span key={l.id} className="text-accent-blue-text font-medium">
					{l.member_name}
				</span>
			);
		}
		const targetId = `comment-${commentId}`;
		return (
			<a
				key={l.id}
				href={`#${targetId}`}
				onClick={(e) => {
					e.preventDefault();
					document.getElementById(targetId)?.scrollIntoView({ block: 'center' });
					window.history.replaceState(null, '', `#${targetId}`);
				}}
				className="text-accent-blue-text font-medium hover:underline"
			>
				{l.member_name}
			</a>
		);
	});

	const parts: { key: string; node: React.ReactNode }[] = [];
	for (let i = 0; i < ordered.length; i++) {
		if (i > 0) {
			const isLastGap = i === ordered.length - 1;
			const sep = ordered.length === 2 ? ' and ' : isLastGap ? ', and ' : ', ';
			parts.push({ key: `sep-${ordered[i].id}`, node: sep });
		}
		parts.push({ key: `name-${ordered[i].id}`, node: nameNodes[i] });
	}

	const verb = ordered.length === 1 ? 'is' : 'are';

	return (
		<div
			className="flex items-center flex-wrap gap-x-1.5 gap-y-1 rounded-radius-md bg-accent-blue-bg px-3 py-2 text-xs mb-4"
			data-testid="running-agents-line"
		>
			<span className="w-2 h-2 rounded-full bg-accent-blue animate-pulse shrink-0" />
			<span>
				{parts.map((p) => (
					<Fragment key={p.key}>{p.node}</Fragment>
				))}{' '}
				<span className="text-text-muted">{verb} running on this issue</span>
			</span>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/issues/$issueId')({
	component: IssueDetailPage,
});
