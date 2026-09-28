import { formatMoneyUsd, formatTaskStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { Fragment, useState } from 'react';
import { repoWebUrl } from '../../lib/github';
import { type MessageKey, Trans, useI18n } from '../../lib/i18n';
import {
	budgetConversionIntroKey,
	CREDENTIAL_MODEL_INTRO_KEYS,
	handoffAgentSlugs,
	noticeParts,
} from '../../lib/system-notice-text';
import { AgentLink } from '../agent-link';
import type {
	BudgetConversionScope,
	SystemBudgetConversionContent,
	SystemBudgetPausedContent,
	SystemContent,
	SystemCredentialModelContent,
	SystemDescriptionChangeContent,
	SystemHandoffLimitContent,
	SystemParentChangeContent,
	SystemRepoDesignatedContent,
	SystemRunAbandonedContent,
	SystemRunFailedContent,
	SystemRunSizeStopContent,
	SystemStatusChangeContent,
	SystemTaskLinkContent,
	SystemTaskTokenCeilingContent,
} from '../comment-content';
import { ActorBadge } from '../ui/actor-badge';
import type { CommentDataOf } from './comment-data';
import { CommentTimestampLink } from './comment-timestamp-link';

interface Props {
	comment: CommentDataOf<'system'>;
	projectId?: string;
}

function isTaskLink(c: SystemContent): c is SystemTaskLinkContent {
	return c.kind === 'task_link';
}
function isStatusChange(c: SystemContent): c is SystemStatusChangeContent {
	return c.kind === 'status_change';
}
function isRunFailed(c: SystemContent): c is SystemRunFailedContent {
	return c.kind === 'run_failed';
}
function isRunAbandoned(c: SystemContent): c is SystemRunAbandonedContent {
	return c.kind === 'run_abandoned';
}
function isHandoffLimit(c: SystemContent): c is SystemHandoffLimitContent {
	return c.kind === 'handoff_limit';
}
/** A notice whose whole body is its one translated sentence. */
function isSentenceNotice(
	c: SystemContent,
): c is SystemTaskTokenCeilingContent | SystemRunSizeStopContent {
	return c.kind === 'task_token_ceiling' || c.kind === 'run_size_stop';
}
function isBudgetPaused(c: SystemContent): c is SystemBudgetPausedContent {
	return c.kind === 'budget_paused';
}
function isBudgetConversion(c: SystemContent): c is SystemBudgetConversionContent {
	return c.kind === 'budget_conversion';
}
function isCredentialModel(c: SystemContent): c is SystemCredentialModelContent {
	return c.kind === 'default_model_backfill' || c.kind === 'credential_model_unlisted';
}
function isRepoDesignated(c: SystemContent): c is SystemRepoDesignatedContent {
	return c.kind === 'repo_designated';
}
function isParentChange(c: SystemContent): c is SystemParentChangeContent {
	return c.kind === 'parent_change';
}
function isDescriptionChange(c: SystemContent): c is SystemDescriptionChangeContent {
	return c.kind === 'description_change';
}

export function SystemComment({ comment, projectId }: Props) {
	const content: SystemContent | null =
		comment.content && typeof comment.content === 'object' ? comment.content : null;
	const timestamp = (
		<CommentTimestampLink publicId={comment.public_id} createdAt={comment.created_at} />
	);

	if (content && isTaskLink(content) && projectId) {
		// The sentence gained a clause, so stack the timestamp under it on mobile
		// rather than letting it wrap mid-clause (same idiom as RunFailedBody).
		return (
			<div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]">
				<TaskLinkSystemBody comment={comment} content={content} projectId={projectId} />
				{timestamp}
			</div>
		);
	}

	if (content && isStatusChange(content)) {
		return (
			<StatusChangeBody
				comment={comment}
				content={content}
				projectId={projectId}
				timestamp={timestamp}
			/>
		);
	}

	if (content && isRunFailed(content)) {
		return <RunFailedBody content={content} projectId={projectId} timestamp={timestamp} />;
	}

	if (content && isRunAbandoned(content)) {
		return <RunAbandonedBody content={content} projectId={projectId} timestamp={timestamp} />;
	}

	if (content && isHandoffLimit(content)) {
		return <HandoffLimitBody content={content} projectId={projectId} timestamp={timestamp} />;
	}

	if (content && isSentenceNotice(content)) {
		return <SentenceNoticeBody content={content} timestamp={timestamp} />;
	}

	if (content && isBudgetPaused(content)) {
		return <BudgetPausedBody content={content} projectId={projectId} timestamp={timestamp} />;
	}

	if (content && isBudgetConversion(content)) {
		return <BudgetConversionBody content={content} timestamp={timestamp} />;
	}

	if (content && isCredentialModel(content)) {
		return <CredentialModelBody content={content} timestamp={timestamp} />;
	}

	if (content && isRepoDesignated(content)) {
		return <RepoDesignatedBody content={content} timestamp={timestamp} />;
	}

	if (content && isParentChange(content)) {
		return <ParentChangeBody comment={comment} content={content} timestamp={timestamp} />;
	}

	if (content && isDescriptionChange(content)) {
		return <DescriptionChangeBody comment={comment} content={content} timestamp={timestamp} />;
	}

	const text = content
		? (content.text ?? JSON.stringify(content))
		: comment.content
			? String(comment.content)
			: '';
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-2">{text}</span>
			<ActorBadge actorType={comment.author_type} name={comment.author_name} />
			{timestamp}
		</div>
	);
}

function StatusChangeBody({
	comment,
	content,
	projectId,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemStatusChangeContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const from = typeof content.from === 'string' ? content.from : '';
	const to = typeof content.to === 'string' ? content.to : '';
	const cascade = typeof content.cascade === 'string' ? content.cascade : null;
	if (cascade === 'auto_unblock' && projectId) {
		const triggeredIdentifier =
			typeof content.triggered_by_identifier === 'string' ? content.triggered_by_identifier : '';
		const triggeredProjectSlug =
			typeof content.triggered_by_project_slug === 'string'
				? content.triggered_by_project_slug
				: '';
		const triggerNode =
			triggeredIdentifier && triggeredProjectSlug ? (
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{
						projectId: triggeredProjectSlug,
						taskId: triggeredIdentifier.toLowerCase(),
					}}
					className="text-xs text-info-soft-fg hover:underline"
					data-testid="cascade-trigger-task"
				>
					{triggeredIdentifier}
				</Link>
			) : (
				<span className="text-xs text-text-2">
					{triggeredIdentifier || t('comment.autoUnblockedFallback')}
				</span>
			);
		return (
			<div className="flex items-baseline gap-2 leading-[26px]" data-testid="status-change-cascade">
				<span className="text-xs text-text-2">
					<Trans k="comment.autoUnblocked" vars={{ trigger: triggerNode }} />
				</span>
				{timestamp}
			</div>
		);
	}
	const actorName = comment.author_name ?? 'Admin';
	return (
		<div className="flex items-baseline gap-2 leading-[26px]">
			<span className="text-xs text-text-2">
				<Trans
					k="comment.statusChanged"
					vars={{
						actor: actorName,
						from: <em className="italic">{formatTaskStatus(from)}</em>,
						to: <em className="italic">{formatTaskStatus(to)}</em>,
					}}
				/>
			</span>
			<ActorBadge actorType={comment.author_type} name={actorName} />
			{timestamp}
		</div>
	);
}

function ParentChangeBody({
	comment,
	content,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemParentChangeContent;
	timestamp: React.ReactNode;
}) {
	const actorName = comment.author_name ?? 'Admin';

	// The recorder carries each end's project slug so the identifiers can link
	// without a second fetch. An end missing its slug still renders as plain text.
	const end = (identifier?: string | null, projectSlug?: string | null, testId?: string) => {
		if (!identifier) return null;
		if (!projectSlug) return <span className="text-xs text-text-2">{identifier}</span>;
		return (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{ projectId: projectSlug, taskId: identifier.toLowerCase() }}
				className="text-xs text-info-soft-fg hover:underline"
				data-testid={testId}
			>
				{identifier}
			</Link>
		);
	};

	const from = end(content.from_identifier, content.from_project_slug, 'parent-change-from');
	const to = end(content.to_identifier, content.to_project_slug, 'parent-change-to');

	const body =
		from && to ? (
			<Trans k="comment.parentMoved" vars={{ actor: actorName, from, to }} />
		) : to ? (
			<Trans k="comment.parentNested" vars={{ actor: actorName, to }} />
		) : from ? (
			<Trans k="comment.parentPromotedFrom" vars={{ actor: actorName, from }} />
		) : (
			<Trans k="comment.parentPromoted" vars={{ actor: actorName }} />
		);

	return (
		<div className="flex items-baseline gap-2 leading-[26px]" data-testid="parent-change-comment">
			<span className="text-xs text-text-2">{body}</span>
			<ActorBadge actorType={comment.author_type} name={actorName} />
			{timestamp}
		</div>
	);
}

/**
 * A description edit. The payload carries a capped preview of each end rather
 * than the bodies (see `SystemDescriptionChangeContent`), so the expanded view
 * renders them as plain text with a trailing ellipsis where the preview was cut,
 * never as markdown - it is a quote of what changed, not a second copy of the
 * description. Stacked at every breakpoint: this sits inside the narrow
 * inline-event row, so there is no room for side-by-side.
 */
function DescriptionChangeBody({
	comment,
	content,
	timestamp,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemDescriptionChangeContent;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState(false);
	const actorName = comment.author_name ?? 'Admin';
	const from = content.from_preview ?? '';
	const to = content.to_preview ?? '';
	const hasPreview = from.length > 0 || to.length > 0;

	const end = (label: string, text: string, truncated: boolean | undefined, testId: string) =>
		text ? (
			<div className="min-w-0">
				<span className="text-[11px] uppercase tracking-wider font-medium text-text-3">
					{label}
				</span>
				<p
					className="mt-0.5 whitespace-pre-wrap break-words text-xs text-text-2"
					data-testid={testId}
				>
					{truncated ? `${text}…` : text}
				</p>
			</div>
		) : null;

	return (
		<div className="flex flex-col gap-1" data-testid="description-change-comment">
			{/* Wraps rather than overflowing: this row carries one more control than
			    its siblings, and it sits in a column that is only ~340px wide on a
			    375px viewport. */}
			<div className="flex flex-wrap items-baseline gap-2 leading-[26px]">
				<span className="min-w-0 text-xs text-text-2">
					{content.text ?? `${actorName} updated the description`}
				</span>
				<ActorBadge actorType={comment.author_type} name={actorName} />
				{timestamp}
				{hasPreview && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						aria-expanded={expanded}
						aria-label={t('tasks.descriptionChange.toggle')}
						title={t('tasks.descriptionChange.toggle')}
						data-testid="description-change-toggle"
						className="shrink-0 text-text-3 hover:text-text-1"
					>
						<ChevronDown
							className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
						/>
					</button>
				)}
			</div>
			{expanded && hasPreview && (
				<div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 px-2.5 py-2">
					{end(
						t('tasks.descriptionChange.before'),
						from,
						content.from_truncated,
						'description-change-before',
					)}
					{end(
						t('tasks.descriptionChange.after'),
						to,
						content.to_truncated,
						'description-change-after',
					)}
				</div>
			)}
		</div>
	);
}

function RunFailedBody({
	content,
	projectId,
	timestamp,
}: {
	content: SystemRunFailedContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const agentSlug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
	const status = typeof content.status === 'string' ? content.status : 'failed';
	const error =
		typeof content.error === 'string' && content.error.length > 0 ? content.error : null;
	const timedOut = status === 'timed_out';
	const agentNode =
		agentSlug && projectId ? (
			<AgentLink
				projectId={projectId}
				agentId={agentSlug}
				className="text-xs text-info-soft-fg hover:underline"
				testId="run-failed-agent"
			>
				@{agentSlug}
			</AgentLink>
		) : (
			<span className="text-xs text-text-2">{t('comment.runAgentFallback')}</span>
		);
	// Four keys rather than two with a {status} var: the status word inflects with
	// the sentence in several of these languages, so a shared template would force
	// a wrong agreement somewhere.
	const key = error
		? timedOut
			? 'comment.runTimedOutWithError'
			: 'comment.runFailedWithError'
		: timedOut
			? 'comment.runTimedOut'
			: 'comment.runFailed';
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid="run-failed-comment"
		>
			<span className="text-xs text-text-2 inline-flex items-baseline gap-1.5 flex-wrap">
				<span>
					<Trans
						k={key}
						vars={{
							agent: agentNode,
							error: error ? <span className="text-text-3">{error}</span> : null,
						}}
					/>
				</span>
			</span>
			{timestamp}
		</div>
	);
}

/**
 * Deliberately shaped like `RunFailedBody` rather than sharing with it: the two
 * sentences differ in every language (one reports a failure, the other reports
 * that nothing ran and nothing will), and folding them into one template with a
 * variable would force a wrong agreement somewhere.
 */
function RunAbandonedBody({
	content,
	projectId,
	timestamp,
}: {
	content: SystemRunAbandonedContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const agentSlug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
	const agentNode =
		agentSlug && projectId ? (
			<AgentLink
				projectId={projectId}
				agentId={agentSlug}
				className="text-xs text-info-soft-fg hover:underline"
				testId="run-abandoned-agent"
			>
				@{agentSlug}
			</AgentLink>
		) : (
			<span className="text-xs text-text-2">{t('comment.runAgentFallback')}</span>
		);
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid="run-abandoned-comment"
		>
			<span className="text-xs text-text-2 inline-flex items-baseline gap-1.5 flex-wrap">
				<span>
					<Trans k="comment.runAbandoned" vars={{ agent: agentNode }} />
				</span>
			</span>
			{timestamp}
		</div>
	);
}

/**
 * The handoff-limit notice: which agents went back and forth, how many times,
 * and what it used. The agents are joined by the reader's own list rules.
 */
function HandoffLimitBody({
	content,
	projectId,
	timestamp,
}: {
	content: SystemHandoffLimitContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const i18n = useI18n();
	const parts = noticeParts(content, i18n);
	const slugs = handoffAgentSlugs(content);
	let element = 0;
	const agentsNode =
		slugs.length > 0 ? (
			new Intl.ListFormat(i18n.language, { type: 'conjunction' })
				.formatToParts(slugs.map((slug) => `@${slug}`))
				.map((part) => {
					// A separator always follows the element before it, whose slug is unique.
					if (part.type !== 'element') {
						return <Fragment key={`after-${slugs[element - 1]}`}>{part.value}</Fragment>;
					}
					const slug = slugs[element++];
					return projectId ? (
						<AgentLink
							key={slug}
							projectId={projectId}
							agentId={slug}
							className="text-xs text-info-soft-fg hover:underline"
							testId="handoff-limit-agent"
						>
							@{slug}
						</AgentLink>
					) : (
						<span key={slug}>@{slug}</span>
					);
				})
		) : (
			<span>{i18n.t('comment.runAgentFallback')}</span>
		);
	if (!parts) return null;
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid="handoff-limit-comment"
		>
			<span className="text-xs text-text-2">
				<Trans k={parts.key} vars={{ ...parts.vars, agents: agentsNode }} />
			</span>
			{timestamp}
		</div>
	);
}

/** The per-task token ceiling notice: what was used against the ceiling. */
function SentenceNoticeBody({
	content,
	timestamp,
}: {
	content: SystemTaskTokenCeilingContent | SystemRunSizeStopContent;
	timestamp: React.ReactNode;
}) {
	const i18n = useI18n();
	const parts = noticeParts(content, i18n);
	if (!parts) return null;
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid={`${content.kind.replaceAll('_', '-')}-comment`}
		>
			<span className="text-xs text-text-2">{i18n.t(parts.key, parts.vars)}</span>
			{timestamp}
		</div>
	);
}

/** A budget paused an agent: whose budget, which window, and what was used. */
function BudgetPausedBody({
	content,
	projectId,
	timestamp,
}: {
	content: SystemBudgetPausedContent;
	projectId?: string;
	timestamp: React.ReactNode;
}) {
	const i18n = useI18n();
	const parts = noticeParts(content, i18n);
	const slug = parts?.agentSlugs[0];
	const agentNode =
		slug && projectId ? (
			<AgentLink
				projectId={projectId}
				agentId={slug}
				className="text-xs text-info-soft-fg hover:underline"
				testId="budget-paused-agent"
			>
				@{slug}
			</AgentLink>
		) : (
			<span>{parts?.vars.agent}</span>
		);
	if (!parts) return null;
	return (
		<div
			className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2 leading-[26px]"
			data-testid="budget-paused-comment"
		>
			<span className="text-xs text-text-2">
				<Trans k={parts.key} vars={{ ...parts.vars, agent: agentNode }} />
			</span>
			{timestamp}
		</div>
	);
}

const CONVERSION_LINE_KEYS: Record<'daily' | 'weekly' | 'monthly', MessageKey> = {
	daily: 'comment.budgetConversion.line.daily',
	weekly: 'comment.budgetConversion.line.weekly',
	monthly: 'comment.budgetConversion.line.monthly',
};

const INVALID_BUDGET_KEYS: Record<'daily' | 'weekly' | 'monthly', MessageKey> = {
	daily: 'comment.budgetConversion.invalid.daily',
	weekly: 'comment.budgetConversion.invalid.weekly',
	monthly: 'comment.budgetConversion.invalid.monthly',
};

/** The same subjects where the row names no project or team to place them in. */
const CONVERSION_SUBJECT_PLAIN_KEYS: Record<BudgetConversionScope, MessageKey> = {
	agent: 'comment.budgetConversion.subject.agentPlain',
	project: 'comment.budgetConversion.subject.project',
	agent_type: 'comment.budgetConversion.subject.agentType',
	team_type: 'comment.budgetConversion.subject.agentType',
	hire_proposal: 'comment.budgetConversion.subject.hireProposalPlain',
};

/** How each converted budget names itself, so two lines with one name read apart. */
const CONVERSION_SUBJECT_KEYS: Record<BudgetConversionScope, MessageKey> = {
	agent: 'comment.budgetConversion.subject.agent',
	project: 'comment.budgetConversion.subject.project',
	agent_type: 'comment.budgetConversion.subject.agentType',
	team_type: 'comment.budgetConversion.subject.teamType',
	hire_proposal: 'comment.budgetConversion.subject.hireProposal',
};

/** The upgrade's conversion of dollar budgets to tokens, one line per budget. */
function BudgetConversionBody({
	content,
	timestamp,
}: {
	content: SystemBudgetConversionContent;
	timestamp: React.ReactNode;
}) {
	const { t, formatNumber, number_format } = useI18n();
	const rate = formatNumber(Math.round(Number(content.tokens_per_cent ?? 0) * 100));
	const conversions = Array.isArray(content.conversions) ? content.conversions : [];
	const invalid = Array.isArray(content.invalid) ? content.invalid : [];
	// Without a context there is nothing for "in {context}" to name, so the line
	// falls back to the plain subject rather than ending on a dangling preposition.
	const subject = (scope: BudgetConversionScope, name: string, context?: string | null) =>
		context
			? t(CONVERSION_SUBJECT_KEYS[scope] ?? CONVERSION_SUBJECT_KEYS.agent, { name, context })
			: t(CONVERSION_SUBJECT_PLAIN_KEYS[scope] ?? CONVERSION_SUBJECT_PLAIN_KEYS.agent, { name });
	return (
		<div className="flex flex-col gap-1 leading-[22px]" data-testid="budget-conversion-comment">
			<span className="text-xs text-text-2">{t(budgetConversionIntroKey(content), { rate })}</span>
			<ul className="ml-4 list-disc text-xs text-text-2">
				{conversions.map((c) => (
					<li key={`${c.scope}-${c.id}-${c.window}`}>
						{t(CONVERSION_LINE_KEYS[c.window] ?? CONVERSION_LINE_KEYS.monthly, {
							name: subject(c.scope, c.name, c.context),
							dollars: formatMoneyUsd(c.cents, number_format),
							tokens: formatNumber(c.tokens),
						})}
					</li>
				))}
				{invalid.map((b) => (
					<li key={`invalid-${b.id}-${b.window}`}>
						{t(INVALID_BUDGET_KEYS[b.window] ?? INVALID_BUDGET_KEYS.monthly, {
							name: subject('hire_proposal', b.name, b.context),
							value: b.value,
						})}
					</li>
				))}
			</ul>
			{timestamp}
		</div>
	);
}

function CredentialModelBody({
	content,
	timestamp,
}: {
	content: SystemCredentialModelContent;
	timestamp: React.ReactNode;
}) {
	const { t } = useI18n();
	const credentials = Array.isArray(content.credentials) ? content.credentials : [];
	return (
		<div className="flex flex-col gap-1 leading-[22px]" data-testid="credential-model-comment">
			<span className="text-xs text-text-2">{t(CREDENTIAL_MODEL_INTRO_KEYS[content.kind])}</span>
			<ul className="ml-4 list-disc text-xs text-text-2 break-words">
				{credentials.map((c) => (
					<li key={`${c.provider}-${c.label}`}>
						{c.model
							? t('comment.credentialModel.runs', {
									name: c.label,
									provider: c.provider,
									model: c.model,
								})
							: t('comment.credentialModel.lineNeedsChoice', {
									name: c.label,
									provider: c.provider,
								})}
					</li>
				))}
			</ul>
			{timestamp}
		</div>
	);
}

function RepoDesignatedBody({
	content,
	timestamp,
}: {
	content: SystemRepoDesignatedContent;
	timestamp: React.ReactNode;
}) {
	const identifier = typeof content.repo_identifier === 'string' ? content.repo_identifier : '';
	const hostType = typeof content.host_type === 'string' ? content.host_type : '';
	const url = identifier ? repoWebUrl(identifier, hostType) : null;
	const repoNode = url ? (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className="text-xs text-info-soft-fg hover:underline"
			data-testid="repo-designated-link"
		>
			{identifier}
		</a>
	) : (
		<span className="text-xs text-text-2">{identifier}</span>
	);
	return (
		<div className="flex items-baseline gap-2 leading-[26px]" data-testid="repo-designated-comment">
			<span className="text-xs text-text-2">
				<Trans k="comment.repoDesignated" vars={{ repo: repoNode }} />
			</span>
			{timestamp}
		</div>
	);
}

function TaskLinkSystemBody({
	comment,
	content,
	projectId,
}: {
	comment: CommentDataOf<'system'>;
	content: SystemTaskLinkContent;
	projectId: string;
}) {
	const { t } = useI18n();
	const sourceIdentifier = content.source_identifier ?? '';
	const sourceProjectSlug = content.source_project_slug ?? '';
	const actorName = content.actor_name ?? comment.author_name ?? 'Admin';
	const actorKind = content.actor_kind ?? null;
	const actorSlug = content.actor_slug ?? null;
	const sourceCommentPublicId = content.source_comment_public_id ?? null;

	const linkClass = 'text-xs text-info-soft-fg hover:underline';
	const textClass = 'text-xs text-text-2';

	const sourceNode =
		sourceIdentifier && sourceProjectSlug ? (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{
					projectId: sourceProjectSlug,
					taskId: sourceIdentifier.toLowerCase(),
				}}
				className={linkClass}
				data-testid="task-link-source"
			>
				{sourceIdentifier}
			</Link>
		) : (
			<span className={textClass}>{sourceIdentifier}</span>
		);

	// The mention lived in a comment, so point at that comment rather than only at
	// its task. Same target as CommentRefLink, styled for a grey event row instead
	// of a mention. A description-sourced link has no anchor and stays as it was.
	const commentNode =
		sourceCommentPublicId && sourceIdentifier && sourceProjectSlug ? (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{
					projectId: sourceProjectSlug,
					taskId: sourceIdentifier.toLowerCase(),
				}}
				hash={`comment-${sourceCommentPublicId}`}
				className={linkClass}
				data-testid="task-link-source-comment"
			>
				{t('comment.linkedFromCommentLabel')}
			</Link>
		) : null;

	const actorNode =
		actorKind === 'agent' && actorSlug ? (
			<AgentLink
				projectId={projectId}
				agentId={actorSlug}
				className={linkClass}
				testId="task-link-actor"
			>
				{actorName}
			</AgentLink>
		) : (
			<span className={textClass}>{actorName}</span>
		);

	return (
		<span className={textClass}>
			<Trans
				k={commentNode ? 'comment.linkedFromComment' : 'comment.linkedFrom'}
				vars={{ comment: commentNode, source: sourceNode, actor: actorNode }}
			/>
			<ActorBadge actorType={comment.author_type} name={actorName} className="ml-1" />
		</span>
	);
}
