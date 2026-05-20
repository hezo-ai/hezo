import {
	AgentEffort,
	AgentRuntimeStatus,
	CAPTAIN_AGENT_SLUG,
	DEFAULT_EFFORT,
	IssueStatus,
	OPERATIONS_PROJECT_SLUG,
} from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import {
	ArrowDown,
	ChevronDown,
	CornerDownRight,
	Loader2,
	Plus,
	Reply,
	Trash2,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { AgentStatusLabel } from '../../../../../../components/agent-status-label';
import { CommentAttachmentsDrop } from '../../../../../../components/comment-attachments-drop';
import {
	type CommentData,
	CommentReactions,
	CommentRenderer,
	inlineEventIcon,
	isInlineEventType,
} from '../../../../../../components/comment-renderers';
import { IssueStatusBadge } from '../../../../../../components/issue-status-badge';
import { MarkdownProse } from '../../../../../../components/markdown-prose';
import { MentionTextarea } from '../../../../../../components/mention-textarea';
import { Avatar, avatarColorFromString } from '../../../../../../components/ui/avatar';
import { Badge } from '../../../../../../components/ui/badge';
import { Button } from '../../../../../../components/ui/button';
import { ConfirmDialog } from '../../../../../../components/ui/confirm-dialog';
import { InfoTooltip } from '../../../../../../components/ui/info-tooltip';
import { useAgents } from '../../../../../../hooks/use-agents';
import {
	type Comment,
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
import { DEFAULT_SUBTASK_PAGE_SIZE, useTeam } from '../../../../../../hooks/use-teams';

function previewCommentText(c: Comment): string {
	const raw = c.content as unknown;
	let text = '';
	if (typeof raw === 'string') text = raw;
	else if (raw && typeof raw === 'object' && 'text' in raw) {
		const t = (raw as { text?: unknown }).text;
		text = typeof t === 'string' ? t : '';
	}
	text = text.trim().replace(/\s+/g, ' ');
	if (!text) return '(non-text comment)';
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

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
	const { teamId, projectId, issueId } = Route.useParams();
	const navigate = useNavigate();
	const { data: issue, isLoading } = useIssue(teamId, issueId);

	useEffect(() => {
		if (!issue?.identifier || !issue?.project_slug) return;
		const friendlyId = issue.identifier.toLowerCase();
		const canonicalProject = issue.project_slug;
		const needsIdNormalization = UUID_RE.test(issueId) && issueId !== friendlyId;
		const needsProjectNormalization = projectId !== canonicalProject;
		if (needsIdNormalization || needsProjectNormalization) {
			navigate({
				to: '/teams/$teamId/projects/$projectId/issues/$issueId',
				params: { teamId, projectId: canonicalProject, issueId: friendlyId },
				replace: true,
			});
		}
	}, [issue?.identifier, issue?.project_slug, issueId, projectId, teamId, navigate]);
	const { data: comments } = useComments(teamId, issueId);
	const { data: deps } = useIssueDependencies(teamId, issueId);
	const { data: team } = useTeam(teamId);
	const subIssuePageSize = Math.max(
		1,
		team?.settings?.subtask_page_size ?? DEFAULT_SUBTASK_PAGE_SIZE,
	);
	const { data: subIssues } = useIssues(
		teamId,
		issue?.id ? { parent_issue_id: issue.id, per_page: '200' } : undefined,
		{ enabled: !!issue?.id },
	);
	const { data: agents } = useAgents(teamId);
	const { data: lock } = useExecutionLock(teamId, issueId);
	const updateIssue = useUpdateIssue(teamId, issueId);
	const createComment = useCreateComment(teamId, issueId);
	const chooseOption = useChooseOption(teamId, issueId);
	const createSubIssue = useCreateSubIssue(teamId, issueId);
	const removeDep = useRemoveDependency(teamId, issueId);
	const [commentText, setCommentText] = useState('');
	// Per-comment reasoning effort. `null` = user hasn't touched the dropdown, so
	// leave effort unset on submit and let the server resolve the agent default.
	const [commentEffort, setCommentEffort] = useState<AgentEffort | null>(null);
	const [wakeAssignee, setWakeAssignee] = useState(true);
	const [replyTarget, setReplyTarget] = useState<Comment | null>(null);
	const [pendingAttachmentIds, setPendingAttachmentIds] = useState<string[]>([]);
	const commentFormRef = useRef<HTMLFormElement>(null);
	const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
	const [subIssueTitle, setSubIssueTitle] = useState('');
	const [showSubForm, setShowSubForm] = useState(false);
	const [subIssuesOpen, setSubIssuesOpen] = useState(true);
	const [subIssuesShownState, setSubIssuesShownState] = useState<{
		issueId: string;
		count: number;
	} | null>(null);
	const subIssuesShown =
		subIssuesShownState && subIssuesShownState.issueId === issue?.id
			? subIssuesShownState.count
			: subIssuePageSize;
	const [editingSummary, setEditingSummary] = useState(false);
	const [summaryText, setSummaryText] = useState('');
	const [editingRules, setEditingRules] = useState(false);
	const [rulesText, setRulesText] = useState('');
	const [assigneeOpen, setAssigneeOpen] = useState(false);
	const [closeOpen, setCloseOpen] = useState(false);
	const [reopenOpen, setReopenOpen] = useState(false);
	const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
	const assigneeRef = useRef<HTMLDivElement>(null);
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const didScrollToHashRef = useRef(false);
	// The app shell wraps the route in `<main className="flex-1 overflow-auto">`
	// (see __root.tsx). The window never scrolls — that <main> does — so
	// Virtuoso needs `customScrollParent` pointing at it for measurement and
	// scroll restoration to work. Resolve before paint so Virtuoso's first
	// mount is wired to the right scroll container.
	const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (typeof document === 'undefined') return;
		setScrollParent(document.querySelector('main'));
	}, []);

	const lastResetIssueIdRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!scrollParent) return;
		if (lastResetIssueIdRef.current === issueId) return;
		const hash = typeof window !== 'undefined' ? window.location.hash : '';
		const hasJumpHash = hash.startsWith('#comment-') || hash === '#setup-repo';
		if (!hasJumpHash) scrollParent.scrollTop = 0;
		lastResetIssueIdRef.current = issueId;
	}, [issueId, scrollParent]);

	const [atBottom, setAtBottom] = useState(false);
	useEffect(() => {
		if (!scrollParent) return;
		const check = () => {
			setAtBottom(
				scrollParent.scrollTop + scrollParent.clientHeight >= scrollParent.scrollHeight - 200,
			);
		};
		check();
		scrollParent.addEventListener('scroll', check, { passive: true });
		const ro = new ResizeObserver(check);
		ro.observe(scrollParent);
		for (const child of Array.from(scrollParent.children)) ro.observe(child);
		return () => {
			scrollParent.removeEventListener('scroll', check);
			ro.disconnect();
		};
	}, [scrollParent]);

	const scrollToBottom = () => {
		if (!scrollParent) return;
		const target = scrollParent;
		target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
		// Lazy virtualised content keeps growing scrollHeight as new rows render,
		// so re-anchor at the bottom until the height stops changing or the budget runs out.
		const deadline = Date.now() + 5000;
		let lastScrollHeight = -1;
		let stableTicks = 0;
		const tick = () => {
			target.scrollTo({ top: target.scrollHeight, behavior: 'auto' });
			if (target.scrollHeight === lastScrollHeight) {
				stableTicks++;
				if (stableTicks >= 3) return;
			} else {
				lastScrollHeight = target.scrollHeight;
				stableTicks = 0;
			}
			if (Date.now() >= deadline) return;
			setTimeout(tick, 100);
		};
		setTimeout(tick, 400);
	};

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

		// Resolve the current hash (a specific comment via `#comment-<id>`, or
		// the unresolved setup-repo action card via `#setup-repo`) to its
		// index in the loaded comments list and tell Virtuoso to scroll there.
		// `scrollToIndex` is computed off estimated row heights, so iterate a
		// few times: each pass mounts more rows, grows the measured document,
		// and the next call lands closer to the target.
		const scrollToHash = () => {
			const hash = window.location.hash;
			let idx = -1;
			let highlightId: string | null = null;
			if (hash.startsWith('#comment-')) {
				const targetId = hash.slice('#comment-'.length);
				idx = comments.findIndex((c) => c.id === targetId);
				if (idx >= 0) highlightId = targetId;
			} else if (hash === '#setup-repo') {
				idx = comments.findIndex((c) => {
					if (c.content_type !== 'action') return false;
					const content = typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
					return content?.kind === 'setup_repo' && !c.chosen_option;
				});
			}
			if (idx < 0) return [] as ReturnType<typeof setTimeout>[];
			const out: ReturnType<typeof setTimeout>[] = [];
			for (const delay of [16, 200, 600, 1500]) {
				out.push(
					setTimeout(() => {
						virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' });
					}, delay),
				);
			}
			if (highlightId) {
				setHighlightedCommentId(highlightId);
				out.push(
					setTimeout(() => {
						setHighlightedCommentId(null);
					}, 2000),
				);
				window.history.replaceState(null, '', window.location.pathname + window.location.search);
			}
			if (hash === '#setup-repo') {
				window.history.replaceState(null, '', window.location.pathname + window.location.search);
			}
			return out;
		};

		const initialTimers = didScrollToHashRef.current ? [] : scrollToHash();
		didScrollToHashRef.current = true;

		const allTimers: ReturnType<typeof setTimeout>[] = [...initialTimers];
		const onHashChange = () => {
			allTimers.push(...scrollToHash());
		};
		window.addEventListener('hashchange', onHashChange);
		return () => {
			window.removeEventListener('hashchange', onHashChange);
			for (const t of allTimers) clearTimeout(t);
		};
	}, [comments]);

	const assignedAgent = agents?.find((a) => a.id === issue?.assignee_id);
	const effectiveDefaultEffort: AgentEffort =
		assignedAgent?.slug === CAPTAIN_AGENT_SLUG
			? AgentEffort.Max
			: (assignedAgent?.default_effort ?? DEFAULT_EFFORT);
	const isOperationsProject = issue?.project_slug === OPERATIONS_PROJECT_SLUG;
	const assigneeOptions = agents
		?.filter((a) => a.admin_status !== 'disabled')
		.filter((a) => !isOperationsProject || a.slug === CAPTAIN_AGENT_SLUG);

	if (isLoading || !issue)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	async function handleComment(e: React.FormEvent) {
		e.preventDefault();
		if (!commentText.trim() && pendingAttachmentIds.length === 0) return;
		await createComment.mutateAsync({
			content: commentText,
			...(commentEffort ? { effort: commentEffort } : {}),
			...(issue?.assignee_id ? { wake_assignee: wakeAssignee } : {}),
			...(replyTarget ? { parent_comment_id: replyTarget.id } : {}),
			...(pendingAttachmentIds.length > 0 ? { attachment_ids: pendingAttachmentIds } : {}),
		});
		setCommentText('');
		setCommentEffort(null);
		setWakeAssignee(true);
		setReplyTarget(null);
		setPendingAttachmentIds([]);
	}

	function startReply(c: Comment) {
		setReplyTarget(c);
		requestAnimationFrame(() => {
			commentFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			commentTextareaRef.current?.focus();
		});
	}

	function jumpToComment(commentId: string) {
		return (e: React.MouseEvent) => {
			e.preventDefault();
			const target = `#comment-${commentId}`;
			window.history.pushState(null, '', target);
			window.dispatchEvent(new HashChangeEvent('hashchange'));
		};
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
		<div className="grid grid-cols-1 lg:grid-cols-[1fr_190px] gap-5">
			{/* Main content */}
			<div className="min-w-0">
				<div className="mb-1 text-[13px] font-mono text-text-muted">{issue.identifier}</div>
				<h1 className="text-xl font-medium mb-3">{issue.title}</h1>

				<div className="flex flex-wrap gap-1.5 mb-4">
					<IssueStatusBadge status={issue.status} />
					<Badge color={priorityColors[issue.priority] as 'neutral'}>{issue.priority}</Badge>
					{issue.project_name && issue.project_slug && (
						<Link
							to="/teams/$teamId/projects/$projectId"
							params={{ teamId, projectId: issue.project_slug }}
							className="hover:opacity-80 transition-opacity"
						>
							<Badge color="info">{issue.project_name}</Badge>
						</Link>
					)}
				</div>

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
								teamId={teamId}
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
						<div className="flex items-center gap-1">
							<span className="text-[11px] uppercase tracking-wider font-medium text-text-subtle">
								Progress Summary
							</span>
							<InfoTooltip
								label="About Progress Summary"
								data-testid="progress-summary-info"
								content="A running checkpoint of what's been done and what's left on this issue. Agents update it at natural milestones via the update_issue tool. Not auto-included in the agent's prompt — agents fetch it on demand to stay continuous across runs."
							/>
						</div>
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
								teamId={teamId}
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
						<MarkdownProse teamId={teamId} projectSlug={issueProjectSlug}>
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
						<div className="flex items-center gap-1">
							<span className="text-[11px] uppercase tracking-wider font-medium text-text-subtle">
								Rules
							</span>
							<InfoTooltip
								label="About Rules"
								data-testid="rules-info"
								content="Approach constraints and required workflows for this issue — e.g. 'run the full suite before pushing' or 'consult the architect before touching auth'. Automatically prepended to every agent run's task prompt. Agents can update via the update_issue tool as they discover new rules."
							/>
						</div>
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
								teamId={teamId}
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
						<MarkdownProse teamId={teamId} projectSlug={issueProjectSlug}>
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
							{subIssues?.data.slice(0, subIssuesShown).map((s) => (
								<Link
									key={s.id}
									to="/teams/$teamId/projects/$projectId/issues/$issueId"
									params={{
										teamId,
										projectId: s.project_slug ?? issueProjectSlug,
										issueId: s.identifier.toLowerCase(),
									}}
									className="flex items-center gap-2 text-[13px] hover:bg-bg-subtle rounded px-2 py-1"
									data-testid="sub-issue-item"
								>
									<IssueStatusBadge status={s.status} className="shrink-0" />
									<span className="font-mono text-xs text-text-muted shrink-0 whitespace-nowrap">
										{s.identifier}
									</span>
									<span className="truncate min-w-0">{s.title}</span>
								</Link>
							))}
							{subIssues && subIssues.data.length > subIssuesShown && (
								<div className="flex justify-center pt-2 mt-0.5 border-t border-border-subtle">
									<button
										type="button"
										onClick={() =>
											setSubIssuesShownState({
												issueId: issue?.id ?? '',
												count: subIssuesShown + subIssuePageSize,
											})
										}
										className="inline-flex items-center gap-1.5 text-[12px] text-text-subtle hover:text-text px-3 py-1 rounded-radius-md hover:bg-bg-subtle transition-colors cursor-pointer"
										data-testid="sub-issues-show-more"
									>
										<ChevronDown className="w-3 h-3" />
										Show more
										<span className="text-text-subtle">
											· {subIssues.data.length - subIssuesShown} hidden
										</span>
									</button>
								</div>
							)}
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
								<div key={d.id} className="flex items-center gap-2">
									<Link
										to="/teams/$teamId/projects/$projectId/issues/$issueId"
										params={{
											teamId,
											projectId: d.blocked_by_project_slug,
											issueId: d.blocked_by_identifier.toLowerCase(),
										}}
										className="flex items-center gap-2 text-[13px] hover:bg-bg-subtle rounded px-2 py-1 flex-1 min-w-0"
										data-testid="blocked-by-item"
									>
										<IssueStatusBadge status={d.blocked_by_status} />
										<span className="font-mono text-xs text-text-muted">
											{d.blocked_by_identifier}
										</span>
										<span className="truncate">{d.blocked_by_title}</span>
									</Link>
									<button
										type="button"
										onClick={() => removeDep.mutate(d.id)}
										className="text-text-subtle hover:text-accent-red"
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

					<div className="mb-4" data-testid="comments-list">
						{scrollParent && (
							<Virtuoso
								ref={virtuosoRef}
								customScrollParent={scrollParent}
								data={comments ?? []}
								computeItemKey={(_, c) => c.id}
								defaultItemHeight={120}
								increaseViewportBy={{ top: 600, bottom: 600 }}
								itemContent={(_, c) => {
									const commentData = c as unknown as CommentData;
									const authorName = c.author_name ?? 'Board';
									const isAgent = c.author_type === 'agent';
									const content =
										typeof c.content === 'object' ? (c.content as { kind?: string }) : null;
									const isPendingSetupRepo =
										c.content_type === 'action' &&
										content?.kind === 'setup_repo' &&
										!c.chosen_option;
									const isHighlighted = highlightedCommentId === c.id;

									if (isInlineEventType(c.content_type)) {
										const Icon = inlineEventIcon(commentData);
										return (
											<div
												id={`comment-${c.id}`}
												className={`flex items-start gap-2.5 scroll-mt-20 pb-4 ${isHighlighted ? 'rounded-md ring-2 ring-accent-blue/60 transition-shadow' : ''}`}
												data-testid="comment-item"
												data-comment-highlighted={isHighlighted ? 'true' : undefined}
											>
												<div className="w-[26px] h-[26px] flex items-center justify-center shrink-0 text-text-subtle">
													<Icon className="w-3.5 h-3.5" />
												</div>
												<div className="flex-1 min-w-0">
													<CommentRenderer
														comment={commentData}
														onChooseOption={(commentId, chosenId) =>
															chooseOption.mutate({ commentId, chosen_id: chosenId })
														}
														teamId={teamId}
														projectId={issue?.project_id ?? undefined}
														projectSlug={issueProjectSlug}
														issueId={issue?.id ?? undefined}
														inline
													/>
												</div>
											</div>
										);
									}

									return (
										<div
											id={`comment-${c.id}`}
											className={`flex gap-2.5 scroll-mt-20 pb-4 ${isHighlighted ? 'rounded-md ring-2 ring-accent-blue/60 transition-shadow' : ''}`}
											data-testid="comment-item"
											data-comment-highlighted={isHighlighted ? 'true' : undefined}
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
													{c.parent_comment_id &&
														(() => {
															const parent = comments?.find((x) => x.id === c.parent_comment_id);
															if (!parent) return null;
															return (
																<a
																	href={`#comment-${parent.id}`}
																	onClick={jumpToComment(parent.id)}
																	className="ml-auto flex items-center gap-1 text-[11px] text-text-subtle hover:text-text"
																	data-testid="replying-to"
																>
																	<CornerDownRight className="w-3 h-3" />
																	replying to {parent.author_name}
																</a>
															);
														})()}
												</div>
												<div className="px-3 py-2.5">
													<CommentRenderer
														comment={commentData}
														onChooseOption={(commentId, chosenId) =>
															chooseOption.mutate({ commentId, chosen_id: chosenId })
														}
														teamId={teamId}
														projectId={issue?.project_id ?? undefined}
														projectSlug={issueProjectSlug}
														issueId={issue?.id ?? undefined}
													/>
													<div className="flex items-end justify-between gap-2">
														<div className="min-w-0 flex-1">
															<CommentReactions
																comment={commentData}
																teamId={teamId}
																issueId={issue?.id}
															/>
														</div>
														<button
															type="button"
															onClick={() => startReply(c)}
															className="mt-2 text-text-subtle hover:text-text shrink-0 p-1 -m-1"
															aria-label="Reply to comment"
															data-testid="comment-reply"
														>
															<Reply className="w-3.5 h-3.5" />
														</button>
													</div>
												</div>
											</div>
										</div>
									);
								}}
							/>
						)}
					</div>

					<form ref={commentFormRef} onSubmit={handleComment} className="flex gap-2.5 scroll-mt-20">
						<div className="w-[26px] shrink-0" aria-hidden />
						<div className="flex-1 min-w-0 flex flex-col gap-2">
							<CommentAttachmentsDrop
								teamId={teamId}
								issueId={issue.id}
								value={pendingAttachmentIds}
								onChange={setPendingAttachmentIds}
							>
								<MentionTextarea
									ref={commentTextareaRef}
									teamId={teamId}
									projectSlug={issueProjectSlug}
									value={commentText}
									onChange={(e) => setCommentText(e.target.value)}
									placeholder="Add a comment..."
									className="min-h-[60px]"
								/>
							</CommentAttachmentsDrop>
							{replyTarget && (
								<div
									className="flex items-center gap-2 text-[13px] text-text-muted"
									data-testid="reply-indicator"
								>
									<CornerDownRight className="w-3.5 h-3.5 shrink-0" />
									<span className="shrink-0">In response to</span>
									<a
										href={`#comment-${replyTarget.id}`}
										onClick={jumpToComment(replyTarget.id)}
										className="truncate text-accent-blue hover:underline"
									>
										{replyTarget.author_name}: {previewCommentText(replyTarget)}
									</a>
									<button
										type="button"
										onClick={() => setReplyTarget(null)}
										className="text-text-subtle hover:text-text shrink-0"
										aria-label="Clear reply target"
										data-testid="clear-reply"
									>
										<Trash2 className="w-3.5 h-3.5" />
									</button>
								</div>
							)}
							<div className="flex items-center justify-between gap-2">
								{issue.assignee_id ? (
									<label className="flex items-center gap-2 text-[13px] text-text-muted cursor-pointer select-none">
										<input
											type="checkbox"
											checked={wakeAssignee}
											onChange={(e) => setWakeAssignee(e.target.checked)}
											className="rounded"
											aria-label="Wake assignee on submit"
										/>
										<span>Wake assignee</span>
									</label>
								) : (
									<span />
								)}
								<Button
									type="submit"
									size="sm"
									disabled={
										(!commentText.trim() && pendingAttachmentIds.length === 0) ||
										createComment.isPending
									}
								>
									{createComment.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
									Comment
								</Button>
							</div>
						</div>
					</form>
				</div>
			</div>

			{/* Sidebar */}
			<div
				data-testid="issue-sidebar"
				className="flex flex-col gap-4 text-xs lg:sticky lg:top-0 lg:self-start"
			>
				{lock && lock.locks.length > 0 && (
					<RunningAgentsLine locks={lock.locks} comments={comments ?? []} />
				)}

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

				<div ref={assigneeRef} className="relative" data-testid="issue-assignee">
					<span className="text-text-subtle block mb-1 uppercase tracking-wider font-medium">
						Assignee
					</span>
					{issue.has_active_run ? (
						<div className="flex items-center gap-1 w-full text-[13px] text-text px-1 py-0.5">
							<AgentStatusLabel
								name={assignedAgent?.title ?? '—'}
								runtimeStatus={AgentRuntimeStatus.Active}
								className="flex-1 min-w-0"
							/>
							<InfoTooltip
								content="Cannot change assignee while an agent is running on this issue"
								label="Assignee locked: agent is running"
							/>
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
									runtimeStatus={AgentRuntimeStatus.Idle}
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
											<AgentStatusLabel name={a.title} runtimeStatus={AgentRuntimeStatus.Idle} />
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
							to="/teams/$teamId/projects/$projectId"
							params={{ teamId, projectId: issue.project_slug }}
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

				{!atBottom && (
					<button
						type="button"
						onClick={scrollToBottom}
						data-testid="issue-scroll-to-bottom"
						aria-label="Scroll to bottom"
						className="fixed bottom-4 right-4 z-30 w-9 h-9 rounded-full border border-border bg-bg-elevated text-text-muted hover:text-text shadow-md flex items-center justify-center"
					>
						<ArrowDown className="w-4 h-4" />
					</button>
				)}
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
					// Drive scroll via the hash so the issue page's hashchange handler
					// can ask Virtuoso to mount and scroll to the row even when it
					// isn't currently in the DOM. Falling back to scrollIntoView
					// alone silently fails for off-screen virtualized rows.
					e.preventDefault();
					const next = `#${targetId}`;
					if (window.location.hash === next) {
						window.dispatchEvent(new HashChangeEvent('hashchange'));
					} else {
						window.history.pushState(null, '', next);
						window.dispatchEvent(new HashChangeEvent('hashchange'));
					}
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
			className="flex items-center flex-wrap gap-x-1.5 gap-y-1 rounded-radius-md bg-accent-blue-bg px-3 py-2 text-xs"
			data-testid="running-agents-line"
		>
			<span className="w-2 h-2 rounded-full bg-accent-blue animate-pulse shrink-0" />
			<span>
				{parts.map((p) => (
					<Fragment key={p.key}>{p.node}</Fragment>
				))}{' '}
				<span className="text-text-muted">{verb} running</span>
			</span>
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/issues/$issueId')({
	component: IssueDetailPage,
});
