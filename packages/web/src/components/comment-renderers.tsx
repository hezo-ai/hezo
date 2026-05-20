import { formatIssueStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import {
	AlertTriangle,
	ArrowRightLeft,
	Check,
	ChevronDown,
	ChevronRight,
	DoorOpen,
	Dot,
	ExternalLink,
	GitBranch,
	KeyRound,
	Link2,
	Pencil,
	Smile,
	Terminal,
	UserRoundCog,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import { useState } from 'react';
import {
	type CommentAttachment,
	type ReactionGroup,
	useAddReaction,
	useFulfillCredential,
	useRemoveReaction,
} from '../hooks/use-comments';
import { formatElapsed } from '../hooks/use-elapsed-duration';
import {
	getRunWaitingMessage,
	isActiveRunStatus,
	useHeartbeatRun,
} from '../hooks/use-heartbeat-runs';
import { useRunLogs } from '../hooks/use-run-logs';
import { CommentAttachmentThumb } from './comment-attachment-thumb';
import { LazyMount } from './lazy-mount';
import { LogViewer } from './log-viewer';
import { MarkdownProse } from './markdown-prose';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

export interface CommentData {
	id: string;
	content_type: string;
	// biome-ignore lint/suspicious/noExplicitAny: content varies by type
	content: any;
	// biome-ignore lint/suspicious/noExplicitAny: varies
	chosen_option?: any;
	author_name?: string;
	author_type?: string;
	created_at: string;
	tool_calls?: ToolCall[];
	reactions?: ReactionGroup[];
	attachments?: CommentAttachment[];
}

const REACTION_GLYPH: Record<string, string> = { ack: '✓' };
const REACTION_LABEL: Record<string, string> = { ack: 'Acknowledged' };
const AVAILABLE_REACTION_KINDS = ['ack'] as const;

interface ToolCall {
	id: string;
	tool_name: string;
	// biome-ignore lint/suspicious/noExplicitAny: varies
	input: any;
	// biome-ignore lint/suspicious/noExplicitAny: varies
	output: any;
	status: string;
	duration_ms: number | null;
	created_at: string;
}

interface RenderProps {
	comment: CommentData;
	onChooseOption?: (commentId: string, chosenId: string) => void;
	teamId?: string;
	projectId?: string;
	projectSlug?: string;
	issueId?: string;
	inline?: boolean;
}

export function isInlineEventType(contentType: string): boolean {
	return contentType === 'system' || contentType === 'run';
}

export function CommentRenderer({
	comment,
	onChooseOption,
	teamId,
	projectId,
	projectSlug,
	issueId,
	inline,
}: RenderProps) {
	switch (comment.content_type) {
		case 'run':
			return <RunComment comment={comment} teamId={teamId} inline={inline} />;
		case 'trace':
			return <TraceComment comment={comment} />;
		case 'options':
			return <OptionsComment comment={comment} onChoose={onChooseOption} />;
		case 'credential_request':
			return <CredentialRequestComment comment={comment} teamId={teamId} issueId={issueId} />;
		case 'preview':
			return <PreviewComment comment={comment} />;
		case 'system':
			return <SystemComment comment={comment} teamId={teamId} />;
		case 'action':
			return (
				<ActionComment comment={comment} teamId={teamId} projectId={projectId} issueId={issueId} />
			);
		default:
			return <TextComment comment={comment} teamId={teamId} projectSlug={projectSlug} />;
	}
}

type LucideIcon = ComponentType<SVGProps<SVGSVGElement>>;

function systemEventIcon(kind: string | undefined): LucideIcon {
	switch (kind) {
		case 'status_change':
			return ArrowRightLeft;
		case 'title_change':
			return Pencil;
		case 'assignee_change':
			return UserRoundCog;
		case 'issue_link':
			return Link2;
		case 'run_failed':
			return AlertTriangle;
		default:
			return Dot;
	}
}

export function inlineEventIcon(comment: CommentData): LucideIcon {
	if (comment.content_type === 'run') return Terminal;
	if (comment.content_type === 'system') {
		const content = typeof comment.content === 'object' ? comment.content : null;
		return systemEventIcon(content?.kind);
	}
	return Dot;
}

function ActionComment({
	comment,
	teamId,
	projectId,
}: {
	comment: CommentData;
	teamId?: string;
	projectId?: string;
	issueId?: string;
}) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const kind: string = content.kind ?? '';
	const resolved =
		typeof comment.chosen_option === 'object' &&
		comment.chosen_option &&
		comment.chosen_option.status === 'complete';

	if (kind !== 'setup_repo') {
		return <p className="text-xs text-text-subtle italic">Unknown action: {kind}</p>;
	}

	if (resolved) {
		const result = comment.chosen_option?.result ?? {};
		return (
			<div
				className="flex items-center gap-2 text-sm text-accent-green-text"
				data-testid="action-complete"
			>
				<Check className="w-4 h-4" />
				<span>Repository set: {result.repo_identifier ?? '(unknown)'}</span>
			</div>
		);
	}

	if (!teamId || !projectId) {
		return <p className="text-xs text-text-subtle italic">Repo setup unavailable in this view.</p>;
	}

	return (
		<div className="flex flex-col gap-2" data-testid="action-setup-repo">
			<div className="flex items-center gap-2 text-sm">
				<GitBranch className="w-4 h-4 text-accent-blue-text" />
				<span>
					This project has no designated repository yet. Add a repo URL in project settings, then
					this ticket will resume.
				</span>
			</div>
			<div>
				<Link to="/teams/$teamId/projects/$projectId/settings" params={{ teamId, projectId }}>
					<Button size="sm">Open project settings</Button>
				</Link>
			</div>
		</div>
	);
}

function runStatusLabel(status: string): string {
	if (status === 'timed_out') return 'timed out';
	return status;
}

function runStatusDotClass(status: string): string {
	if (status === 'running' || status === 'queued') return 'bg-accent-amber animate-pulse';
	if (status === 'succeeded') return 'bg-accent-green';
	if (status === 'failed' || status === 'timed_out') return 'bg-accent-red';
	return 'bg-text-subtle';
}

function RunComment({
	comment,
	teamId,
	inline,
}: {
	comment: CommentData;
	teamId?: string;
	inline?: boolean;
}) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const runId: string = content.run_id ?? '';
	const agentId: string = content.agent_id ?? '';
	const agentTitle: string = content.agent_title ?? 'Agent';

	if (!teamId || !runId || !agentId) {
		return <p className="text-xs text-text-subtle italic">Run reference missing.</p>;
	}

	return (
		<div className="flex flex-col gap-1.5" data-testid="run-comment">
			<LazyMount minHeight={210} testId="run-comment-lazy">
				<RunCommentBody
					teamId={teamId}
					runId={runId}
					agentId={agentId}
					agentTitle={agentTitle}
					createdAt={comment.created_at}
					inline={inline}
				/>
			</LazyMount>
		</div>
	);
}

function RunCommentBody({
	teamId,
	runId,
	agentId,
	agentTitle,
	createdAt,
	inline,
}: {
	teamId: string;
	runId: string;
	agentId: string;
	agentTitle: string;
	createdAt: string;
	inline?: boolean;
}) {
	const runQuery = useHeartbeatRun(teamId, agentId, runId);
	const run = runQuery.data;
	const status = run?.status ?? 'queued';
	const isActive = isActiveRunStatus(status);
	const { lines } = useRunLogs(run?.project_id, runId, run?.log_text, isActive);
	const createdIssues = run?.created_issues ?? [];
	const completed = run != null && !isActive;
	const durationMs =
		run?.started_at && run.finished_at
			? Math.max(0, new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
			: null;
	const [expanded, setExpanded] = useState(false);
	const logRegionId = `run-comment-log-${runId}`;

	const summaryRow = (
		<>
			<span className="text-xs text-text-muted">{agentTitle} run</span>
			{completed && (
				<span
					className="inline-flex items-baseline gap-1.5 text-xs text-text-subtle"
					data-testid="run-comment-summary"
				>
					<span
						aria-hidden="true"
						className={`inline-block w-2 h-2 rounded-full self-center ${runStatusDotClass(status)}`}
					/>
					<span>{runStatusLabel(status)}</span>
					<span aria-hidden="true">·</span>
					<span data-testid="run-comment-line-count">
						{lines.length} {lines.length === 1 ? 'line' : 'lines'}
					</span>
					{durationMs != null && (
						<>
							<span aria-hidden="true">·</span>
							<span data-testid="run-comment-duration">{formatElapsed(durationMs)}</span>
						</>
					)}
				</span>
			)}
			<span className="text-[11px] text-text-subtle">{new Date(createdAt).toLocaleString()}</span>
		</>
	);

	return (
		<>
			{inline &&
				(completed ? (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
						aria-controls={logRegionId}
						data-testid="run-comment-header"
						className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-left -mx-1 px-1 rounded-radius-md hover:bg-bg-muted cursor-pointer"
					>
						{summaryRow}
						<svg
							aria-hidden="true"
							className={`w-3 h-3 self-center shrink-0 ml-auto text-text-subtle transition-transform ${expanded ? 'rotate-90' : ''}`}
							viewBox="0 0 16 16"
							fill="currentColor"
						>
							<path d="M6 3l5 5-5 5V3z" />
						</svg>
					</button>
				) : (
					<div
						className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
						data-testid="run-comment-header"
					>
						{summaryRow}
					</div>
				))}
			{(!completed || expanded) && (
				<div id={logRegionId}>
					<LogViewer
						lines={lines}
						compact
						heightClassName="h-[180px]"
						testId="run-comment-log"
						liveLabel={
							<span className="flex items-center gap-1.5">
								<span
									className={`inline-block w-2 h-2 rounded-full ${runStatusDotClass(status)}`}
								/>
								<span>
									{agentTitle} — {runStatusLabel(status)}
								</span>
							</span>
						}
						emptyState={getRunWaitingMessage(status)}
						headerAction={
							<Link
								to="/teams/$teamId/agents/$agentId/executions/$runId"
								params={{ teamId, agentId, runId }}
								title="View full run"
								aria-label="View full run"
								className="inline-flex items-center justify-center h-6 px-2 text-xs text-text-muted hover:text-text hover:bg-bg-muted rounded-radius-md transition-colors"
							>
								<DoorOpen className="w-3 h-3" />
							</Link>
						}
					/>
				</div>
			)}
			{createdIssues.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-issues">
					<span className="text-xs text-text-subtle">Created tickets</span>
					{createdIssues.map((issue) => (
						<Link
							key={issue.id}
							to="/teams/$teamId/projects/$projectId/issues/$issueId"
							params={{
								teamId,
								projectId: issue.project_slug,
								issueId: issue.identifier.toLowerCase(),
							}}
							className="text-xs text-accent-blue-text hover:underline self-start"
						>
							{issue.identifier} — {issue.title}
						</Link>
					))}
				</div>
			)}
		</>
	);
}

function TextComment({
	comment,
	teamId,
	projectSlug,
}: {
	comment: CommentData;
	teamId?: string;
	projectSlug?: string;
}) {
	const content =
		typeof comment.content === 'object'
			? comment.content.text || JSON.stringify(comment.content)
			: String(comment.content);
	return (
		<>
			<MarkdownProse testId="text-comment-body" teamId={teamId} projectSlug={projectSlug}>
				{content}
			</MarkdownProse>
			{comment.attachments && comment.attachments.length > 0 ? (
				<div className="mt-2 flex flex-wrap gap-1.5" data-testid="comment-attachments">
					{comment.attachments.map((a) => (
						<CommentAttachmentThumb key={a.id} attachment={a} />
					))}
				</div>
			) : null}
		</>
	);
}

function SystemComment({ comment, teamId }: { comment: CommentData; teamId?: string }) {
	const content = typeof comment.content === 'object' ? comment.content : null;
	const timestamp = (
		<span className="text-[11px] text-text-subtle">
			{new Date(comment.created_at).toLocaleString()}
		</span>
	);

	if (content?.kind === 'issue_link' && teamId) {
		return (
			<div className="flex items-baseline gap-2 leading-[26px]">
				<IssueLinkSystemBody comment={comment} teamId={teamId} />
				{timestamp}
			</div>
		);
	}

	if (content?.kind === 'status_change') {
		const actorName = comment.author_name ?? 'Board';
		const from = typeof content.from === 'string' ? content.from : '';
		const to = typeof content.to === 'string' ? content.to : '';
		return (
			<div className="flex items-baseline gap-2 leading-[26px]">
				<span className="text-xs text-text-muted">
					{actorName} changed status from <em className="italic">{formatIssueStatus(from)}</em> to{' '}
					<em className="italic">{formatIssueStatus(to)}</em>
				</span>
				{timestamp}
			</div>
		);
	}

	if (content?.kind === 'run_failed') {
		const agentSlug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
		const status = typeof content.status === 'string' ? content.status : 'failed';
		const error =
			typeof content.error === 'string' && content.error.length > 0 ? content.error : null;
		const statusLabel = status === 'timed_out' ? 'timed out' : 'failed';
		const agentNode =
			agentSlug && teamId ? (
				<Link
					to="/teams/$teamId/agents/$agentId"
					params={{ teamId, agentId: agentSlug }}
					className="text-xs text-accent-blue-text hover:underline"
					data-testid="run-failed-agent"
				>
					@{agentSlug}
				</Link>
			) : (
				<span className="text-xs text-text-muted">agent</span>
			);
		return (
			<div
				className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
				data-testid="run-failed-comment"
			>
				<span className="text-xs text-text-muted">
					Run for {agentNode} {statusLabel}
					{error ? <span className="text-text-subtle">: {error}</span> : null}. Waking agent to
					retry.
				</span>
				{timestamp}
			</div>
		);
	}

	const text = content ? content.text || JSON.stringify(content) : String(comment.content);
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-muted">{text}</span>
			{timestamp}
		</div>
	);
}

function IssueLinkSystemBody({ comment, teamId }: { comment: CommentData; teamId: string }) {
	const content = comment.content as {
		source_identifier?: string;
		source_project_slug?: string;
		actor_name?: string;
		actor_kind?: 'agent' | 'user' | 'board';
		actor_slug?: string | null;
		text?: string;
	};
	const sourceIdentifier = content.source_identifier ?? '';
	const sourceProjectSlug = content.source_project_slug ?? '';
	const actorName = content.actor_name ?? comment.author_name ?? 'Board';
	const actorKind = content.actor_kind ?? null;
	const actorSlug = content.actor_slug ?? null;

	const linkClass = 'text-xs text-accent-blue-text hover:underline';
	const textClass = 'text-xs text-text-muted';

	const sourceNode =
		sourceIdentifier && sourceProjectSlug ? (
			<Link
				to="/teams/$teamId/projects/$projectId/issues/$issueId"
				params={{
					teamId,
					projectId: sourceProjectSlug,
					issueId: sourceIdentifier.toLowerCase(),
				}}
				className={linkClass}
				data-testid="issue-link-source"
			>
				{sourceIdentifier}
			</Link>
		) : (
			<span className={textClass}>{sourceIdentifier}</span>
		);

	const actorNode =
		actorKind === 'agent' && actorSlug ? (
			<Link
				to="/teams/$teamId/agents/$agentId"
				params={{ teamId, agentId: actorSlug }}
				className={linkClass}
				data-testid="issue-link-actor"
			>
				{actorName}
			</Link>
		) : (
			<span className={textClass}>{actorName}</span>
		);

	return (
		<span className={textClass}>
			Linked from {sourceNode} by {actorNode}
		</span>
	);
}

function TraceComment({ comment }: { comment: CommentData }) {
	const [expanded, setExpanded] = useState(false);
	const toolCalls = comment.tool_calls ?? [];
	const content = typeof comment.content === 'object' ? comment.content : {};
	const summary =
		content.summary || `${toolCalls.length} tool call${toolCalls.length !== 1 ? 's' : ''}`;

	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text"
			>
				{expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
				<Terminal className="w-3 h-3" />
				<span>{summary}</span>
			</button>

			{expanded && toolCalls.length > 0 && (
				<div className="mt-2 space-y-1.5 pl-4 border-l-2 border-border">
					{toolCalls.map((tc) => (
						<ToolCallEntry key={tc.id} toolCall={tc} />
					))}
				</div>
			)}
		</div>
	);
}

function ToolCallEntry({ toolCall }: { toolCall: ToolCall }) {
	const [showDetails, setShowDetails] = useState(false);

	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => setShowDetails(!showDetails)}
				className="flex items-center gap-1.5 text-text-muted hover:text-text"
			>
				{showDetails ? (
					<ChevronDown className="w-2.5 h-2.5" />
				) : (
					<ChevronRight className="w-2.5 h-2.5" />
				)}
				<span className="font-mono font-medium text-text">{toolCall.tool_name}</span>
				<Badge color={toolCall.status === 'success' ? 'green' : 'red'} className="text-[9px]">
					{toolCall.status}
				</Badge>
				{toolCall.duration_ms != null && (
					<span className="text-text-subtle">{toolCall.duration_ms}ms</span>
				)}
			</button>
			{showDetails && (
				<div className="mt-1 ml-4 space-y-1">
					{toolCall.input && (
						<pre className="text-[10px] bg-bg-muted p-1.5 rounded overflow-x-auto max-h-24 text-text-muted">
							{JSON.stringify(toolCall.input, null, 2)}
						</pre>
					)}
					{toolCall.output && (
						<pre className="text-[10px] bg-bg-muted p-1.5 rounded overflow-x-auto max-h-24 text-text-muted">
							{typeof toolCall.output === 'string'
								? (toolCall.output as string).slice(0, 500)
								: JSON.stringify(toolCall.output, null, 2).slice(0, 500)}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}

function OptionsComment({
	comment,
	onChoose,
}: {
	comment: CommentData;
	onChoose?: (commentId: string, chosenId: string) => void;
}) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const prompt = content.prompt || '';
	const options = (content.options || []) as { id: string; label: string; description?: string }[];
	const chosenId: string | null =
		typeof comment.chosen_option === 'object' && comment.chosen_option
			? comment.chosen_option.chosen_id
			: null;

	return (
		<div>
			{prompt && <p className="text-sm text-text mb-2">{prompt}</p>}
			<div className="grid gap-2 grid-cols-1 sm:grid-cols-2">
				{options.map((opt) => {
					const isChosen = chosenId === opt.id;
					const isOther = chosenId && !isChosen;
					return (
						<button
							key={opt.id}
							type="button"
							disabled={!!chosenId}
							onClick={() => onChoose?.(comment.id, opt.id)}
							className={`text-left p-2.5 rounded-lg border transition-colors ${
								isChosen
									? 'border-accent-blue bg-accent-blue-bg'
									: isOther
										? 'border-border bg-bg-subtle opacity-50'
										: 'border-border hover:border-border-hover cursor-pointer'
							}`}
						>
							<div className="flex items-center gap-1.5">
								{isChosen && <Check className="w-3.5 h-3.5 text-accent-blue-text shrink-0" />}
								<span className="text-sm font-medium text-text">{opt.label}</span>
							</div>
							{opt.description && (
								<p className="text-xs text-text-muted mt-0.5">{opt.description}</p>
							)}
						</button>
					);
				})}
			</div>
		</div>
	);
}

function CredentialRequestComment({
	comment,
	teamId,
	issueId,
}: {
	comment: CommentData;
	teamId?: string;
	issueId?: string;
}) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const name: string = content.name ?? '';
	const kind: string = content.kind ?? 'other';
	const instructions: string = content.instructions ?? '';
	const inputType: string = content.input_type ?? 'text';
	const confirmationText: string | null = content.confirmation_text ?? null;
	const placeholder: string = content.placeholder ?? `__HEZO_SECRET_${name}__`;
	const allowedHosts: string[] = Array.isArray(content.allowed_hosts) ? content.allowed_hosts : [];
	const fulfilled =
		typeof comment.chosen_option === 'object' &&
		comment.chosen_option &&
		typeof comment.chosen_option.secret_id === 'string';

	const [value, setValue] = useState('');
	const [error, setError] = useState<string | null>(null);
	const fulfill = useFulfillCredential(teamId ?? '', issueId ?? '');

	if (!teamId || !issueId) {
		return (
			<p className="text-xs text-text-subtle italic">
				Credential request unavailable in this view.
			</p>
		);
	}

	if (fulfilled) {
		return (
			<div
				className="flex items-start gap-2 p-2.5 rounded-lg border border-accent-green bg-accent-green-bg"
				data-testid="credential-fulfilled"
			>
				<Check className="w-4 h-4 text-accent-green-text shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text">{name} provided</p>
					<p className="text-xs text-text-muted mt-0.5">
						Stored as a secret. Agent will use the placeholder{' '}
						<code className="px-1 py-0.5 rounded bg-bg-subtle">{placeholder}</code> in env vars and
						HTTP headers; the egress proxy substitutes the real value at request time.
					</p>
				</div>
			</div>
		);
	}

	const submit = () => {
		setError(null);
		const args = confirmationText
			? { commentId: comment.id, confirmed: true }
			: { commentId: comment.id, value };
		fulfill.mutate(args, {
			onError: (e: unknown) => {
				const msg = e instanceof Error ? e.message : 'Failed to submit';
				setError(msg);
			},
		});
	};

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-accent-amber bg-accent-amber-bg"
			data-testid="credential-request"
			data-credential-name={name}
		>
			<div className="flex items-start gap-2">
				<KeyRound className="w-4 h-4 text-accent-amber-text shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text">
						Agent needs credential: <code className="px-1 py-0.5 rounded bg-bg-subtle">{name}</code>{' '}
						<Badge className="ml-1">{kind}</Badge>
					</p>
					{instructions && (
						<div className="mt-1.5 text-sm text-text">
							<MarkdownProse>{instructions}</MarkdownProse>
						</div>
					)}
					{allowedHosts.length > 0 && (
						<p className="text-xs text-text-muted mt-1">
							Substituted only into requests to: {allowedHosts.join(', ')}
						</p>
					)}
				</div>
			</div>

			{confirmationText ? (
				<div className="flex flex-col gap-2">
					<p className="text-sm text-text">{confirmationText}</p>
					<div>
						<Button
							size="sm"
							onClick={submit}
							disabled={fulfill.isPending}
							data-testid="credential-confirm"
						>
							{fulfill.isPending ? 'Submitting…' : 'Confirm'}
						</Button>
					</div>
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{inputType === 'textarea' ? (
						<textarea
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="Paste value here"
							rows={6}
							className="w-full font-mono text-xs p-2 rounded border border-border bg-bg focus:outline-none focus:border-accent-blue"
							data-testid="credential-input"
						/>
					) : inputType === 'file' ? (
						<input
							type="file"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (!file) return;
								file.text().then(setValue);
							}}
							className="text-sm"
							data-testid="credential-input"
						/>
					) : (
						<input
							type="password"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="Paste value here"
							autoComplete="off"
							className="w-full text-sm p-2 rounded border border-border bg-bg focus:outline-none focus:border-accent-blue"
							data-testid="credential-input"
						/>
					)}
					{error && <p className="text-xs text-accent-red-text">{error}</p>}
					<div>
						<Button
							size="sm"
							onClick={submit}
							disabled={fulfill.isPending || value.length === 0}
							data-testid="credential-submit"
						>
							{fulfill.isPending ? 'Storing…' : 'Provide credential'}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

function reactorName(m: { slug: string | null; display_name: string | null }): string {
	if (m.slug) return `@${m.slug}`;
	return m.display_name ?? 'someone';
}

function reactorsTooltip(group: ReactionGroup): string {
	const names = group.members.map(reactorName);
	if (names.length === 0) return REACTION_LABEL[group.kind] ?? group.kind;
	return `${REACTION_LABEL[group.kind] ?? group.kind} · ${names.join(', ')}`;
}

export function CommentReactions({
	comment,
	teamId,
	issueId,
}: {
	comment: CommentData;
	teamId?: string;
	issueId?: string;
}) {
	const groups = comment.reactions ?? [];
	const [pickerOpen, setPickerOpen] = useState(false);
	const addReaction = useAddReaction(teamId ?? '', issueId ?? '');
	const removeReaction = useRemoveReaction(teamId ?? '', issueId ?? '');

	if (!teamId || !issueId) return null;
	const busy = addReaction.isPending || removeReaction.isPending;

	const toggle = (kind: string, youReacted: boolean) => {
		if (busy) return;
		if (youReacted) removeReaction.mutate({ commentId: comment.id, kind });
		else addReaction.mutate({ commentId: comment.id, kind });
	};

	const availableToAdd = AVAILABLE_REACTION_KINDS.filter(
		(k) => !groups.some((g) => g.kind === k && g.you_reacted),
	);

	if (groups.length === 0 && availableToAdd.length === 0) return null;

	return (
		<div className="flex flex-wrap items-center gap-1.5 mt-2" data-testid="comment-reactions">
			{groups.map((g) => (
				<button
					key={g.kind}
					type="button"
					onClick={() => toggle(g.kind, g.you_reacted)}
					disabled={busy}
					title={reactorsTooltip(g)}
					aria-pressed={g.you_reacted}
					data-reaction-kind={g.kind}
					data-you-reacted={g.you_reacted ? 'true' : 'false'}
					className={`inline-flex items-center gap-1 min-h-[28px] px-2 rounded-full border text-xs leading-none transition-colors ${
						g.you_reacted
							? 'border-accent-blue bg-accent-blue-bg text-accent-blue-text'
							: 'border-border bg-bg-subtle text-text-muted hover:border-border-hover'
					} disabled:opacity-60`}
				>
					<span aria-hidden="true">{REACTION_GLYPH[g.kind] ?? g.kind}</span>
					<span className="tabular-nums">{g.members.length}</span>
				</button>
			))}
			{availableToAdd.length > 0 && (
				<div className="relative">
					<button
						type="button"
						onClick={() => setPickerOpen((open) => !open)}
						disabled={busy}
						aria-label="Add reaction"
						data-testid="add-reaction-button"
						className="inline-flex items-center justify-center min-w-[28px] min-h-[28px] px-1.5 rounded-full border border-border text-text-muted hover:text-text hover:border-border-hover disabled:opacity-60"
					>
						<Smile className="w-3.5 h-3.5" />
					</button>
					{pickerOpen && (
						<div
							className="absolute z-10 mt-1 flex gap-1 rounded-md border border-border bg-bg-elevated p-1 shadow-md"
							role="menu"
							data-testid="reaction-picker"
						>
							{availableToAdd.map((kind) => (
								<button
									key={kind}
									type="button"
									onClick={() => {
										setPickerOpen(false);
										toggle(kind, false);
									}}
									title={REACTION_LABEL[kind] ?? kind}
									className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] px-2 rounded text-sm hover:bg-bg-subtle"
									data-reaction-kind={kind}
								>
									{REACTION_GLYPH[kind] ?? kind}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

function PreviewComment({ comment }: { comment: CommentData }) {
	const content = typeof comment.content === 'object' ? comment.content : {};
	const url = content.url || content.preview_url || '';
	const title = content.title || 'Preview';

	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 text-sm text-accent-blue-text hover:underline"
		>
			<ExternalLink className="w-3.5 h-3.5" />
			{title}
		</a>
	);
}
