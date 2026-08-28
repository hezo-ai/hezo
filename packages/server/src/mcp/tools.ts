import { AsyncLocalStorage } from 'node:async_hooks';
import type { SearchScope } from '@hezo/shared';
import {
	ADMIN_MENTION_SLUG,
	AGENT_HUMAN_NAME_MAX,
	AgentAdminStatus,
	type AgentGender,
	ApprovalStatus,
	ApprovalType,
	ArchiveFilter,
	ASSET_MAX_FOLDER_DEPTH,
	AssetSortOrder,
	ATTACHMENT_EXTENSIONS,
	ATTACHMENT_MAX_BYTES,
	AuditActorType,
	AuthType,
	assetBasename,
	CAPTAIN_AGENT_SLUG,
	CAPTAIN_SETTABLE_GOAL_HEALTH,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
	CommentContentType,
	ConnectorAccess,
	ConnectorStatus,
	ConnectorTransport,
	CredentialInputType,
	CredentialKind,
	checkInjectedTextCap,
	connectorOAuthStatus,
	credentialKindRequiresAllowedHosts,
	DEFAULT_TEAM_ID,
	DEFAULT_THREAD_ROW_CATEGORIES,
	DocumentType,
	extensionOf,
	extractBacktickedLooseAssetPaths,
	extractBacktickedMentionCandidates,
	type GoalHealth,
	getConnectorCapability,
	hasFixedReportsTo,
	INJECTED_TEXT_CAPS,
	INSTANCE_AGENT_SLUGS,
	InjectedTextCapError,
	inferGender,
	isAllowedAttachmentMime,
	isMarkdownDocSlug,
	isTextAssetMime,
	type McpMethodInfo,
	matchesArchiveFilter,
	normalizeAssetPath,
	ReactionKind,
	SEARCH_SCOPES,
	summarizeMethodAccess,
	TaskStatus,
	TERMINAL_TASK_STATUSES,
	THREAD_ROW_CATEGORIES,
	type ThreadRowCategory,
	taskStatusError,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LocalAssetStore } from '../assets/drivers/local';
import type { AssetStore } from '../assets/store';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { readRunLogTail, readRunLogWindow, runLogLengthSql } from '../db/run-log-chunks';
import type { DomainEventBus } from '../events/bus';
import {
	applyAgentHumanName,
	buildAgentAvatarSpec,
	checkHumanNameAvailable,
	isNameOnlyRole,
} from '../lib/agent-identity';
import { canCoordinateTeam, isHqInstanceAgent, isVirtualHqMemberInTeam } from '../lib/agent-roles';
import { archivedAssetHolderId, upsertProjectAsset } from '../lib/asset-name';
import { assetSearchTextFromBlob } from '../lib/asset-search-text';
import { assetSortOrderBy } from '../lib/asset-sort';
import { signAgentAssetUrl } from '../lib/asset-urls';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { trackBackground } from '../lib/background';
import {
	broadcastCommentFamilyChange,
	broadcastConnectorRowChange,
	broadcastRowChange,
} from '../lib/broadcast';
import {
	commentCategoryPredicate,
	commentSincePredicate,
	isValidSince,
} from '../lib/comment-filters';
import { attachRunStatuses } from '../lib/comment-run-status';
import { credentialPlaceholder, validateSecretName } from '../lib/credential-placeholder';
import {
	coerceTargetStatusForBlockers,
	reconcileBlockedStatus,
	wakeIfReady,
	wouldCreateCycle,
} from '../lib/dependencies';
import { readImageDimensions } from '../lib/image-dimensions';
import {
	detectNarratedActiveMentions,
	detectPassiveTeammateAsks,
	detectQuotedMentionTokens,
	detectUnlinkedTeammateReferences,
	extractMentionSlugs,
} from '../lib/mentions';
import { assertNoBlockingRun } from '../lib/reassign-guard';
import {
	actorTypeFromAuth,
	apiKeyIdFromAuth,
	isUuid,
	resolveActorMemberId,
	resolveAgentId,
	resolveAssigneeId,
	resolveProject,
	resolveReactorMemberId,
	resolveTaskId,
} from '../lib/resolve';
import { assertRunTaskScope } from '../lib/run-scope';
import { deriveSkillSummary } from '../lib/skill-summary';
import { isUniqueViolation, withTransaction } from '../lib/sql';
import { applyStringEdit } from '../lib/string-edit';
import {
	assertChildrenAllClosed,
	assertNoOutstandingActivity,
	assertNoUnansweredAdminMentions,
	resolveParentAssignment,
} from '../lib/task-relationships';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import { setAgentAdminStatus } from '../services/agent-admin';
import { loadAgentAttachmentsForComments } from '../services/agent-runner';
import {
	AgentSystemPromptError,
	fetchAgentSystemPromptForBatch,
	type SystemPromptMode,
} from '../services/agent-system-prompts';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import { resolveApproval } from '../services/approval-resolve';
import { recordChatTaskOrigin } from '../services/chat-breadcrumbs';
import { upsertChatMemory, upsertConversationChatMemory } from '../services/chat-memory';
import {
	buildWakeReceipt,
	fireAdminMention,
	fireCommentWakeups,
	postAgentComment,
	resolveWarnableSlugs,
} from '../services/comment-wakeups';
import {
	buildConnectorRecipesSkill,
	CONNECTOR_RECIPES_SLUG,
	isConnectorRecipesSlug,
	resolveConnectorRegistry,
} from '../services/connector-registry';
import { validateApiConnectorConfig } from '../services/connectors/connections';
import type { ContainerDeps } from '../services/containers';
import { writeCustomPrompt } from '../services/custom-prompt';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import {
	getAgentSystemPrompt,
	getDocument,
	listDocumentSummaries,
	setDocumentArchived,
	upsertDocument,
} from '../services/documents';
import {
	type GoalSuggestionPayload,
	insertGoalSuggestionApproval,
	insertGoalSuggestionComment,
} from '../services/goal-suggestion';
import { listGoals, recordGoalProgress } from '../services/goals';
import { heartbeatIntervalFloorMin } from '../services/heartbeat-schedule';
import {
	buildHirePayloadPatch,
	type HirePayloadPatchInput,
	type HireProposalInput,
	insertHireApproval,
	prepareHireProposal,
} from '../services/hire-proposal';
import { insertHireProposalComment } from '../services/hire-proposal-comment';
import { getMarketplaceCatalog, getMarketplaceTeam } from '../services/marketplace';
import { setConnectorAuthError } from '../services/oauth/token-resolver';
import { createProjectWithTeam } from '../services/project-create';
import { completeProjectIntakeAfterProvisioning } from '../services/project-intake';
import { ProjectProgressError, updateProjectProgress } from '../services/projects';
import { authoredPromptError, authoredPromptWarning } from '../services/prompt-style-guard';
import {
	addCommentReaction,
	loadReactionsForTask,
	removeCommentReaction,
} from '../services/reactions';
import { listReviewComments } from '../services/review-comments';
import { isTaskBusyInDb } from '../services/run-concurrency';
import { recordSkillRevisionIfChanged } from '../services/skill-revisions';
import { triggerStatusAutomations, wakeTaskIfChildrenClosed } from '../services/task-automation';
import {
	recordAssigneeChange,
	recordDescriptionChange,
	recordParentChange,
	recordTaskLinks,
	recordTitleChange,
} from '../services/task-events';
import {
	type CreateTaskCaller,
	CreateTaskError,
	type CreateTaskInput,
	createTask,
	createTaskBatch,
	TASK_COLUMNS_BARE,
} from '../services/tasks';
import {
	applyMarketplaceRoleToTeam,
	applyMarketplaceTeamToTeam,
} from '../services/team-template-apply';
import { resolveSystemPrompt } from '../services/template-resolver';
import { createWakeup, wakeAgentIfAssigned } from '../services/wakeup';
import type { WebSocketManager } from '../services/ws';
import {
	type ContentWindow,
	DEFAULT_LIST_LIMIT,
	decodeCursor,
	fitSerializedWindow,
	type KeysetRow,
	keysetOrderBy,
	keysetPredicate,
	listPagingArgs,
	pagedList,
	parseListLimit,
	utf8FloorBoundary,
	windowContent,
} from './paging';
import type { ToolAudience } from './tool-visibility';

/**
 * Minimal row shape the keyset pager needs. List tools select far more columns;
 * this only pins the two the cursor is built from.
 */
type ListRow = KeysetRow & Record<string, unknown>;

const log = logger.child('mcp');

export const authContext = new AsyncLocalStorage<AuthInfo>();

/**
 * Origin the current MCP caller reached Hezo on, e.g. `http://127.0.0.1:47081`.
 *
 * Agent-facing asset download URLs have to be absolute and dialable *by the
 * caller*, and the caller is inside a container whose only route to Hezo is its
 * own tunnel - on a loopback port allocated for that tunnel, which the server
 * does not otherwise know. Reading it off the request is what makes it correct
 * without a registry to keep in sync: the tunnel forwards the container's
 * request verbatim, so the `Host` header already carries exactly the address the
 * container used. An out-of-container API-key caller gets the origin it really
 * reached, which is strictly better than the host-shaped guess this replaced.
 */
export const callerOriginContext = new AsyncLocalStorage<string>();

export interface ToolDef {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	/**
	 * JSON Schema of the tool's input parameters, derived from the Zod shape at
	 * registration. Consumed by the docs generator (`mcp-reference.ts`) to render
	 * the per-tool parameter tables; the live MCP `tools/list` schema is produced
	 * independently by the SDK.
	 */
	params: Record<string, unknown>;
	/**
	 * True when the tool persists data: a successful call from an agent run marks
	 * the run as having produced output.
	 */
	write: boolean;
	/**
	 * The caller class this tool's handler gates on, or undefined when any
	 * authenticated caller may see it. Read by `tool-visibility.ts` to project
	 * `tools/list`; it hides, it never forbids.
	 */
	audience?: ToolAudience;
	/** Raised result cap for an inherently large resource. */
	resultByteLimit?: number;
	/** For a batch tool, the argument holding the array it chunks over. */
	batchArrayParam?: string;
}

/**
 * The per-tool facts that used to live in name-keyed side tables beside the
 * registry (`MCP_WRITE_TOOLS`, `TOOL_AUDIENCE`, `MCP_RESULT_BYTE_LIMIT_OVERRIDES`,
 * `MCP_BATCH_ARRAY_PARAMS`).
 *
 * Declared at the registration instead, because a second list keyed by tool name
 * can only ever drift from the first: a rename left a stale entry behind, and a
 * new tool needing one simply never got it, with nothing to say so. Here the
 * fact and the tool cannot separate - there is no second place to forget.
 */
export interface ToolOptions {
	write?: boolean;
	audience?: ToolAudience;
	resultByteLimit?: number;
	batchArrayParam?: string;
}

const registeredTools: ToolDef[] = [];

/** A handler result that signals failure rather than a persisted write. */
function isErrorResult(result: unknown): boolean {
	return typeof result === 'object' && result !== null && 'error' in result;
}

/**
 * Returns a warning string when a comment addresses a teammate by bold/bare name
 * instead of a mention, or null when nothing is amiss. The author's own slug is
 * excluded so a self-reference never warns; resolution mirrors the mention-wakeup
 * scoping (the task's team plus the HQ instance agents) and includes @admin.
 */
async function buildUnlinkedMentionWarning(
	knownSlugs: string[],
	content: string,
): Promise<string | null> {
	const offenders = detectUnlinkedTeammateReferences(content, knownSlugs);
	if (offenders.length === 0) return null;
	const named = offenders.map((s) => `**${s}**`).join(', ');
	const fixes = offenders.map((s) => `@${s}`).join(', ');
	return (
		`You referenced teammate(s) ${named} by bold/plain name - that renders as text ` +
		`and notifies no one, so no wakeup was created. If you need them to act on this ` +
		`task, post a follow-up using an active mention (${fixes}); if you were only ` +
		`referring to them, use the passive form (@@${offenders[0]}).`
	);
}

/**
 * Returns a warning when a comment addresses a teammate with the PASSIVE mention
 * form (@@slug) yet the surrounding text reads like an ask — the passive form
 * links but notifies no one, so an intended handoff stalls silently. Only an
 * addressing use paired with a directed-ask signal, or a name bound directly to a
 * sign-off/approval gate ("Ready for @@slug review"), is flagged (see
 * detectPassiveTeammateAsks), so a deliberate passive reference is left alone.
 * Same scoping as buildUnlinkedMentionWarning; best-effort and non-blocking.
 */
async function buildPassiveMentionWarning(
	knownSlugs: string[],
	content: string,
): Promise<string | null> {
	const offenders = detectPassiveTeammateAsks(content, knownSlugs);
	if (offenders.length === 0) return null;
	const named = offenders.map((s) => `@@${s}`).join(', ');
	const fixes = offenders.map((s) => `@${s}`).join(', ');
	// An offender can still have been notified — by an active mention somewhere
	// else in this same comment that is NOT the address (a back-reference, a
	// name-drop). Saying "no wakeup was created" there would be false, and the
	// mismatch IS the finding: the ask wears the mark that notifies no one while
	// something that asks for nothing wears the live one.
	const activeElsewhere = new Set(extractMentionSlugs(content));
	const misplaced = offenders.filter((s) => activeElsewhere.has(s));
	const misplacedNote =
		misplaced.length > 0
			? ` Note that ${misplaced.map((s) => `@${s}`).join(', ')} did notify from elsewhere in ` +
				`this comment - but that mention is not the address, so the notification points at a ` +
				`line that asks for nothing while the ask itself wears the silent mark. Move the ` +
				`active mention onto the address.`
			: '';
	return (
		`You addressed ${named} with the passive form (@@) - that renders as a link and ` +
		`notifies no one at that address. If you need them to ` +
		`act on this task, edit this comment or post a follow-up with an active mention ` +
		`(${fixes}). If you only meant to refer to them, keep the passive form but move the ` +
		`reference out of the handoff position: a line that opens with a teammate reference and ` +
		`a dash is an address, and a name bound to a sign-off gate ("ready for <name> review", ` +
		`"awaiting <name> sign-off", "<name> to approve") hands them the next action - both ` +
		`shapes are reserved for active mentions, so a plain reference belongs inside a ` +
		`sentence that asks for nothing.${misplacedNote}`
	);
}

/**
 * Returns a warning when a comment writes an ACTIVE `@<slug>` while merely
 * describing a mention that lives in another comment ("the @admin mention in
 * TASK-7#comment-9") — the renderer and the wakeup fan-out can't tell that from
 * a real ask, so it wakes the teammate (or lands an admin-inbox row) here. The
 * fix offered is backticks, which keep the quoted token literal; the server
 * never rewrites the comment. Same scoping as buildUnlinkedMentionWarning;
 * best-effort and non-blocking.
 */
async function buildNarratedMentionWarning(
	knownSlugs: string[],
	content: string,
): Promise<string | null> {
	const offenders = detectNarratedActiveMentions(content, knownSlugs);
	if (offenders.length === 0) return null;
	const named = offenders.map((s) => `@${s}`).join(', ');
	const fixes = offenders.map((s) => `\`@${s}\``).join(', ');
	const adminNote = offenders.includes(ADMIN_MENTION_SLUG)
		? ` Note that a narrated @${ADMIN_MENTION_SLUG} lands a fresh unanswered admin ask - the exact ` +
			`condition that blocks this task from going done - so writing *about* an admin question ` +
			`this way deepens the block instead of describing it.`
		: '';
	return (
		`You wrote ${named} as a live mention while describing a mention that lives elsewhere - ` +
		`that notifies here and now, it does not point at the other comment. Wrap the quoted ` +
		`token in backticks (${fixes}) so it renders as literal text and wakes no one; keep an ` +
		`active mention only for an ask you are actually making in this comment. To refer to the ` +
		`person rather than the token, use the passive form (@@${offenders[0]}).${adminNote}`
	);
}

/**
 * Returns a warning when markdown wraps a Hezo reference in inline backticks —
 * which renders it as inert code instead of a link — or null when nothing is
 * amiss. Tasks, project docs/skills, and teammates are flagged only when they
 * actually resolve (a real task in this team, a project doc/skill, or a teammate
 * in this team or HQ), so genuine code spans — repo paths, package names,
 * `UTF-8` — never trip those branches. An `assets/<path>` reference is the
 * exception: the `assets/` prefix is unambiguously a Hezo asset handle (never a
 * repo path), so a backticked one is flagged whether or not the asset exists
 * yet — catching a deliverable an agent is about to create before the backtick
 * habit sets.
 *
 * A second asset failure is caught here too: an asset referenced by a
 * folder-prefixed path that BOTH sits in backticks AND drops the `assets/`
 * prefix (e.g. `` `diagrams/hero.svg` `` for `assets/diagrams/hero.svg`). That
 * form matches neither the mention regex (it requires the literal `assets/`
 * prefix) nor a bare-filename branch, so without this it linked nowhere and
 * warned nowhere. Because a prefix-less folder path is genuinely ambiguous with
 * a repo file, it is resolve-gated — flagged only when it matches a real asset's
 * stored `original_filename` in this project — and the fix restores the prefix.
 * Best-effort and non-blocking, exactly like buildUnlinkedMentionWarning.
 */
async function buildBacktickedEntityWarning(
	db: Db,
	teamId: string,
	projectId: string,
	content: string,
): Promise<string | null> {
	const candidates = extractBacktickedMentionCandidates(content);
	const looseAssetPaths = extractBacktickedLooseAssetPaths(content);
	// A backticked mention token in narrated position (`` the `@architect` ping in
	// TASK-4 ``) is the deliberate quoted form buildNarratedMentionWarning asks
	// for — un-backticking it would fire the very wake the author avoided, so it
	// is never flagged here. (`@admin` never reaches this list; the extractor
	// excludes it.)
	const quotedTokens = new Set(detectQuotedMentionTokens(content, candidates.agents));
	const agentCandidates = candidates.agents.filter((slug) => !quotedTokens.has(slug));
	if (
		candidates.tasks.length === 0 &&
		candidates.filenames.length === 0 &&
		candidates.assets.length === 0 &&
		agentCandidates.length === 0 &&
		looseAssetPaths.length === 0
	) {
		return null;
	}

	const refs: string[] = [];
	let hasAgents = false;

	if (agentCandidates.length > 0) {
		const r = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE (m.team_id = $1 OR m.team_id = $2) AND LOWER(ma.slug) = ANY($3::text[])`,
			[teamId, DEFAULT_TEAM_ID, agentCandidates],
		);
		for (const row of r.rows) {
			refs.push(`@${row.slug}`);
			hasAgents = true;
		}
	}

	if (candidates.tasks.length > 0) {
		const r = await db.query<{ identifier: string }>(
			`SELECT identifier FROM tasks WHERE team_id = $1 AND LOWER(identifier) = ANY($2::text[])`,
			[teamId, candidates.tasks],
		);
		for (const row of r.rows) refs.push(row.identifier);
	}

	if (candidates.filenames.length > 0) {
		const docs = await db.query<{ slug: string }>(
			`SELECT slug FROM documents
			 WHERE type = 'project_doc' AND project_id = $1 AND slug = ANY($2::text[])`,
			[projectId, candidates.filenames],
		);
		for (const row of docs.rows) refs.push(row.slug);
		const kb = await db.query<{ slug: string }>(
			`SELECT slug FROM skills
			 WHERE LOWER(slug) = ANY($1::text[]) AND (project_id = $2 OR project_id IS NULL)`,
			[candidates.filenames.map((f) => f.toLowerCase()), projectId],
		);
		for (const row of kb.rows) refs.push(row.slug);
	}

	// The `assets/` prefix is unambiguously a Hezo asset handle, never a repo
	// path, so a backticked asset reference is always wrong — flag every candidate
	// without a DB existence check. This is what catches a deliverable an agent is
	// about to create (the asset row doesn't exist yet), where the resolve-gated
	// branches above would stay silent.
	for (const a of candidates.assets) refs.push(`assets/${a}`);

	// Backticked asset paths that ALSO dropped the `assets/` prefix. A prefix-less
	// folder path is ambiguous with a real repo file, so resolve-gate it against
	// the project's assets (matched on `original_filename`, which is stored without
	// the prefix) and flag only genuine hits — the fix restores the prefix.
	const looseAssetFixes: string[] = [];
	if (looseAssetPaths.length > 0) {
		const r = await db.query<{ original_filename: string }>(
			`SELECT original_filename FROM assets WHERE project_id = $1 AND original_filename = ANY($2::text[])`,
			[projectId, looseAssetPaths],
		);
		for (const row of r.rows) looseAssetFixes.push(row.original_filename);
	}

	if (refs.length === 0 && looseAssetFixes.length === 0) return null;

	const parts: string[] = [];
	if (refs.length > 0) {
		const deduped = Array.from(new Set(refs));
		const wrapped = deduped.map((ref) => `\`${ref}\``).join(', ');
		const bare = deduped.join(', ');
		parts.push(
			`You wrapped Hezo reference(s) in backticks - ${wrapped} - so they render as inert ` +
				`code instead of links. Write each bare (no backticks): ${bare}. A bare reference links ` +
				`as soon as its target exists - an \`assets/<path>\` you have not created yet renders as ` +
				`plain text until then, then links automatically - whereas backticks keep it inert ` +
				`permanently.`,
		);
	}
	if (looseAssetFixes.length > 0) {
		const deduped = Array.from(new Set(looseAssetFixes));
		const pairs = deduped.map((p) => `\`${p}\` → assets/${p}`).join(', ');
		parts.push(
			`Asset reference(s) wrapped in backticks AND missing the \`assets/\` prefix - ${pairs}. ` +
				`An asset links only when it is written bare with its full \`assets/<path>\` handle; a ` +
				`backticked or prefix-dropped path reads as inert code or a repo file and never links, ` +
				`even after the asset lands. Write each exactly as \`list_project_assets\` returns it, ` +
				`bare and prefixed.`,
		);
	}
	if (hasAgents) {
		parts.push(
			'For a teammate, @<slug> also wakes them on this task; use @@<slug> to refer without notifying.',
		);
	}
	return parts.join(' ');
}

/**
 * Returns a warning when an agent posts an active mention (an ask) on a task
 * that is already terminal, or null otherwise. A done/cancelled task reads as
 * finished, so an ask parked on it is easy to miss — the correct move was to
 * ask before closing and keep the task in_progress while waiting.
 * Best-effort and non-blocking, exactly like the builders above.
 */
async function buildTerminalTaskAskWarning(
	db: Db,
	taskId: string,
	content: string,
): Promise<string | null> {
	if (extractMentionSlugs(content).length === 0) return null;
	const r = await db.query<{ status: string }>(
		'SELECT status::text AS status FROM tasks WHERE id = $1',
		[taskId],
	);
	const status = r.rows[0]?.status;
	if (!status || !(TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) return null;
	return (
		`Note: this task is already ${status} (terminal). An ask posted on a closed task is easy ` +
		`to miss - if you still need an answer or action, ask on an open task instead; next time ` +
		`ask BEFORE closing and keep the task in_progress until the answer lands.`
	);
}

/**
 * Attach a backticked-entity warning, computed over `content`, to a write
 * result when the caller is an agent. The check is advisory: failures are
 * swallowed and never block the already-persisted write.
 */
async function withBacktickWarning<T extends object>(
	db: Db,
	auth: AuthInfo,
	teamId: string,
	projectId: string,
	content: string | undefined,
	result: T,
): Promise<T | (T & { warning: string })> {
	if (auth.type !== AuthType.Agent || !content) return result;
	const warning = await buildBacktickedEntityWarning(db, teamId, projectId, content).catch((e) => {
		log.error('Failed to check for backticked entity references:', e);
		return null;
	});
	return warning ? { ...result, warning } : result;
}

/** Flag an agent run as having produced output. Idempotent and self-contained. */
async function markRunProducedOutput(db: Db, runId: string): Promise<void> {
	await db.query(
		'UPDATE heartbeat_runs SET produced_output = true WHERE id = $1 AND produced_output = false',
		[runId],
	);
}

/**
 * Flag an agent run as an intentional no-op: the agent evaluated the task and
 * concluded there was nothing to do. Kept distinct from `produced_output` (which
 * means the run wrote persisted data) so the completion path can treat a clean
 * no-op as a success without it masquerading as a productive run.
 */
async function markRunReportedNoWork(db: Db, runId: string, reason: string): Promise<void> {
	await db.query(
		'UPDATE heartbeat_runs SET reported_no_work = true, no_work_reason = $2 WHERE id = $1',
		[runId, reason],
	);
}

// Qualified-column variant of services/tasks.ts TASK_COLUMNS_BARE — prefixes
// every column with the `i.` alias for SELECT ... FROM tasks i JOIN ...
// patterns.
const TASK_COLUMNS = TASK_COLUMNS_BARE.replace(/[A-Za-z_][A-Za-z_0-9]*/g, 'i.$&');

const SKILL_COLUMNS = `id, name, slug, description, content, source_url,
	content_hash, created_by_member_id, project_id, tags, is_active, auto_load, created_at, updated_at`;

const APPROVAL_COLUMNS = `id, team_id, type, status, requested_by_member_id,
	resolution_note, resolved_at, created_at, payload`;

/** APPROVAL_COLUMNS qualified with the `a` alias, for the keyset-paged read. */
const APPROVAL_COLUMNS_ALIASED = APPROVAL_COLUMNS.replace(/[A-Za-z_][A-Za-z_0-9]*/g, 'a.$&');

// Cap MCP tool result payloads at 64 000 bytes, comfortably under a typical agent
// runtime's tool-result limit (e.g. the Claude Code harness's ~25k-token ceiling).
// An oversized result is discarded whole and replaced with a `result_too_large`
// error, because a runtime that instead persists a large result to disk would make
// it unreadable anyway (the persisted file trips the same cap). A few single-
// resource readers raise this with `resultByteLimit` on their registration;
// read_project_doc keeps this cap and pages a large doc into byte windows
// rather than tripping it.
export const MCP_RESULT_BYTE_LIMIT = 64_000;

/**
 * The raised cap for the system-prompt readers, which return one inherently
 * large resource rather than a list that could page.
 *
 * A named constant rather than a lookup keyed by tool name: the handler windows
 * its content against this value and the registration declares it, so both read
 * the same binding and neither can drift from the other.
 */
export const SYSTEM_PROMPT_RESULT_BYTES = 131_072;

// A few inspection tools return a single, inherently large resource rather than
// a list — a fully-resolved agent system prompt already fills most of the 64 KB
// cap and only grows as shared guidance is added. These get a higher per-tool
// limit so a legitimate single-resource read isn't rejected as
// `result_too_large`; the generic cap still guards every list/query tool against
// context bloat. Keyed by tool name; falls back to MCP_RESULT_BYTE_LIMIT.
/**
 * Fraction of the theoretical fit to actually suggest on a batch retry. Rows
 * vary in size, so proposing exactly `limit / size` of the batch would put the
 * retry right at the cap and risk a second rejection.
 */
const BATCH_RETRY_SAFETY = 0.8;

/**
 * Remedies for an oversized result, built from what the called tool actually
 * declares rather than from a fixed list.
 *
 * A fixed list is worse than no list: it names parameters the tool may not
 * have, and an agent that discards the inapplicable ones is left with whatever
 * remains, however bad. That is the exact path that turned one overflowing
 * batch read into ten single reads.
 */
export function oversizeRemedies(
	name: string,
	schema: Record<string, z.ZodType>,
	args: Record<string, unknown>,
	sizeBytes: number,
	byteLimit: number,
	batchParam?: string,
): string[] {
	const remedies: string[] = [];

	const batch = batchParam ? args[batchParam] : undefined;
	if (batchParam && Array.isArray(batch) && batch.length > 1) {
		const safe = Math.max(
			1,
			Math.floor((batch.length * byteLimit * BATCH_RETRY_SAFETY) / sizeBytes),
		);
		const calls = Math.ceil(batch.length / safe);
		remedies.push(
			`Split the batch and retry: you sent ${batch.length} items in \`${batchParam}\`, so retry as ${calls} calls of at most ${safe}. Do NOT fall back to one item per call - that is ${batch.length} round trips for work that fits in ${calls}.`,
		);
	}

	if ('cursor' in schema) {
		remedies.push('Lower `limit` and page with `cursor` until `has_more` is false.');
	}
	if ('offset' in schema) {
		remedies.push('Lower `max_bytes` and page with `offset` until `next_offset` is null.');
	}
	if ('before' in schema) {
		remedies.push('Page backwards with `before`.');
	}
	if ('excerpt_chars' in schema) {
		remedies.push('Pass `excerpt_chars: 300` to truncate long fields.');
	}
	const filters = [
		'status',
		'assignee_slug',
		'assignee_id',
		'filter',
		'type',
		'project',
		'categories',
		'since',
	].filter((f) => f in schema && args[f] === undefined);
	if (filters.length > 0) {
		remedies.push(`Narrow the query with ${filters.map((f) => `\`${f}\``).join(' / ')}.`);
	}

	if (remedies.length === 0) {
		remedies.push(
			'This tool exposes no narrowing parameter - request less of the underlying resource, or read it through a tool that pages.',
		);
	}
	return remedies;
}

// Headroom reserved for the JSON result envelope (field names, pretty-print
// indentation, string-escaping inflation of newlines/quotes/backslashes, and any
// review_comments) when read_project_doc sizes a content window under its effective
// result cap, so the serialized window stays under the byte guard.
const DOC_READ_ENVELOPE_RESERVE = 4_096;

/**
 * Byte budget a *chunked* batch result aims to fill, as distinct from the cap
 * that decides whether a result is admitted at all.
 *
 * The two are not the same number, and conflating them is a real failure we hit:
 * chunking to the raised `resultByteLimit` (128 KB) let a
 * batch return ~125 KB, which is roughly 31k tokens - over the ~25k-token
 * tool-result ceiling a runtime like the Claude Code harness enforces. The
 * chunker had "succeeded" into a result the client could not accept, so the
 * harness spilled it to a file and the agent spent several turns writing a
 * script to slice it back out.
 *
 * A raised per-tool cap exists so a single inherently-large resource is not
 * rejected outright. It is the wrong target when we control how many items to
 * include: there, aim under the generic cap, which was picked to sit
 * comfortably inside a runtime's token ceiling. The envelope reserve comes off
 * the top so the serialized wrapper still fits.
 */
const MCP_BATCH_CHUNK_TARGET_BYTES = MCP_RESULT_BYTE_LIMIT - DOC_READ_ENVELOPE_RESERVE;

/**
 * Default cap for the long free-text columns a list route returns per row.
 *
 * Paging bounds a list's row *count*; this bounds its row *width*. Without it a
 * page of 50 tasks carrying unbounded description and rules can exceed the
 * result cap at any page size, and the whole page is discarded rather than
 * trimmed. Wide enough to triage from, and the single-item `get_*` read still
 * serves the full text.
 */
const DEFAULT_TASK_EXCERPT_CHARS = 500;

/**
 * Default cap for a comment's text in a listing. Higher than the task default:
 * a thread is read to follow a conversation, so an over-tight excerpt costs a
 * round trip per comment, which is the failure this whole convention is here to
 * avoid. The full text is one `get_comment` read away, and every truncated row
 * carries a `text_paging_hint` naming that call.
 *
 * This comment used to claim the full text was reachable "via `before`/`cursor`
 * on a narrower page". It never was: neither parameter widens the excerpt, so
 * the only escape was guessing an `excerpt_chars` above `text_length`. Keep any
 * recovery path named here true - `get_comment` exists precisely because two
 * surfaces promised a single-item read that did not.
 */
const DEFAULT_COMMENT_EXCERPT_CHARS = 2_000;

/** Ceiling a caller may ask for. A listing triages; `get_comment` serves a whole body. */
const MAX_COMMENT_EXCERPT_CHARS = 4_000;

/**
 * Floor for the width derived from the page size, so a full-width page still
 * leaves each row worth reading. It never raises a caller that asked for less.
 */
const MIN_COMMENT_EXCERPT_CHARS = 200;

/**
 * Page bytes the excerpt budget may not spend: row ids, authors, timestamps,
 * reactions, attachment URLs, structured bodies returned whole, and the
 * escaping inflation of pretty-printed JSON.
 */
const COMMENT_LIST_ENVELOPE_RESERVE = 12_000;

/**
 * The excerpt width a page can actually afford.
 *
 * The default width times the default page size is well over the result cap, so
 * a full page of long comments was rejected whole and the caller told to retry
 * smaller - which costs a round trip per guess and re-reads what it already
 * paged. Deriving the width from the page size returns a shorter excerpt instead
 * of nothing at all.
 */
function effectiveCommentExcerptChars(requested: number | undefined, limit: number): number {
	const affordable = Math.floor((MCP_RESULT_BYTE_LIMIT - COMMENT_LIST_ENVELOPE_RESERVE) / limit);
	const asked = requested ?? DEFAULT_COMMENT_EXCERPT_CHARS;
	return Math.min(asked, Math.max(MIN_COMMENT_EXCERPT_CHARS, affordable));
}

/**
 * Warn when a caller supplied a `changelog` that had nowhere to land.
 *
 * A revision captures the content as it was BEFORE a change, so only a
 * content-changing write records one: a doc's creation and a description-only
 * update do not. The changelog used to be discarded in silence, which is worse
 * than refusing it - the agent goes on believing its note is in the document's
 * history, and so does the next reader who does not find it there.
 */
function changelogNotRecordedWarning(changelog: unknown, recorded: boolean): { warning?: string } {
	if (recorded) return {};
	if (typeof changelog !== 'string' || changelog.trim() === '') return {};
	return {
		warning:
			"The `changelog` was not recorded: a revision captures the content as it was before a change, so only a content-changing write gets one - a doc's first write and a description-only update do not. Nothing else about this write was affected.",
	};
}

// Inline-image cap for read_project_asset. A raster asset at or under this many
// bytes is returned as an actual MCP image content block (base64) so a
// vision-capable runtime can SEE it; a larger image falls back to a signed-URL
// response the agent fetches itself. Kept well under a runtime's tool-result
// ceiling so one image can't dominate the agent's context (~4 MB raw ≈ 5.3 MB
// base64). The generic MCP_RESULT_BYTE_LIMIT guards text/JSON results only — the
// image passthrough bypasses it and is bounded here instead.
export const MCP_INLINE_IMAGE_MAX_BYTES = 4_000_000;

/**
 * True for raster image types (PNG/JPEG/GIF/WebP, …) — `image/*` except SVG,
 * which `isTextAssetMime` classifies as text. These are the types
 * `readImageDimensions` can measure and the runtime can render inline.
 */
function isRasterImageMime(mime: string): boolean {
	return mime.startsWith('image/') && !isTextAssetMime(mime);
}

export interface Excerpt {
	excerpt: string | null;
	truncated: boolean;
	length: number;
}

/**
 * How much of the budget a boundary must preserve to be worth cutting at.
 * Below this the boundary is ignored and the excerpt runs to the full budget,
 * so a tidy cut never costs more than half the text the caller asked for.
 */
const EXCERPT_BOUNDARY_FLOOR = 0.5;

/** Index of the last paragraph break in `s`, or -1 when there is none. */
function lastParagraphBreak(s: string): number {
	const re = /\n[ \t]*\n/g;
	let idx = -1;
	for (let m = re.exec(s); m !== null; m = re.exec(s)) idx = m.index;
	return idx;
}

/**
 * Excerpt the leading `maxChars` of `text`, cut at a paragraph break where one
 * is available and at a word boundary otherwise.
 *
 * `maxChars` is the budget to fill, NOT a ceiling applied after some other rule.
 * An earlier version cut at the FIRST paragraph break and only then applied
 * `maxChars` (it even sliced `firstPara` rather than `text`, so it could never
 * look past that break), which meant a 9400-character comment whose opening
 * line was followed by a blank line came back as 73 characters - grammatically
 * complete prose that read as a finished short comment rather than an excerpt,
 * and was acted on as one: an agent concluded a review had never been submitted
 * and asked for it to be redone. A boundary is now preferred only when it keeps
 * most of the budget; otherwise the excerpt runs to the budget.
 *
 * Returns `null` excerpt for null input.
 */
export function excerpt(text: string | null | undefined, maxChars: number): Excerpt {
	if (text == null) return { excerpt: null, truncated: false, length: 0 };
	const length = text.length;
	if (length === 0) return { excerpt: '', truncated: false, length: 0 };
	if (length <= maxChars) return { excerpt: text, truncated: false, length };
	const slice = text.slice(0, maxChars);
	const floor = maxChars * EXCERPT_BOUNDARY_FLOOR;
	const para = lastParagraphBreak(slice);
	if (para > floor) return { excerpt: slice.slice(0, para), truncated: true, length };
	const lastSpace = slice.lastIndexOf(' ');
	const cut = lastSpace > floor ? slice.slice(0, lastSpace) : slice;
	return { excerpt: cut, truncated: true, length };
}

/**
 * Spread an Excerpt into a row under `<field>_excerpt`/`_truncated`/`_length`.
 */
function applyExcerpt<T extends Record<string, unknown>>(
	row: T,
	field: string,
	maxChars: number,
): T {
	const value = row[field];
	const ex = excerpt(typeof value === 'string' ? value : null, maxChars);
	const next = { ...row } as Record<string, unknown>;
	delete next[field];
	next[`${field}_excerpt`] = ex.excerpt;
	next[`${field}_truncated`] = ex.truncated;
	next[`${field}_length`] = ex.length;
	return next as T;
}

/**
 * Excerpt long string fields inside an approval payload (most importantly the
 * `content` markdown of a skill_proposal). Leaves short fields and non-string
 * fields untouched.
 */
function excerptApprovalPayload<T extends Record<string, unknown>>(row: T, maxChars: number): T {
	const payload = row.payload;
	if (!payload || typeof payload !== 'object') return row;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (typeof value !== 'string' || value.length <= maxChars) {
			next[key] = value;
			continue;
		}
		const ex = excerpt(value, maxChars);
		next[`${key}_excerpt`] = ex.excerpt;
		next[`${key}_truncated`] = ex.truncated;
		next[`${key}_length`] = ex.length;
	}
	return { ...row, payload: next };
}

type McpTextContent = { type: 'text'; text: string };
type McpImageContent = { type: 'image'; data: string; mimeType: string };
type McpContentBlock = McpTextContent | McpImageContent;

/**
 * A tool handler normally returns a JSON-serializable value that the wrapper
 * stringifies into one text block. To return richer MCP content — e.g. the
 * actual image for a vision-capable runtime to review — a handler returns this
 * marker instead and the wrapper passes the blocks through untouched (bounded by
 * MCP_INLINE_IMAGE_MAX_BYTES at the call site, not the text-only byte guard).
 */
interface RawToolContent {
	__mcpContent: McpContentBlock[];
}

function isRawToolContent(result: unknown): result is RawToolContent {
	return (
		typeof result === 'object' &&
		result !== null &&
		Array.isArray((result as { __mcpContent?: unknown }).__mcpContent)
	);
}

function tool(
	server: McpServer,
	name: string,
	description: string,
	schema: Record<string, z.ZodType>,
	handler: (args: Record<string, unknown>, db: Db, auth: AuthInfo) => Promise<unknown>,
	db: Db,
	opts: ToolOptions = {},
) {
	registeredTools.push({
		name,
		description,
		schema: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.description ?? k])),
		params: z.toJSONSchema(z.object(schema)) as Record<string, unknown>,
		write: opts.write ?? false,
		...(opts.audience ? { audience: opts.audience } : {}),
		...(opts.resultByteLimit ? { resultByteLimit: opts.resultByteLimit } : {}),
		...(opts.batchArrayParam ? { batchArrayParam: opts.batchArrayParam } : {}),
	});
	server.tool(name, description, schema, async (args: Record<string, unknown>) => {
		const auth = authContext.getStore();
		if (!auth) {
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ error: 'Unauthorized: missing auth context' }),
					},
				],
			};
		}
		const result = await handler(args, db, auth);
		if (auth.type === AuthType.Agent && auth.runId && opts.write && !isErrorResult(result)) {
			await markRunProducedOutput(db, auth.runId);
		}
		// A handler may return pre-shaped MCP content blocks (e.g. an image);
		// pass them through untouched rather than JSON-stringifying.
		if (isRawToolContent(result)) {
			return { content: result.__mcpContent };
		}
		const text = JSON.stringify(result, null, 2);
		const sizeBytes = Buffer.byteLength(text, 'utf8');
		const byteLimit = opts.resultByteLimit ?? MCP_RESULT_BYTE_LIMIT;
		if (sizeBytes > byteLimit) {
			const guard = JSON.stringify(
				{
					error: 'result_too_large',
					tool: name,
					size_bytes: sizeBytes,
					limit_bytes: byteLimit,
					hint: 'This result exceeded the cap and was discarded whole - nothing was returned. Split the work and retry; do not narrow what you cover to whatever fits in one call.',
					remedies: oversizeRemedies(
						name,
						schema,
						args,
						sizeBytes,
						byteLimit,
						opts.batchArrayParam,
					),
				},
				null,
				2,
			);
			return { content: [{ type: 'text' as const, text: guard }] };
		}
		return { content: [{ type: 'text' as const, text }] };
	});
}

/**
 * Recover the static types `server.tool` erases. The SDK validates `args`
 * against the tool's zod shape (presence + type) and rejects bad input with a
 * JSON-RPC error before the handler runs, but it then hands the handler an
 * untyped `Record<string, unknown>`. Re-parsing against the same shape returns a
 * typed object and, in practice, never throws (the SDK already enforced it).
 *
 * The point is branch reduction: without it, handlers re-derive every field with
 * a `typeof args.x === 'string' ? args.x : default` ternary, and the non-string
 * arm is unreachable for schema-required fields — dead branches that dragged
 * coverage down across the tool surface. Reading `input.x` off the typed result
 * deletes them. Genuinely value-dependent guards (an *empty* required string, a
 * cross-field rule) stay in the handler, since `z.string()` still admits `""`.
 */
function typedArgs<S extends z.ZodRawShape>(
	shape: S,
	args: Record<string, unknown>,
): z.infer<z.ZodObject<S>> {
	return z.object(shape).parse(args);
}

const MAX_BATCH_CREATE_TASKS = 50;
const MAX_BATCH_AGENT_SYSTEM_PROMPTS = 50;

/**
 * Shared prose for the hire tools' `heartbeat_interval_min` argument. Required
 * on `create_hire_proposal` so a hire can never inherit a cadence nobody chose;
 * the prompt rule in `_partials/captain/hire-workflow.md` is what sends the
 * agent to ask the admin for it. Rendered verbatim into
 * `docs/reference/mcp-api.md`, `/SKILL.md` and `llms.txt`, so it uses hyphens,
 * never em or en dashes.
 */
function heartbeatIntervalArgDescription(): string {
	const floor = heartbeatIntervalFloorMin();
	return `How often this agent wakes to look for work, in minutes. Ask the admin for the cadence rather than assuming one - it drives both how fast the agent picks up work and how much it spends. Minimum ${floor}; a lower value is rejected. Typical choices: ${floor} for a fast-moving role, 720 (12 hours) for a steady one, 1440 (daily) for an occasional reviewer.`;
}

async function buildMcpCreateTaskCaller(
	db: Db,
	auth: AuthInfo,
	teamId: string,
): Promise<CreateTaskCaller> {
	const actorMemberId = await resolveActorMemberId(db, auth, teamId);
	const caller: CreateTaskCaller = {
		actorType: actorTypeFromAuth(auth),
		actorMemberId,
		actorApiKeyId: apiKeyIdFromAuth(auth),
	};
	if (auth.type === AuthType.Agent) {
		caller.agentMemberId = auth.memberId;
		caller.runId = auth.runId ?? undefined;
	}
	return caller;
}

function mcpArgsToCreateTaskInput(
	args: Record<string, unknown>,
	projectId: string,
): CreateTaskInput {
	return {
		project_id: projectId,
		title: args.title as string,
		description: args.description as string | undefined,
		assignee_id: args.assignee_id as string | undefined,
		assignee_slug: args.assignee_slug as string | undefined,
		parent_task_id: args.parent_task_id as string | undefined,
		priority: args.priority as string | undefined,
		runtime_type: args.runtime_type as string | undefined,
		blocked_by_task_ids: args.blocked_by_task_ids as string[] | undefined,
		goal_id: args.goal_id as string | undefined,
	};
}

export interface ToolScope {
	projectId: string;
	teamId: string;
}

/**
 * Resolve the project a tool call targets, then authorize the caller for it.
 *
 * Hezo is project-centric: callers address resources by `project` (slug or UUID)
 * and the backing team is derived from it (1:1). When `project` is omitted the
 * call falls back to the caller's own run scope — a normal agent run passes
 * nothing and operates on its own project, while an instance principal (the CEO
 * chat session) names the project it wants to reach. `team_id` is never part of
 * the tool surface; it stays an internal key.
 */
export async function resolveScope(
	db: Db,
	auth: AuthInfo,
	args: Record<string, unknown>,
): Promise<ToolScope | { error: string }> {
	const raw =
		typeof args.project === 'string' && args.project.trim().length > 0 ? args.project.trim() : null;

	let scope: ToolScope | null = null;
	if (raw) {
		const p = await resolveProject(db, raw);
		if (!p) return { error: `Unknown project: ${raw}` };
		scope = { projectId: p.projectId, teamId: p.teamId };
	} else if (auth.type === AuthType.Agent) {
		scope = { projectId: auth.projectId, teamId: auth.teamId };
	} else {
		// Instance principals (an API key, the CEO chat session) have no home
		// project — they must name the project they want to act in.
		return { error: '`project` is required' };
	}

	const denied = await authorizeScope(db, auth, scope);
	if (denied) return { error: denied };
	return scope;
}

/** Authorize `auth` to act inside `scope`. Returns an error string, or null when allowed. */
async function authorizeScope(db: Db, auth: AuthInfo, scope: ToolScope): Promise<string | null> {
	switch (auth.type) {
		case AuthType.Agent:
			// Instance principals (CEO chat session / cross-project runs) roam every project.
			if (auth.crossProject || auth.crossTeam) return null;
			if (auth.projectId !== scope.projectId) {
				return 'Access denied: run is not scoped to this project';
			}
			return null;
		case AuthType.ApiKey:
			// Admin-equivalent: every project across the instance.
			return null;
		case AuthType.Admin: {
			if (auth.isSuperuser) return null;
			const r = await db.query(
				`SELECT 1 FROM members m JOIN member_users mu ON mu.id = m.id
				 WHERE mu.user_id = $1 AND m.team_id = $2`,
				[auth.userId, scope.teamId],
			);
			return r.rows.length > 0 ? null : 'Access denied: not a member of this project';
		}
		default:
			return 'Access denied';
	}
}

/**
 * Authorize `auth` for a team derived from a resource (e.g. an approval's team),
 * not from tool input. Used by the handful of tools keyed by a resource id whose
 * team is looked up server-side rather than passed in.
 */
async function authorizeTeam(db: Db, auth: AuthInfo, teamId: string): Promise<string | null> {
	switch (auth.type) {
		case AuthType.Agent:
			if (auth.crossTeam) return null;
			return auth.teamId === teamId ? null : 'Access denied: team mismatch';
		case AuthType.ApiKey:
			// Admin-equivalent: every team across the instance.
			return null;
		case AuthType.Admin: {
			if (auth.isSuperuser) return null;
			const r = await db.query(
				`SELECT 1 FROM members m JOIN member_users mu ON mu.id = m.id
				 WHERE mu.user_id = $1 AND m.team_id = $2`,
				[auth.userId, teamId],
			);
			return r.rows.length > 0 ? null : 'Access denied: not a member of this team';
		}
		default:
			return 'Access denied';
	}
}

/**
 * Resolve a tool call's project scope and its `task_id` argument (identifier or
 * UUID) together, verifying the task belongs to the resolved project.
 */
async function resolveTaskScope(
	db: Db,
	auth: AuthInfo,
	args: Record<string, unknown>,
): Promise<(ToolScope & { taskId: string }) | { error: string }> {
	const scope = await resolveScope(db, auth, args);
	if ('error' in scope) return scope;
	const raw = typeof args.task_id === 'string' ? args.task_id : '';
	if (!raw) return { error: 'task_id is required' };
	const taskId = await resolveTaskId(db, scope.teamId, raw);
	if (!taskId) return { error: `Task not found: ${raw}` };
	const r = await db.query<{ project_id: string }>(
		'SELECT project_id FROM tasks WHERE id = $1 AND team_id = $2',
		[taskId, scope.teamId],
	);
	if (r.rows.length === 0 || r.rows[0].project_id !== scope.projectId) {
		return { error: `Task not found in project: ${raw}` };
	}
	return { ...scope, taskId };
}

/** Standard schema entry for the optional `project` selector shared by project-scoped tools. */
const projectArg = () =>
	z
		.string()
		.optional()
		.describe(
			'Project slug or ID. Omit to use the project your run is already in; instance agents (CEO/Coach) must name the project to act in.',
		);

/**
 * Standard `filter` entry for doc/asset tools that can see archived items.
 * Defaults to 'active' so archived (soft-deleted) items stay invisible unless
 * a call explicitly asks for 'archived' or 'all'.
 */
const archiveFilterArg = () =>
	z
		.enum(Object.values(ArchiveFilter) as [string, ...string[]])
		.optional()
		.describe(
			"Which archive states to consider: 'active' (default - archived items are excluded), 'archived' (only archived), or 'all'.",
		);

const toArchiveFilter = (value: unknown): ArchiveFilter =>
	(value as ArchiveFilter | undefined) ?? ArchiveFilter.Active;

/**
 * Standard `sort` entry for the asset listing. Defaults to 'newest' (the
 * historical `created_at DESC` order).
 */
const assetSortArg = () =>
	z
		.enum(Object.values(AssetSortOrder) as [string, ...string[]])
		.optional()
		.describe(
			"Order of the returned assets: 'newest' (default - most recently created first), 'oldest', 'alphabetical' / 'alphabetical_desc' (by filename, A→Z / Z→A), 'size_asc' / 'size_desc' (by byte size), or 'type_asc' / 'type_desc' (by file extension, A→Z / Z→A).",
		);

const toAssetSortOrder = (value: unknown): AssetSortOrder =>
	(value as AssetSortOrder | undefined) ?? AssetSortOrder.Newest;

export function registerTools(
	server: McpServer,
	db: Db,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
	events?: DomainEventBus,
	containerDeps?: ContainerDeps,
	assetStore?: AssetStore,
	serverPort?: number,
): ToolDef[] {
	registeredTools.length = 0;
	// Startup always passes the selected store; the fallback covers direct
	// callers (reference generation, tests) that register without running
	// handlers or with a plain local data dir.
	const assets = assetStore ?? new LocalAssetStore(dataDir);
	// Fallback origin for agent-facing download URLs, used only by callers that
	// register the tools without dispatching a request (reference generation,
	// tests). A live tool call reads the caller's own origin off its request -
	// see `callerOriginContext`.
	const registeredOrigin = `http://127.0.0.1:${serverPort ?? 0}`;
	const agentOrigin = () => callerOriginContext.getStore() ?? registeredOrigin;

	// Teams
	tool(
		server,
		'list_teams',
		`List teams accessible to the caller, by name. An API key and the instance CEO (cross-team session) get every team in the instance; an ordinary agent run gets only its own team. Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{ ...listPagingArgs() },
		async (args, db, auth) => {
			const limit = parseListLimit(args.limit);
			const cursor = decodeCursor(args.cursor as string | undefined);
			const byName = { column: 'name', direction: 'asc', cast: 'text' } as const;
			// The instance CEO chat session acts across every team (cross-team gated
			// at mint time), so it discovers the whole roster — not just HQ. An
			// approved API key is admin-equivalent and spans the instance too.
			const all = async (extraJoin: string, extraWhere: string, base: unknown[]) => {
				const params = [...base];
				const keyset = keysetPredicate('c', cursor, params, byName);
				const where = [extraWhere, keyset].filter(Boolean).join(' AND ');
				const r = await db.query<ListRow>(
					`SELECT c.* FROM teams c ${extraJoin}
					 ${where ? `WHERE ${where}` : ''}
					 ORDER BY ${keysetOrderBy('c', byName)} LIMIT ${limit + 1}`,
					params,
				);
				return pagedList(r.rows, limit, 'list_teams', { column: 'name' });
			};
			if (auth.type === AuthType.ApiKey || (auth.type === AuthType.Agent && auth.crossTeam)) {
				return all('', '', []);
			}
			if (auth.type === AuthType.Agent) {
				return all('', 'c.id = $1', [auth.teamId]);
			}
			if (auth.type === AuthType.Admin) {
				if (auth.isSuperuser) return all('', '', []);
				return all(
					`JOIN members m ON m.team_id = c.id
					 JOIN member_users mu ON mu.id = m.id`,
					'mu.user_id = $1',
					[auth.userId],
				);
			}
			return pagedList([], limit, 'list_teams', { column: 'name' });
		},
		db,
	);

	tool(
		server,
		'get_team',
		'Get the team backing a project',
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query('SELECT * FROM teams WHERE id = $1', [scope.teamId]);
			return r.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_team',
		'Create a new team (superuser only)',
		{
			name: z.string().describe('Team name'),
			description: z.string().optional().describe('Team description'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Admin || !auth.isSuperuser) {
				return { error: 'Access denied: superuser required' };
			}
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const r = await db.query(
				`INSERT INTO teams (name, slug, description) VALUES ($1, $2, $3) RETURNING *`,
				[args.name, slug, args.description ?? ''],
			);
			return r.rows[0];
		},
		db,
		{ write: true, audience: 'admin_superuser' },
	);

	// Tasks
	tool(
		server,
		'list_tasks',
		`List a project's tasks, newest first. Omit \`project\` to use the project your run is in; pass it (slug or ID) to inspect another project. Narrow with status (comma-separated) or assignee_id/assignee_slug. The Project State block in your system prompt already gives you the active tasks in the current project - only call this if you need older or terminal tasks, another project, or a specific status filter. Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false. description and rules come back as excerpts capped at \`excerpt_chars\` (default ${DEFAULT_TASK_EXCERPT_CHARS}) so one page cannot be dominated by a few long tasks - read a task's full text with get_task.`,
		{
			project: projectArg(),
			status: z.string().optional().describe('Filter by status (comma-separated)'),
			assignee_id: z
				.string()
				.optional()
				.describe('Filter by assignee - an agent slug (e.g. "engineer") or a member UUID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Filter by assignee agent slug (alternative to assignee_id)'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					`Cap for the description and rules excerpts, with _truncated and _length companion fields (default ${DEFAULT_TASK_EXCERPT_CHARS}). Use get_task for a task's full text.`,
				),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const limit = parseListLimit(args.limit);
			const empty = pagedList([], limit, 'list_tasks');
			const conditions = ['i.project_id = $1'];
			const params: unknown[] = [scope.projectId];
			let idx = 2;
			if (args.status) {
				const statuses = (args.status as string).split(',').map((v) => v.trim());
				for (const status of statuses) {
					const invalid = taskStatusError(status);
					if (invalid) return { error: invalid };
				}
				const ph = statuses.map((_, i) => `$${idx + i}::task_status`).join(', ');
				conditions.push(`i.status IN (${ph})`);
				params.push(...statuses);
				idx += statuses.length;
			}
			let assigneeId = args.assignee_id
				? ((await resolveAssigneeId(db, scope.teamId, args.assignee_id as string)) ?? undefined)
				: undefined;
			// An assignee_id that resolves to nobody (unknown slug/id) matches nothing.
			if (args.assignee_id && !assigneeId) return empty;
			if (!assigneeId && args.assignee_slug) {
				const agent = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
					 JOIN members m ON m.id = ma.id
					 WHERE ma.slug = $1 AND m.team_id = $2`,
					[args.assignee_slug, scope.teamId],
				);
				if (agent.rows.length === 0) return empty;
				assigneeId = agent.rows[0].id;
			}
			if (assigneeId) {
				conditions.push(`i.assignee_id = $${idx}`);
				params.push(assigneeId);
				idx++;
			}
			const keyset = keysetPredicate('i', decodeCursor(args.cursor as string | undefined), params);
			if (keyset) conditions.push(keyset);
			const orderBy = keysetOrderBy('i');
			// limit + 1 is the has_more probe: the extra row answers "is there another
			// page" exactly, without a COUNT(*) over a table that only grows.
			const r = await db.query<ListRow>(
				`SELECT ${TASK_COLUMNS}, p.name AS project_name
				 FROM tasks i JOIN projects p ON p.id = i.project_id
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY ${orderBy} LIMIT ${limit + 1}`,
				params,
			);
			const max = (args.excerpt_chars as number | undefined) ?? DEFAULT_TASK_EXCERPT_CHARS;
			const rows = r.rows.map((row) => {
				let next = applyExcerpt(row as unknown as Record<string, unknown>, 'description', max);
				next = applyExcerpt(next, 'rules', max);
				return next as unknown as ListRow;
			});
			return pagedList(rows, limit, 'list_tasks');
		},
		db,
	);

	tool(
		server,
		'get_task',
		"Get task details, including the task's declared blockers (upstream - what this task is waiting on) and dependents (downstream - tasks that are blocked on this one). Each entry has identifier, title, and current status. A non-empty blockers list means an automatic agent run on this task is paused until every blocker reaches a terminal status (done, cancelled). The dependents list shows which teammates' tasks will be auto-unblocked when this task is marked terminal - you do not need to @-mention them, the auto-wake handles it.",
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { taskId } = scope;
			const r = await db.query<Record<string, unknown> & { project_id: string }>(
				`SELECT ${TASK_COLUMNS_BARE} FROM tasks i WHERE i.id = $1`,
				[taskId],
			);
			const task = r.rows[0];
			if (!task) return null;
			const blockers = await db.query(
				`SELECT d.id AS dependency_id, b.id, b.identifier, b.title, b.status::text AS status
				 FROM task_dependencies d
				 JOIN tasks b ON b.id = d.blocked_by_task_id
				 WHERE d.task_id = $1
				 ORDER BY d.created_at ASC`,
				[taskId],
			);
			const dependents = await db.query(
				`SELECT d.id AS dependency_id, b.id, b.identifier, b.title, b.status::text AS status
				 FROM task_dependencies d
				 JOIN tasks b ON b.id = d.task_id
				 WHERE d.blocked_by_task_id = $1
				 ORDER BY d.created_at ASC`,
				[taskId],
			);
			return {
				...(task as Record<string, unknown>),
				blockers: blockers.rows,
				dependents: dependents.rows,
			};
		},
		db,
	);

	tool(
		server,
		'create_task',
		"Create a new task. Use parent_task_id for sub-tasks - prefer this over a top-level task whenever the new work is part of the task you are on. Sub-tasks themselves can have sub-tasks, and those one further level, but no deeper (depth is capped at 3). Use assignee_slug as alternative to assignee_id. As an agent caller, you may only assign to yourself or to your direct subordinates - to request work from anyone else (peers, your manager, or agents elsewhere in the org), use create_comment with @<agent-slug> on a relevant task instead. Use blocked_by_task_ids to declare prerequisites - the assignee will not be woken on this task until every blocker reaches a terminal status (done, cancelled). When splitting work into sequential phases, prefer create_tasks and chain the items with '#<index>' blockers instead of filing them unordered. In title/description, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert.",
		{
			project: projectArg(),
			title: z.string().describe('Task title'),
			description: z.string().optional().describe('Task description'),
			priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
			assignee_id: z.string().optional().describe('Assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Assignee agent slug (alternative to assignee_id)'),
			parent_task_id: z
				.string()
				.optional()
				.describe(
					'Parent task to nest this under as a sub-task - a task identifier (e.g. "BE-2") or UUID. Sub-tasks can themselves have sub-tasks, and those one further level, but no deeper - depth is capped at 3.',
				),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Pin this task to a specific AI runtime (claude_code, codex, antigravity). Leave unset to use the instance default.',
				),
			blocked_by_task_ids: z
				.array(z.string())
				.optional()
				.describe(
					'Task identifiers (e.g. ["BE-2", "BE-3"]) or UUIDs that must reach a terminal status before this task is started. The assignee will not be woken on this task until every blocker is satisfied.',
				),
			goal_id: z
				.string()
				.optional()
				.describe(
					'UUID of the project goal this task advances. Links the task to the goal for traceability; it does not gate or change how the task runs. (Captain) set this when filing work to move a goal forward.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const caller = await buildMcpCreateTaskCaller(db, auth, scope.teamId);
			let created: Awaited<ReturnType<typeof createTask>>;
			try {
				created = await createTask(
					db,
					scope.teamId,
					mcpArgsToCreateTaskInput(args, scope.projectId),
					caller,
					wsManager,
					events,
				);
			} catch (e) {
				if (e instanceof CreateTaskError) return { error: e.message };
				throw e;
			}
			// A task filed by a live chat turn leaves a receipt in its conversation
			// and remembers where it came from, so completion and blocked receipts
			// can find their way back. No-op for every other caller.
			await recordChatTaskOrigin(db, wsManager, auth, created);
			return withBacktickWarning(
				db,
				auth,
				scope.teamId,
				scope.projectId,
				args.description as string | undefined,
				created,
			);
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'suggest_goal',
		'Suggest a project goal for the admin to approve. Callable only by the team Captain (or the CEO targeting a team via `project`). Goals come from the admin, so ask first: before suggesting anything, ask the admin what they want the project to achieve (on the planning/onboarding task or via an @admin comment), wait for their reply, and formulate each suggestion from their stated objectives - never file a suggestion the admin\'s own words do not support. This does NOT create a goal directly - it files a suggestion the admin reviews as an Approve/Deny card; the real goal exists only once they approve. A goal is an OUTCOME or MILESTONE the admin wants the project to achieve - a state of the world to reach, or reach and hold (e.g. "reach 10k monthly readers", "100 active customers, held"); its `measurement` judges results, never activity performance. If the candidate reads as "do X every day/week" - monitor, sweep, deliver a periodic report, keep a process running - it is NOT a goal: that is recurring operational work, filed with `create_task` as a standing task that stays open (optionally linked to a goal via `goal_id`), and so is any finite deliverable with a fixed done state - a document to produce, a one-time analysis, a feature to ship. Pass a `title`, a `measurement` (the precise definition of when it is achieved - the bar to judge against; write it SMART), optional `actions` (guidance on what to do/check when assessing it), a `check_frequency` (daily/weekly/monthly - how often the Captain re-assesses progress, not a schedule for doing work), and an optional `target_date` (deadline, ISO YYYY-MM-DD - milestones with target dates are legitimate goals). Pass `task_id` (recommended - usually your planning task) to surface the suggestion as an Approve/Deny card in that task\'s thread; it also appears on the project\'s Goals page.',
		{
			project: projectArg(),
			title: z.string().describe('Short goal title.'),
			measurement: z
				.string()
				.optional()
				.describe('The precise, measurable definition of when the goal is achieved.'),
			actions: z
				.string()
				.optional()
				.describe(
					'Optional guidance on what the Captain should do or check when assessing the goal.',
				),
			check_frequency: z
				.enum(['daily', 'weekly', 'monthly'])
				.optional()
				.describe(
					"How often the goal is re-assessed once created (default daily). This is the Captain's re-assessment cadence, not a schedule for doing work: pick by how often the measurement meaningfully changes - daily for fast-moving measurements, weekly for steady ones, monthly for slow-moving outcomes. Checks recur indefinitely - this is a cadence, not a deadline.",
				),
			target_date: z.string().optional().describe('Optional deadline as an ISO date (YYYY-MM-DD).'),
			task_id: z
				.string()
				.optional()
				.describe(
					'Optional originating task to attach the suggestion card to - a task identifier (e.g. "HM-1") or UUID.',
				),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent || !auth.memberId) {
				return { error: 'suggest_goal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			const callerSlug = caller.rows[0]?.slug;
			if (callerSlug !== CAPTAIN_AGENT_SLUG && callerSlug !== CEO_AGENT_SLUG) {
				return { error: 'Only the Captain or CEO can suggest goals' };
			}
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const teamId = scope.teamId;

			const proj = await db.query<{ is_internal: boolean }>(
				`SELECT is_internal FROM projects WHERE id = $1 AND team_id = $2`,
				[scope.projectId, teamId],
			);
			if (proj.rows.length === 0) return { error: 'Project not found' };
			if (proj.rows[0].is_internal) return { error: 'The HQ project does not support goals' };

			const title = (args.title as string)?.trim();
			if (!title) return { error: 'title is required' };

			let taskId: string | null = null;
			if (args.task_id !== undefined) {
				const resolved = await resolveTaskId(db, teamId, args.task_id as string);
				const taskCheck = resolved
					? await db.query<{ id: string }>('SELECT id FROM tasks WHERE id = $1 AND team_id = $2', [
							resolved,
							teamId,
						])
					: null;
				if (!resolved || !taskCheck || taskCheck.rows.length === 0) {
					return { error: 'task_id not found on this team' };
				}
				taskId = resolved;
			}

			const payload: GoalSuggestionPayload = {
				project_id: scope.projectId,
				title,
				measurement: args.measurement as string | undefined,
				actions: args.actions as string | undefined,
				check_frequency: args.check_frequency as string | undefined,
				target_date: (args.target_date as string | undefined) ?? null,
				task_id: taskId,
			};
			const row = await insertGoalSuggestionApproval(db, teamId, payload, auth.memberId);
			broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			if (taskId) {
				await insertGoalSuggestionComment(
					db,
					{
						taskId,
						approvalId: row.id as string,
						payload: payload as unknown as Record<string, unknown>,
						teamId,
						projectId: scope.projectId,
					},
					wsManager,
				);
			}
			return { approval_id: row.id, status: row.status, payload: row.payload };
		},
		db,
		{ write: true, audience: 'captain_or_ceo' },
	);

	tool(
		server,
		'list_goals',
		"List a project's goals (the objectives the Captain tracks). Each goal has a title, a `measurement` (the precise definition of when the goal is achieved - the bar to judge against), optional `actions` (admin guidance on what to do/check toward it), the Captain's current progress_percent (0-100), a health (pending/on_track/at_risk/off_track), a status_blurb, a check_frequency (daily/weekly/monthly), an optional target_date (deadline), and last_checked_at. As the Captain, call this during your heartbeat to see which goals are due for a fresh assessment, then call update_goal_progress for each. Archived goals are excluded unless include_archived is true.",
		{
			project: projectArg(),
			include_archived: z.boolean().optional().describe('Include archived goals (default false).'),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const limit = parseListLimit(args.limit);
			const all = await listGoals(db, scope.projectId, {
				includeArchived: args.include_archived === true,
			});
			// Goals are admin-authored objectives - a handful per project, and the
			// service orders them by a composite (archived, created_at) the keyset
			// predicate cannot express. Slicing the resolved set keeps the envelope
			// uniform without pushing a cursor into a query that would not benefit.
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? all.findIndex((g) => g.id === cursor.id) + 1 : 0;
			return pagedList(
				all.slice(from, from + limit + 1) as unknown as ListRow[],
				limit,
				'list_goals',
			);
		},
		db,
	);

	tool(
		server,
		'update_goal_progress',
		"Record your current assessment of a goal's progress. Only the Captain does this, and only from within a progress-update run. Pass progress_percent (0-100, your honest estimate - do not lower it without a reason in the blurb), health (on_track / at_risk / off_track, weighing progress against the target_date), and a one-paragraph status_blurb explaining where the goal stands and what is needed next. This updates the goal's live status and appends a point to its progress history; the goal then won't be re-surfaced for checking until its cadence elapses again. Reaching 100 does not end tracking: the goal stays on its cadence forever (progress can later drop back below 100, and some goals are never-ending, measured continuously), so keep recording your honest current assessment on every check.",
		{
			project: projectArg(),
			goal_id: z.string().describe('UUID of the goal to update.'),
			progress_percent: z
				.number()
				.int()
				.min(0)
				.max(100)
				.describe('Estimated progress toward the goal, 0-100.'),
			health: z.enum(CAPTAIN_SETTABLE_GOAL_HEALTH).describe('on_track, at_risk, or off_track.'),
			status_blurb: z
				.string()
				.describe('One-paragraph summary of where the goal stands and the next step.'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'update_goal_progress can only be called from within an agent run' };
			}
			const goalId = args.goal_id as string;
			const found = await db.query<{ id: string }>(
				`SELECT id FROM goals WHERE id = $1 AND project_id = $2 AND archived_at IS NULL`,
				[goalId, scope.projectId],
			);
			if (found.rows.length === 0) {
				return { error: `Goal not found in project: ${goalId}` };
			}
			try {
				return await recordGoalProgress(
					db,
					{
						goalId,
						runId: auth.runId,
						progressPercent: args.progress_percent as number,
						health: args.health as GoalHealth,
						statusBlurb: args.status_blurb as string,
					},
					wsManager,
				);
			} catch (e) {
				if (e instanceof Error && 'code' in e) return { error: e.message };
				throw e;
			}
		},
		db,
		{ write: true, audience: 'agent_run' },
	);

	tool(
		server,
		'update_project_progress',
		'Replace the project progress summary shown at the top of the project dashboard. Only the Captain does this, and only from within a progress-update run. The summary is the high-level read: where the project stands, what has taken place, and what is being planned. Pitch it at what the work means for the project, not a log of what happened inside individual tasks, and leave out mechanics like branches, CI and review round-trips. Do NOT name individual tasks or identifiers - the dashboard lists the specific work beneath this, and a reader who wants a task clicks through to it. This overwrites the whole summary, so include everything that should remain.',
		{
			project: projectArg(),
			summary: z
				.string()
				.describe(
					'Markdown summary of where the project stands: what has taken place and what is being planned. Lead with the key points in **bold**, then a short narrative. Do not reference task identifiers.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'update_project_progress can only be called from within an agent run' };
			}
			try {
				return await updateProjectProgress(
					db,
					scope.teamId,
					scope.projectId,
					args.summary as string,
					wsManager,
				);
			} catch (e) {
				if (e instanceof ProjectProgressError) return { error: e.message };
				throw e;
			}
		},
		db,
		{ write: true, audience: 'agent_run' },
	);

	tool(
		server,
		'create_tasks',
		`Create multiple tasks in one call (max ${MAX_BATCH_CREATE_TASKS}). Items are created in order; each has the same shape as create_task, and per-item errors are returned without aborting the rest. When the items are slices of the task you are on - delegated tracks handed to direct reports, parallel slices, phases of its deliverable - set parent_task_id on EACH item (normally your current task) so they are sub-tasks; filing them top-level detaches them and lets the parent close while they are still open. Within a batch, blocked_by_task_ids entries may reference an earlier item in the same call by zero-based index token - '#0' is the first item. To chain sequential work (e.g. implementation phases that must run one at a time), set blocked_by_task_ids: ['#<previous index>'] on every item after the first; each task then stays blocked until the one before it reaches a terminal status. Filing sequential phases WITHOUT these blockers makes all of them runnable at once. Index tokens may only point at earlier items; a token that is self-referencing, forward-referencing, or points at an item that failed errors that item. Use this when filing a related set of tasks in one go (planning a feature, splitting a task into phases or sub-tasks). For a single task, use create_task.`,
		{
			project: projectArg(),
			items: z
				.array(
					z.object({
						title: z.string().describe('Task title'),
						description: z.string().optional().describe('Task description'),
						priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
						assignee_id: z.string().optional().describe('Assignee member ID'),
						assignee_slug: z
							.string()
							.optional()
							.describe('Assignee agent slug (alternative to assignee_id)'),
						parent_task_id: z
							.string()
							.optional()
							.describe(
								'Parent task to nest this under as a sub-task - a task identifier (e.g. "BE-2"), UUID, or a zero-based index token referencing an earlier item in this same call (e.g. "#0" = first item). Sub-tasks can themselves have sub-tasks, and those one further level, but no deeper - depth is capped at 3.',
							),
						runtime_type: z
							.string()
							.optional()
							.describe(
								'Pin this task to a specific AI runtime (claude_code, codex, antigravity). Leave unset to use the instance default.',
							),
						blocked_by_task_ids: z
							.array(z.string())
							.optional()
							.describe(
								'Task identifiers (e.g. ["BE-2"]), UUIDs, or zero-based index tokens referencing earlier items in this same call (e.g. "#0" = first item). All must reach a terminal status before this task starts. To chain phases sequentially, set ["#<previous index>"] on each item after the first.',
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_CREATE_TASKS)
				.describe(`Up to ${MAX_BATCH_CREATE_TASKS} items.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const items = args.items as Array<Record<string, unknown>>;
			const caller = await buildMcpCreateTaskCaller(db, auth, scope.teamId);

			const results = await createTaskBatch(
				db,
				scope.teamId,
				items.map((item) => mcpArgsToCreateTaskInput(item, scope.projectId)),
				caller,
				wsManager,
				events,
			);
			if (auth.type !== AuthType.Agent) return results;
			// Same receipt a single create_task leaves - one per created item.
			for (const r of results) {
				if (r.ok) await recordChatTaskOrigin(db, wsManager, auth, r.task);
			}
			// Per-item advisory: flag a created task whose own description backticked
			// a real entity. Keyed by the result index back to the source item.
			return Promise.all(
				results.map(async (r) => {
					if (!r.ok) return r;
					const description = items[r.index]?.description;
					const task = await withBacktickWarning(
						db,
						auth,
						scope.teamId,
						scope.projectId,
						typeof description === 'string' ? description : undefined,
						r.task,
					);
					return { ...r, task };
				}),
			);
		},
		db,
		{ write: true, batchArrayParam: 'items' },
	);

	tool(
		server,
		'update_task',
		'Update a task. Agents can use this to change status, update progress, set rules, and record branch names. To finish a task, set status to `done` - that is the final completed state and wakes Coach to review the task for prompt-learning (the task stays `done`). Use `cancelled` for abandoned work. Setting `done` is rejected for agent callers while the task has an @admin question no human has answered yet - keep the task `in_progress` until the admin replies. Re-opening a completed task (`done`/`cancelled`) is admin-only. As an agent caller, reassigning is limited to yourself or your direct subordinates; to hand work to a peer or manager use create_comment with @<agent-slug> instead. A run on the task blocks a reassignment only when it belongs to some other agent - your own run never blocks you, so you can hand off a task you are running, and neither does a run belonging to the agent you are assigning to. Set `parent_task_id` to move this task under a different parent, or to an empty string to promote it to a top-level task; prefer that over cancelling a mis-filed sub-task and re-filing it as a new top-level task. In description, progress_summary, and rules, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			title: z.string().optional().describe('New title'),
			description: z.string().optional().describe('New description'),
			status: z
				.string()
				.optional()
				.describe(
					'New status (backlog, in_progress, blocked, done, cancelled). `done` = completed (final); marking a task `done` wakes Coach to review it for prompt-learning but leaves it `done`. `cancelled` = abandoned. Re-opening a completed task (done/cancelled) is admin-only.',
				),
			priority: z.string().optional().describe('New priority'),
			assignee_id: z
				.string()
				.optional()
				.describe('New assignee - an agent slug (e.g. "engineer") or a member UUID'),
			progress_summary: z.string().optional().describe('Progress summary update'),
			rules: z
				.string()
				.optional()
				.describe(
					'How-to-work-on guardrails for this task - approach constraints that shape execution (e.g. "run tests before committing", "consult the architect before auth changes"). Not a channel for passing project domain knowledge to other agents; put that in description instead.',
				),
			branch_name: z.string().optional().describe('Git branch name for this task'),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Override the AI runtime for this task (claude_code, codex, antigravity). Pass an empty string to clear.',
				),
			parent_task_id: z
				.string()
				.nullable()
				.optional()
				.describe(
					'Move this task under a different parent - a task identifier (e.g. "BE-2") or UUID. Pass an empty string or null to promote it to a top-level task. Omit to leave the parent unchanged. The parent must be in the same project, cannot be the task itself or one of its own sub-tasks, and the whole sub-tree being moved must still fit within the depth cap of 3. An open task cannot be nested under a parent that is already done or cancelled.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId, projectId } = scope;

			const currentRowResult = await db.query<{
				title: string;
				description: string | null;
				status: string;
				assignee_id: string | null;
				parent_task_id: string | null;
				progress_summary: string | null;
			}>(
				`SELECT title, description, status, assignee_id, parent_task_id, progress_summary
				 FROM tasks WHERE id = $1`,
				[taskId],
			);
			const currentRow = currentRowResult.rows[0];

			const scopeDenied = assertRunTaskScope(auth, taskId, args.status as string | undefined);
			if (scopeDenied) return { error: scopeDenied };

			const currentStatus = currentRow?.status;
			const previousAssigneeId = currentRow?.assignee_id ?? null;

			// Normalize the title the way the REST route does (`tasks.ts`), so both
			// surfaces store the same value and the rename recorder treats the same
			// whitespace-only edits as no-ops.
			if (typeof args.title === 'string') args.title = args.title.trim();

			// Accept a teammate slug (what an agent holds) or a member UUID; every
			// downstream check + the UPDATE below consumes the resolved member id.
			if (typeof args.assignee_id === 'string' && args.assignee_id) {
				const resolvedAssignee = await resolveAssigneeId(db, teamId, args.assignee_id);
				if (!resolvedAssignee) return { error: `Assignee not found: ${args.assignee_id}` };
				args.assignee_id = resolvedAssignee;
			}

			if (args.status !== undefined) {
				const invalid = taskStatusError(args.status as string);
				if (invalid) return { error: invalid };
			}

			// `done` and `cancelled` are the only terminal states; once a task is
			// terminal only the admin can re-open it (move it back to active).
			if (
				args.status !== undefined &&
				args.status !== currentStatus &&
				auth.type === AuthType.Agent &&
				(TERMINAL_TASK_STATUSES as readonly string[]).includes(currentStatus ?? '')
			) {
				return { error: 'Only the admin can re-open a completed task' };
			}

			if (args.status === TaskStatus.Done) {
				const childrenCheck = await assertChildrenAllClosed(db, teamId, taskId);
				if (!childrenCheck.ok) return { error: childrenCheck.message };
			}
			if (args.status === TaskStatus.Done) {
				const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const activityCheck = await assertNoOutstandingActivity(db, taskId, callerMemberId);
				if (!activityCheck.ok) return { error: activityCheck.message };
				// Agents cannot close over an unanswered @admin ask; humans (and
				// API keys — admin-equivalent) can always close through it.
				if (callerMemberId !== null) {
					const adminAskCheck = await assertNoUnansweredAdminMentions(db, taskId);
					if (!adminAskCheck.ok) return { error: adminAskCheck.message };
				}
			}

			if (args.status !== undefined) {
				args.status = await coerceTargetStatusForBlockers(db, taskId, args.status as string);
			}

			if (args.assignee_id && currentRow) {
				if (args.assignee_id !== previousAssigneeId) {
					const blocking = await assertNoBlockingRun(db, taskId, {
						callerMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
						incomingAssigneeId: args.assignee_id as string,
					});
					if (!blocking.ok) return { error: blocking.message };
				}
				if (auth.type === AuthType.Agent && args.assignee_id !== previousAssigneeId) {
					const hierarchyCheck = await assertSubordinateAssignee(
						db,
						auth.memberId,
						args.assignee_id as string,
					);
					if (!hierarchyCheck.ok) return { error: hierarchyCheck.message };
				}
			}

			// Placed after the status guards (matching the REST handler) so a combined
			// {status, parent_task_id} call reports the status problem first.
			//
			// The generic SQL builder below writes whatever sits on `args`, so an
			// identifier like "BE-2" would reach the uuid column unresolved and come
			// back as "invalid input syntax for type uuid". Normalize in place here,
			// mirroring the assignee resolution above. A surviving null is exactly
			// the promote-to-top-level semantics the builder should emit; deleting
			// the key on a no-op is what keeps an unchanged row from being rewritten.
			const oldParentTaskId = currentRow?.parent_task_id ?? null;
			let parentChangedTo: string | null = null;
			let parentChanged = false;
			if (args.parent_task_id !== undefined) {
				const assignment = await resolveParentAssignment(
					db,
					teamId,
					{
						taskId,
						projectId,
						currentParentTaskId: oldParentTaskId,
						status: currentRow?.status ?? '',
					},
					args.parent_task_id as string | null,
				);
				if (!assignment.ok) return { error: assignment.message };
				if (assignment.changed) {
					args.parent_task_id = assignment.parentTaskId;
					parentChangedTo = assignment.parentTaskId;
					parentChanged = true;
				} else {
					delete args.parent_task_id;
				}
			}

			const sets: string[] = [];
			const params: unknown[] = [];
			let idx = 1;
			for (const [key, val] of Object.entries(args)) {
				if (['project', 'task_id'].includes(key) || val === undefined) continue;
				if (key === 'status') {
					sets.push(`status = $${idx}::task_status`);
				} else if (key === 'priority') {
					sets.push(`priority = $${idx}::task_priority`);
				} else if (key === 'runtime_type') {
					sets.push(`runtime_type = $${idx}::agent_runtime`);
					params.push(val === '' ? null : val);
					idx++;
					continue;
				} else if (key === 'progress_summary') {
					// The current length keeps a summary written before this ceiling
					// existed shrinkable, rather than frozen at whatever size it is.
					const oversize = checkInjectedTextCap(
						'task_progress_summary',
						String(val ?? ''),
						currentRow?.progress_summary?.length,
					);
					if (oversize) return { error: oversize.error };
					sets.push(`progress_summary = $${idx}`);
					params.push(val);
					idx++;
					sets.push('progress_summary_updated_at = now()');
					const updatedBy = auth.type === AuthType.Agent ? auth.memberId : null;
					sets.push(`progress_summary_updated_by = $${idx}`);
					params.push(updatedBy);
					idx++;
					continue;
				} else {
					sets.push(`${key} = $${idx}`);
				}
				params.push(val);
				idx++;
			}
			if (sets.length === 0) return { unchanged: true };
			params.push(taskId);
			const r = await db.query(
				`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${TASK_COLUMNS_BARE}`,
				params,
			);
			if (!r.rows[0]) return null;

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const actorApiKeyId = apiKeyIdFromAuth(auth);
			// Every wakeup this write causes carries the run behind it, so that run's
			// own no-wake exit check can see whom it notified.
			const callerRunId = auth.type === AuthType.Agent ? (auth.runId ?? null) : null;

			// Renames and description edits are recorded on this surface too, so an
			// agent's edit leaves the same thread entry a human's does. Awaited for the
			// same reason as the parent change below: a human watching the task page
			// depends on the broadcast that lands with the comment.
			if (args.title !== undefined && currentRow) {
				try {
					await recordTitleChange(
						db,
						teamId,
						taskId,
						currentRow.title,
						args.title as string,
						actorMemberId,
						actorApiKeyId,
						wsManager,
					);
				} catch (e) {
					log.error('Failed to record title change:', e);
				}
			}

			if (args.description !== undefined) {
				if (currentRow) {
					try {
						await recordDescriptionChange(
							db,
							teamId,
							taskId,
							currentRow.description,
							args.description as string,
							actorMemberId,
							actorApiKeyId,
							wsManager,
						);
					} catch (e) {
						log.error('Failed to record description change:', e);
					}
				}

				trackBackground(
					recordTaskLinks(
						db,
						teamId,
						taskId,
						args.description as string,
						actorMemberId,
						actorApiKeyId,
						wsManager,
					).catch((e) => log.error('Failed to record task links from description:', e)),
				);
			}

			if (parentChanged) {
				// Awaited: a human watching the task page depends on the broadcast that
				// lands with this comment.
				try {
					await recordParentChange(
						db,
						teamId,
						taskId,
						oldParentTaskId,
						parentChangedTo,
						actorMemberId,
						actorApiKeyId,
						wsManager,
					);
				} catch (e) {
					log.error('Failed to record parent change:', e);
				}
				// Moving a task out clears the former parent's child-closure gate just
				// as closing it would. The new parent gets nothing: gaining a child can
				// only add an open child, never clear a gate.
				if (oldParentTaskId) {
					trackBackground(
						wakeTaskIfChildrenClosed(db, teamId, oldParentTaskId, callerRunId).catch((e) =>
							log.error('Failed to wake former parent after re-parent:', e),
						),
					);
				}
			}

			// Ordered to match the REST route (description, title, parent, assignee,
			// status) so both surfaces lay the same sequence of system comments into
			// the thread.
			if (currentRow && args.assignee_id && args.assignee_id !== previousAssigneeId) {
				// Awaited: a human watching the task page depends on the broadcast that
				// lands with this comment.
				try {
					const names = await recordAssigneeChange(
						db,
						teamId,
						taskId,
						previousAssigneeId,
						args.assignee_id as string,
						actorMemberId,
						actorApiKeyId,
						wsManager,
					);
					events?.emit({
						type: 'task.updated',
						teamId,
						projectId,
						actorType: actorTypeFromAuth(auth),
						actorMemberId,
						actorApiKeyId,
						taskId,
						field: 'assignee',
						from: previousAssigneeId,
						to: args.assignee_id as string,
						fromLabel: names?.fromName ?? null,
						toLabel: names?.toName ?? null,
					});
				} catch (e) {
					log.error('Failed to record assignee change:', e);
				}
				// Awaited: this run's own no-wake exit check reads the wakeup back at
				// the end of the run, so a handover made as the last action would
				// otherwise be reported as notifying nobody.
				await wakeAgentIfAssigned(
					db,
					args.assignee_id as string,
					teamId,
					taskId,
					undefined,
					undefined,
					callerRunId,
				);
			}

			if (args.status && currentStatus) {
				try {
					await triggerStatusAutomations(
						db,
						teamId,
						taskId,
						currentStatus,
						args.status as string,
						actorMemberId,
						actorApiKeyId,
						wsManager,
						dataDir,
						callerRunId,
					);
				} catch (e) {
					log.error('Failed to trigger status automations:', e);
				}
			}

			const updatedText = [args.description, args.progress_summary, args.rules]
				.filter((v): v is string => typeof v === 'string')
				.join('\n');
			return withBacktickWarning(
				db,
				auth,
				teamId,
				scope.projectId,
				updatedText || undefined,
				r.rows[0],
			);
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'add_task_blocker',
		'Declare that one task blocks another. The downstream task will not start an automatic agent run until the blocker reaches a terminal status (done, cancelled). Use this when you discover that a task you have been woken on depends on work that has not landed yet - declare the blocker and end your turn; the system will wake you again when the blocker resolves. Cycles are rejected.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID that should be blocked'),
			blocked_by_task_id: z.string().describe('Task identifier or UUID of the upstream blocker'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const blockerId = await resolveTaskId(db, teamId, args.blocked_by_task_id as string);
			if (!blockerId) return { error: 'Blocking task not found in this project' };
			if (blockerId === taskId) return { error: 'A task cannot block itself' };
			if (await wouldCreateCycle(db, taskId, blockerId)) {
				return { error: 'Dependency would create a cycle' };
			}
			const r = await db.query(
				`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
				 VALUES ($1, $2) ON CONFLICT DO NOTHING
				 RETURNING id, task_id, blocked_by_task_id, created_at`,
				[taskId, blockerId],
			);
			if (r.rows.length === 0) return { error: 'Dependency already exists' };
			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, wsManager);
			return r.rows[0];
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'remove_task_blocker',
		"Remove a blocker between two tasks. Call this when a dependency that was previously declared no longer applies. If removing this dependency clears the downstream task's last open blocker, its assignee is woken automatically.",
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID that is currently blocked'),
			blocked_by_task_id: z.string().describe('Task identifier or UUID of the blocker to remove'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const blockerId = await resolveTaskId(db, teamId, args.blocked_by_task_id as string);
			if (!blockerId) return { error: 'Blocking task not found' };
			const r = await db.query(
				'DELETE FROM task_dependencies WHERE task_id = $1 AND blocked_by_task_id = $2 RETURNING id',
				[taskId, blockerId],
			);
			if (r.rows.length === 0) return { error: 'Dependency not found' };
			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, wsManager);
			await wakeIfReady(db, taskId, auth.type === AuthType.Agent ? (auth.runId ?? null) : null);
			return { removed: true };
		},
		db,
		{ write: true },
	);

	// Agents
	tool(
		server,
		'list_agents',
		`List the agents on a project's team, by title. Each row carries \`reports_to\` (the manager's member ID, null when unset) plus \`reports_to_slug\`/\`reports_to_title\` - this is the structural reporting line that gates delegation, so it is what to read when auditing the org chart for orphans (\`reports_to\` null) or cycles. Do NOT infer reporting lines from an agent's team_context prose: that prose is a rendered description which can itself be stale, and is exactly what a coherence review is meant to check against this field. Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			project: projectArg(),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const limit = parseListLimit(args.limit);
			const byTitle = { column: 'title', direction: 'asc', cast: 'text', idAlias: 'm' } as const;
			const params: unknown[] = [scope.teamId];
			const keyset = keysetPredicate(
				'ma',
				decodeCursor(args.cursor as string | undefined),
				params,
				byTitle,
			);
			const r = await db.query<ListRow>(
				// reports_to is the column delegation is actually gated on, and the
				// only way to detect an orphan or a cycle. The manager's slug/title
				// ride along because agents address each other by slug, so without
				// them every caller pays a second lookup per row to resolve the id.
				// human_name/_slug match the REST listing: an agent goes by its role
				// unless a human named it, and both are mention handles, so a
				// coherence review can otherwise neither see who is named nor
				// address them the way the thread does.
				`SELECT m.id, ma.agent_type_id, ma.title, ma.slug,
				        ma.human_name, ma.human_name_slug,
				        ma.daily_budget_cents, ma.weekly_budget_cents, ma.monthly_budget_cents,
				        ma.runtime_status, ma.admin_status,
				        ma.reports_to, mgr.slug AS reports_to_slug, mgr.title AS reports_to_title
				 FROM members m JOIN member_agents ma ON ma.id = m.id
				 LEFT JOIN member_agents mgr ON mgr.id = ma.reports_to
				 WHERE m.team_id = $1${keyset ? ` AND ${keyset}` : ''}
				 ORDER BY ${keysetOrderBy('ma', byTitle)} LIMIT ${limit + 1}`,
				params,
			);
			return pagedList(r.rows, limit, 'list_agents', { column: 'title' });
		},
		db,
	);

	tool(
		server,
		'update_hire_proposal',
		'Revise the draft of a pending hire approval. Captain-only. Use this to expand or rewrite the system prompt, adjust role description, budget, heartbeat, or touches_code before admin review. All fields are optional - pass only what you want to change.',
		{
			approval_id: z.string().describe('Hire approval ID'),
			title: z.string().optional().describe('Updated role title'),
			human_name: z
				.string()
				.trim()
				.max(AGENT_HUMAN_NAME_MAX)
				.optional()
				.describe('Updated human name for the new teammate, or an empty string to clear it'),
			role_description: z.string().optional().describe('Updated short role description'),
			system_prompt: z
				.string()
				.optional()
				.describe(
					'Updated system prompt. No substitution variable is required: Hezo composes the agent identity above this body and the live skills, preferences and project-docs context below it, adding only what the body does not already name.',
				),
			reports_to: z
				.string()
				.optional()
				.describe(
					"Updated manager - an existing agent's slug. Pass an empty string to clear the reporting line.",
				),
			default_effort: z
				.string()
				.optional()
				.describe('Updated default effort: minimal, low, medium, high, max'),
			heartbeat_interval_min: z
				.number()
				.int()
				.min(heartbeatIntervalFloorMin())
				.optional()
				.describe(`Updated heartbeat interval. ${heartbeatIntervalArgDescription()}`),
			monthly_budget_cents: z.number().optional().describe('Updated monthly budget in cents'),
			touches_code: z.boolean().optional().describe('Whether this agent reads/writes repo code'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'update_hire_proposal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CAPTAIN_AGENT_SLUG) {
				return { error: 'Only the Captain can revise hire proposals' };
			}

			const approval = await db.query<{
				id: string;
				team_id: string;
				type: string;
				status: string;
				payload: Record<string, unknown>;
			}>('SELECT id, team_id, type, status, payload FROM approvals WHERE id = $1', [
				args.approval_id,
			]);
			if (approval.rows.length === 0) return { error: 'Approval not found' };

			const row = approval.rows[0];
			if (row.team_id !== auth.teamId) {
				return { error: 'Access denied: team mismatch' };
			}
			if (row.type !== ApprovalType.Hire) {
				return { error: 'Approval is not a hire request' };
			}
			if (row.status !== ApprovalStatus.Pending) {
				return { error: 'Hire approval is already resolved' };
			}

			// A revised manager must resolve to an agent on this team (empty clears it).
			if (typeof args.reports_to === 'string' && args.reports_to.trim()) {
				const raw = args.reports_to.trim();
				if (raw === row.payload.slug) {
					return { error: 'reports_to: an agent cannot report to itself' };
				}
				const managerId = await resolveAgentId(db, row.team_id, raw);
				if (!managerId) return { error: `reports_to: no agent '${raw}' in this team` };
			}

			const patch = buildHirePayloadPatch(args as HirePayloadPatchInput);

			if (Object.keys(patch).length === 0) {
				return { error: 'no fields to update' };
			}

			const updated = await db.query<Record<string, unknown>>(
				`UPDATE approvals SET payload = payload || $1::jsonb
				 WHERE id = $2 RETURNING ${APPROVAL_COLUMNS}`,
				[JSON.stringify(patch), args.approval_id],
			);
			return updated.rows[0] ?? null;
		},
		db,
		{ write: true, audience: 'captain' },
	);

	tool(
		server,
		'create_hire_proposal',
		'File a new hire proposal. Callable by a team Captain (for its own team) or the CEO (for any team - pass `project` to target it, including HQ). Use this when directed or deciding to staff or expand a team: author the full role spec - title, role description, and a complete system prompt - and submit it. The proposal surfaces as a pending approval in the admin inbox; the admin reviews, may modify it, and approves, at which point the agent is created automatically. Pass task_id to link the proposal back to the task that prompted it.',
		{
			project: projectArg(),
			title: z.string().describe('Role title (the slug is derived from it)'),
			human_name: z
				.string()
				.trim()
				.max(AGENT_HUMAN_NAME_MAX)
				.optional()
				.describe(
					'Optional human name for the new teammate (e.g. "Max"). Shown in place of the role and usable as a mention handle. Leave it out unless the admin asked for a name - an agent is normally addressed by its role.',
				),
			role_description: z.string().optional().describe('Short role description'),
			system_prompt: z
				.string()
				.optional()
				.describe(
					'Full system prompt for the new agent. Write the role itself; no substitution variable is required. Hezo composes the agent identity (team, description, manager) above this body and the live skills, preferences and project-docs context below it, adding only what the body does not already name. Author it in the style of the built-in role docs.',
				),
			reports_to: z
				.string()
				.optional()
				.describe(
					'The manager this agent reports to - an existing agent\'s slug (e.g. "architect"). Sets the structural reporting line so work can be delegated to and from this agent. Must be an agent already on the team.',
				),
			default_effort: z
				.string()
				.optional()
				.describe('Default reasoning effort: minimal, low, medium, high, max'),
			heartbeat_interval_min: z
				.number()
				.int()
				.min(heartbeatIntervalFloorMin())
				.describe(heartbeatIntervalArgDescription()),
			daily_budget_cents: z.number().optional().describe('Daily budget in cents'),
			weekly_budget_cents: z.number().optional().describe('Weekly budget in cents'),
			monthly_budget_cents: z.number().optional().describe('Monthly budget in cents'),
			touches_code: z.boolean().optional().describe('Whether this agent reads/writes repo code'),
			task_id: z
				.string()
				.optional()
				.describe(
					'Optional originating task to link the proposal to - a task identifier (e.g. "HM-1") or UUID',
				),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'create_hire_proposal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			const callerSlug = caller.rows[0]?.slug;
			if (callerSlug !== CAPTAIN_AGENT_SLUG && callerSlug !== CEO_AGENT_SLUG) {
				return { error: 'Only the Captain or CEO can create hire proposals' };
			}

			// The team is derived from scope: the Captain operates on its own team,
			// the CEO targets any team by passing `project`.
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const teamId = scope.teamId;

			let taskId: string | null = null;
			if (args.task_id !== undefined) {
				// Agents naturally hold the human-readable identifier (e.g. "HM-1"),
				// not the UUID — resolve either form before linking.
				const resolved = await resolveTaskId(db, teamId, args.task_id as string);
				// resolveTaskId trusts a well-formed UUID without a team check, so
				// re-verify the resolved task actually belongs to this team.
				const taskCheck = resolved
					? await db.query<{ id: string }>('SELECT id FROM tasks WHERE id = $1 AND team_id = $2', [
							resolved,
							teamId,
						])
					: null;
				if (!resolved || !taskCheck || taskCheck.rows.length === 0) {
					return { error: 'task_id not found on this team' };
				}
				taskId = resolved;
			}

			const prepared = await prepareHireProposal(db, teamId, args as unknown as HireProposalInput);
			if ('error' in prepared) return { error: prepared.error };

			const row = await insertHireApproval(db, teamId, prepared.payload, auth.memberId, taskId);
			broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			// Surface the proposal as a comment on the originating ticket so it shows in
			// the task thread (not just the admin inbox) and flips to hired/denied later.
			if (taskId) {
				await insertHireProposalComment(
					db,
					{
						taskId,
						approvalId: row.id as string,
						payload: prepared.payload as unknown as Record<string, unknown>,
						teamId,
						projectId: scope.projectId,
					},
					wsManager,
				);
			}
			return { approval_id: row.id, status: row.status, payload: row.payload };
		},
		db,
		{ write: true, audience: 'captain_or_ceo' },
	);

	const createProjectShape = {
		name: z.string().trim().min(1, 'name is required').describe('Project name'),
		description: z
			.string()
			.trim()
			.min(1, 'description is required')
			.describe('Project description'),
		task_prefix: z
			.string()
			.optional()
			.describe('Optional 2-4 char uppercase task prefix; derived from the name when omitted'),
		initial_project_plan: z
			.string()
			.optional()
			.describe('Optional project plan document (markdown), seeded as project-plan.md'),
		template_id: z
			.string()
			.optional()
			.describe(
				'Team-type template id (from list_team_templates). Mutually exclusive with source_team_id; defaults to Blank when neither is given.',
			),
		source_team_id: z
			.string()
			.optional()
			.describe(
				'Existing team to clone into a fresh template. Mutually exclusive with template_id.',
			),
		marketplace_slug: z
			.string()
			.optional()
			.describe(
				'A marketplace team slug (from get_marketplace_team / the intake baseline) to provision the roster from directly. Mutually exclusive with template_id and source_team_id.',
			),
		intake_task_id: z
			.string()
			.optional()
			.describe(
				'The HQ project-intake task this fulfils (its identifier, e.g. "HQ-1", or its UUID); it is closed with a completion note on success.',
			),
	} satisfies z.ZodRawShape;
	tool(
		server,
		'create_project',
		'Create a new project together with its dedicated team. CEO-only. Call this ONLY after the admin has explicitly approved the finalised scope AND team type in the intake conversation - a plain reply approving it is enough (there is no inbox button to wait on), but do not call it while still scoping, on assumed defaults, or in the same turn you propose the plan; creating a project stands up a full team + container, so wait for the go-ahead. Provisions the team from the chosen source (pass template_id from list_team_templates, source_team_id to clone an existing team, or marketplace_slug to provision a marketplace team; defaults to Blank), creates the project, its planning task, and the initial CEO coherence/setup task the planning task is blocked on, then provisions the container. The coherence/setup task is created unassigned and does NOT start automatically on this path: first author its description (update_task on the returned setup_task_identifier) to capture the concrete setup you agreed in intake - the exact roles to hire, any system-prompt rewrites, and the reporting structure - then call start_team_setup(project) to begin the run. When intake_task_id is given, the intake conversation is closed with a completion note. Returns the new project plus its planning and setup task identifiers.',
		createProjectShape,
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'create_project is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
				return { error: 'Only the CEO can create projects' };
			}

			// The SDK validated args against createProjectShape, so name/description
			// are already trimmed, non-empty strings (`.trim().min(1)`) and optionals
			// are `string | undefined` — no per-field ternaries or empty-checks here.
			const input = typedArgs(createProjectShape, args);
			const { name, description } = input;
			if (!containerDeps) {
				return { error: 'Project creation is not available in this context' };
			}

			// Idempotency: if this fulfils an intake ticket, that ticket must still be
			// open — otherwise a re-run (e.g. after a timeout) would create a second
			// project + team. Check before creating anything.
			const rawIntakeTaskId = input.intake_task_id?.trim() || undefined;
			let intakeTaskId: string | undefined;
			let intakeTeamId: string | undefined;
			if (rawIntakeTaskId) {
				// Accept either the intake ticket's identifier (e.g. "HQ-1") or its
				// UUID, like every other task reference on the MCP surface. Intake
				// tickets always live in HQ, so resolve within the default team.
				intakeTaskId = (await resolveTaskId(db, DEFAULT_TEAM_ID, rawIntakeTaskId)) ?? undefined;
				if (!intakeTaskId) return { error: 'Intake task not found' };
				const intake = await db.query<{ status: string; team_id: string }>(
					'SELECT status::text AS status, team_id FROM tasks WHERE id = $1',
					[intakeTaskId],
				);
				if (intake.rows.length === 0) return { error: 'Intake task not found' };
				if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(intake.rows[0].status)) {
					return { error: 'This intake has already been completed' };
				}
				intakeTeamId = intake.rows[0].team_id;
			}

			const result = await createProjectWithTeam(
				containerDeps,
				{
					name,
					description,
					templateId: input.template_id,
					sourceTeamId: input.source_team_id,
					marketplaceSlug: input.marketplace_slug,
					taskPrefix: input.task_prefix,
					initialProjectPlan: input.initial_project_plan ?? null,
					actorType: 'agent',
					actorMemberId: auth.memberId,
					// CEO-created: the coherence/setup ticket is created unassigned and
					// does NOT auto-run. The CEO drafts its description with the intake
					// plan, then calls start_team_setup to begin the run.
					suppressCoherenceAutoStart: true,
				},
				{ events },
			);
			if (!result.ok) return { error: result.message };

			const { project, planningTask, team, coherenceTask } = result;

			if (intakeTaskId) {
				const completed = await completeProjectIntakeAfterProvisioning(
					db,
					intakeTaskId,
					name,
					project.slug as string,
					wsManager,
				);
				if (wsManager && intakeTeamId) {
					const room = wsRoom.team(intakeTeamId);
					if (completed.summaryComment) {
						broadcastRowChange(
							wsManager,
							room,
							'task_comments',
							'INSERT',
							completed.summaryComment,
						);
					}
					if (completed.task) {
						broadcastRowChange(wsManager, room, 'tasks', 'UPDATE', completed.task);
					}
				}
			}

			return {
				...project,
				team_slug: team.slug,
				planning_task_id: planningTask.id,
				planning_task_identifier: planningTask.identifier,
				setup_task_id: coherenceTask?.id ?? null,
				setup_task_identifier: coherenceTask?.identifier ?? null,
			};
		},
		db,
		{ write: true, audience: 'ceo' },
	);

	tool(
		server,
		'start_team_setup',
		'Kick off the initial team-coherence/setup run for a project you created via create_project. ' +
			'CEO-only. Projects created directly from the admin form start their coherence pass automatically; ' +
			'projects you create do NOT. First author the coherence task with update_task - replace its ' +
			'description with the concrete plan you agreed in intake (the exact roles to hire and why, any ' +
			'system-prompt rewrites, and the reporting structure) - then call this to assign the task to ' +
			'yourself and start the run. Returns the started task; errors if there is no open setup task ' +
			'for the project or a run is already active on it.',
		{ project: projectArg() },
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'start_team_setup is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
				return { error: 'Only the CEO can start team setup' };
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const placeholders = TERMINAL_TASK_STATUSES.map((_, i) => `$${i + 2}::task_status`).join(
				', ',
			);
			const ticket = await db.query<{
				id: string;
				identifier: string;
				assignee_id: string | null;
			}>(
				`SELECT id, identifier, assignee_id FROM tasks
				 WHERE team_id = $1
				   AND labels @> '["team-coherence-review"]'::jsonb
				   AND status NOT IN (${placeholders})
				 LIMIT 1`,
				[scope.teamId, ...TERMINAL_TASK_STATUSES],
			);
			const row = ticket.rows[0];
			if (!row) return { error: 'No open team-setup task for this project' };

			// Run-concurrency, not a reassignment guard: this claims the ticket for
			// the caller, so the reassignment guard's caller/incoming exemptions would
			// both fire on the CEO and let a second run queue behind the first.
			if (await isTaskBusyInDb(db, row.id)) {
				return {
					error: `A run is already active on ${row.identifier}. Wait for it to finish, or cancel it from the task page, then call start_team_setup again.`,
				};
			}

			if (row.assignee_id !== auth.memberId) {
				const updated = await db.query<Record<string, unknown>>(
					`UPDATE tasks SET assignee_id = $1, updated_at = now() WHERE id = $2 RETURNING ${TASK_COLUMNS_BARE}`,
					[auth.memberId, row.id],
				);
				if (wsManager && updated.rows[0]) {
					broadcastRowChange(
						wsManager,
						wsRoom.team(scope.teamId),
						'tasks',
						'UPDATE',
						updated.rows[0],
					);
				}
			}

			await createWakeup(db, auth.memberId, scope.teamId, WakeupSource.Assignment, {
				task_id: row.id,
			});

			return { started: true, task_id: row.id, task_identifier: row.identifier };
		},
		db,
		{ write: true, audience: 'ceo' },
	);

	tool(
		server,
		'list_team_templates',
		`List local team templates: the built-in Blank template plus any custom templates saved from existing teams. The default specialist rosters (e.g. the app-dev "App Team") live in the marketplace, not here. Use when recommending a team structure to hire. Paged: returns \`limit\` entries (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{ ...listPagingArgs() },
		async (args, db) => {
			const r = await db.query<{
				id: string;
				name: string;
				description: string;
				is_builtin: boolean;
				agent_types: Array<{ slug: string; name: string; role_description: string }>;
			}>(
				`SELECT ct.id, ct.name, ct.description, ct.is_builtin,
				    COALESCE(
				        json_agg(json_build_object(
				            'slug', at.slug,
				            'name', at.name,
				            'role_description', at.role_description
				        ) ORDER BY ctat.sort_order) FILTER (WHERE at.id IS NOT NULL),
				        '[]'
				    ) AS agent_types
				 FROM team_templates ct
				 LEFT JOIN team_template_agent_types ctat ON ctat.team_template_id = ct.id
				 LEFT JOIN agent_types at ON at.id = ctat.agent_type_id
				 -- Built-in templates other than Blank now live in the marketplace and are
				 -- never surfaced here (parallels GET /api/team-templates); a legacy seeded
				 -- "Startup" row on a pre-marketplace instance is filtered out.
				 WHERE NOT (ct.is_builtin AND ct.name <> 'Blank')
				 GROUP BY ct.id
				 ORDER BY ct.is_builtin DESC, ct.name ASC`,
			);
			// Ordered by a composite (is_builtin, name) the keyset predicate cannot
			// express, and bounded by however many templates an operator has saved,
			// so the cursor anchors on row identity.
			const limit = parseListLimit(args.limit);
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? r.rows.findIndex((t) => t.id === cursor.id) + 1 : 0;
			return pagedList(
				r.rows.slice(from, from + limit + 1) as unknown as ListRow[],
				limit,
				'list_team_templates',
			);
		},
		db,
	);

	tool(
		server,
		'list_marketplace_teams',
		`Browse the team marketplace: every ready-made team available to this instance, with its name, description, summary, role count, and version. Callable by the CEO or a team Captain. Use it before staffing a team - the marketplace carries proven, fully-written roles, so check whether one already covers the role you need (then pull its prompt with get_marketplace_team) instead of authoring a system prompt from scratch. You can take a whole roster (apply_marketplace_team) or lift out a single role (apply_marketplace_agent). Paged: returns \`limit\` entries (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{ ...listPagingArgs() },
		async (args) => {
			const catalog = await getMarketplaceCatalog();
			// `keywords` is search vocabulary for the New Project picker - long, and
			// noise in an agent's context. Deliberately omitted.
			const teams = catalog.map((t) => ({
				slug: t.slug,
				name: t.name,
				description: t.description,
				summary: t.summary,
				version: t.version,
				roster_count: t.roster_count,
			}));
			// A marketplace team is identified by slug, not a row id.
			const limit = parseListLimit(args.limit);
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? teams.findIndex((t) => t.slug === cursor.id) + 1 : 0;
			return pagedList(teams.slice(from, from + limit + 1), limit, 'list_marketplace_teams', {
				column: 'name',
				idKey: 'slug',
			});
		},
		db,
	);

	tool(
		server,
		'get_marketplace_team',
		"Fetch one marketplace team's full definition: its version, changelog, and every role's title, reporting line, and CURRENT system prompt (including the Captain override). Callable by the CEO or a team Captain. Use it when adding/updating a team, to compare the marketplace's prompts to the agents you already have and decide what to refresh; and when hiring, to start a role from a proven marketplace prompt instead of writing one from scratch - find candidate teams with list_marketplace_teams first.",
		{
			slug: z.string().describe('The marketplace team slug (e.g. "app-dev").'),
		},
		async (args, _db) => {
			const slug = String(args.slug ?? '').trim();
			if (!slug) return { error: '`slug` is required' };
			const teamDef = await getMarketplaceTeam(slug);
			if (!teamDef) return { error: `Marketplace team "${slug}" not found` };
			return {
				slug: teamDef.slug,
				name: teamDef.name,
				version: teamDef.version,
				changelog: teamDef.changelog,
				captain: teamDef.captain,
				roster: teamDef.roster.map((r) => ({
					slug: r.slug,
					title: r.title,
					reports_to_slug: r.reports_to_slug,
					role_description: r.role_description,
					summary: r.summary,
					team_context: r.team_context,
					system_prompt: r.system_prompt,
				})),
			};
		},
		db,
	);

	tool(
		server,
		'apply_marketplace_team',
		"Add or update a marketplace team's roster on a project's team. CEO-only. Fetches the named marketplace team and provisions its members directly onto the project's existing team - a direct add, not an approval-gated hire proposal, so use it only for a team the admin already chose. Roles the team already has are SKIPPED by default; pass refresh_existing=true to instead refresh those roles' descriptions and system prompts to this team's current versions (use this when the project was created from an earlier version of THIS SAME team - it is a version update, not a duplicate add). refresh_existing overwrites prompts, so before using it on roles that may carry local customizations, read them (get_agent_system_prompt) and the new versions (get_marketplace_team) and refresh selectively with update_agent_system_prompt instead. After it returns, reconcile the merged roster. Returns the roles added, refreshed, and skipped.",
		{
			project: projectArg(),
			slug: z.string().describe('The marketplace team slug to add (e.g. "app-dev").'),
			refresh_existing: z
				.boolean()
				.optional()
				.describe(
					"When true, refresh roles the team already has to this team's current prompts/descriptions instead of skipping them. Default false. Use for a version update of the same team; prefer selective update_agent_system_prompt when roles carry customizations.",
				),
		},
		async (args, db, auth) => {
			// CEO-only: this is the tool the add-marketplace-team CEO task calls.
			if (auth.type === AuthType.Agent) {
				const caller = await db.query<{ slug: string }>(
					'SELECT slug FROM member_agents WHERE id = $1',
					[auth.memberId],
				);
				if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
					return { error: 'Only the CEO can add a marketplace team' };
				}
			}
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const slug = String(args.slug ?? '').trim();
			if (!slug) return { error: '`slug` is required' };
			const teamDef = await getMarketplaceTeam(slug);
			if (!teamDef) return { error: `Marketplace team "${slug}" not found` };

			const result = await applyMarketplaceTeamToTeam(db, scope.teamId, teamDef, {
				wsManager,
				enqueueReconcile: false,
				refreshExisting: args.refresh_existing === true,
			});
			return {
				added: result.created_slugs,
				refreshed: result.updated_slugs ?? [],
				skipped: result.skipped_slugs,
				captain_updated: result.builtin_updated_slugs.length > 0,
				version: teamDef.version,
			};
		},
		db,
		{ write: true, audience: 'ceo_if_agent' },
	);

	tool(
		server,
		'apply_marketplace_agent',
		"Add ONE role from a marketplace team to a project's team. CEO-only. Use this when the admin wants a single role (e.g. just the security engineer) rather than a whole roster - it provisions that one member directly, a direct add rather than an approval-gated hire proposal, and leaves the rest of the roster, including the Captain, untouched. The team already having that slug is a no-op (skipped). The role's prompt was written for its home team, so AFTER this returns you MUST fit it to this project: rewrite its system prompt and team context (update_agent_system_prompt, set_agent_team_context) so every teammate and hand-off they name is an agent that actually exists here, set a real manager with set_agent_reports_to, and update the existing agents whose work now flows through it. When the role's own manager is not on this team the reporting line is wired to the Captain as a placeholder and reports_to_fell_back comes back true - re-point it. Returns whether the role was added or skipped, plus the reporting line applied.",
		{
			project: projectArg(),
			slug: z.string().describe('The marketplace team slug the role comes from (e.g. "app-dev").'),
			role: z
				.string()
				.describe(
					'The roster role slug to add (e.g. "security-engineer"), as listed by get_marketplace_team. The Captain is not a roster role and cannot be added this way.',
				),
		},
		async (args, db, auth) => {
			// CEO-only: this is the tool the add-marketplace-agent CEO task calls.
			if (auth.type === AuthType.Agent) {
				const caller = await db.query<{ slug: string }>(
					'SELECT slug FROM member_agents WHERE id = $1',
					[auth.memberId],
				);
				if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
					return { error: 'Only the CEO can add a marketplace role' };
				}
			}
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const slug = String(args.slug ?? '').trim();
			if (!slug) return { error: '`slug` is required' };
			const roleSlug = String(args.role ?? '').trim();
			if (!roleSlug) return { error: '`role` is required' };

			const teamDef = await getMarketplaceTeam(slug);
			if (!teamDef) return { error: `Marketplace team "${slug}" not found` };

			const result = await applyMarketplaceRoleToTeam(db, scope.teamId, teamDef, roleSlug, {
				wsManager,
			});
			if ('error' in result) return result;
			return {
				role: roleSlug,
				added: result.added,
				skipped: result.skipped,
				reports_to: result.reports_to_slug,
				reports_to_fell_back: result.reports_to_fell_back,
				version: teamDef.version,
			};
		},
		db,
		{ write: true, audience: 'ceo_if_agent' },
	);

	// Projects
	tool(
		server,
		'list_projects',
		`List projects, by name. With CEO cross-team access (or as superuser) returns every project across the instance; a board user gets the projects on teams they belong to; an agent run gets its own project. description comes back as an excerpt capped at \`excerpt_chars\` (default ${DEFAULT_TASK_EXCERPT_CHARS}); read a project's full description with get_team or the project's own docs. Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					`Cap for the description excerpt, with description_truncated/_length companions (default ${DEFAULT_TASK_EXCERPT_CHARS}).`,
				),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const max = (args.excerpt_chars as number | undefined) ?? DEFAULT_TASK_EXCERPT_CHARS;
			const limit = parseListLimit(args.limit);
			const cursor = decodeCursor(args.cursor as string | undefined);
			const byName = { column: 'name', direction: 'asc', cast: 'text' } as const;
			const page = (rows: ListRow[]) =>
				pagedList(
					rows.map((row) => applyExcerpt(row, 'description', max) as ListRow),
					limit,
					'list_projects',
					{ column: 'name' },
				);
			const PROJECT_COLS = `p.id, p.team_id, p.name, p.slug, p.task_prefix, p.description,
			        p.is_internal, p.created_at, p.updated_at`;

			const instanceWide =
				(auth.type === AuthType.Agent && auth.crossTeam) ||
				(auth.type === AuthType.Admin && auth.isSuperuser) ||
				auth.type === AuthType.ApiKey;
			if (instanceWide) {
				const params: unknown[] = [];
				const keyset = keysetPredicate('p', cursor, params, byName);
				const r = await db.query<ListRow>(
					`SELECT ${PROJECT_COLS} FROM projects p
					 ${keyset ? `WHERE ${keyset}` : ''}
					 ORDER BY ${keysetOrderBy('p', byName)} LIMIT ${limit + 1}`,
					params,
				);
				return page(r.rows);
			}

			if (auth.type === AuthType.Admin) {
				const params: unknown[] = [auth.userId];
				const keyset = keysetPredicate('p', cursor, params, byName);
				const r = await db.query<ListRow>(
					`SELECT DISTINCT ${PROJECT_COLS} FROM projects p
					 JOIN members m ON m.team_id = p.team_id
					 JOIN member_users mu ON mu.id = m.id
					 WHERE mu.user_id = $1${keyset ? ` AND ${keyset}` : ''}
					 ORDER BY ${keysetOrderBy('p', byName)} LIMIT ${limit + 1}`,
					params,
				);
				return page(r.rows);
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const r = await db.query<ListRow>(`SELECT ${PROJECT_COLS} FROM projects p WHERE p.id = $1`, [
				scope.projectId,
			]);
			return page(r.rows);
		},
		db,
	);

	// Comments
	tool(
		server,
		'get_comment',
		'Read one comment in full by its id (the UUID from a list_comments row, or its public_id slug). list_comments returns long text comments as excerpts capped at `excerpt_chars`; this is the single-item read that serves the whole body, so reach for it whenever a row comes back with `text_truncated: true`. Very long comments come back one byte-window at a time: when `truncated` is true, call again with `offset` set to the returned `next_offset` and keep going until `next_offset` is null. Structured comments (system/option/task_link) are returned whole.',
		{
			project: projectArg(),
			comment_id: z
				.string()
				.describe(
					'Comment UUID or public_id (e.g. "20261009112345"). Both forms from a list_comments row work.',
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'Byte offset to start reading the comment text from (default 0). To page a comment too large for one read, pass back the `next_offset` from the previous call. Snapped down to a UTF-8 character boundary so a window never begins mid-character.',
				),
			max_bytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Max bytes of comment text to return in this window (default and ceiling is the read budget, so a normal-size comment comes back whole). Clamped to the budget; the returned slice ends on a UTF-8 character boundary, so it can come back a few bytes short.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const raw = args.comment_id as string;
			// Join through tasks and pin team + project, so a comment is only
			// readable from a project the caller already has access to - the same
			// boundary list_comments enforces, without making the caller pass the
			// task id it would have to look up first.
			const r = await db.query<Record<string, unknown>>(
				`SELECT ic.id, ic.public_id, ic.task_id, ic.author_member_id, ic.author_api_key_id,
				        ic.parent_comment_id,
				        ic.content_type, ic.content, ic.chosen_option, ic.created_at,
				        t.identifier AS task_identifier,
				        CASE WHEN ic.author_api_key_id IS NOT NULL THEN 'api_key' ELSE m.member_type::text END AS author_type,
				        COALESCE(ca.name, ma.title, m.display_name, 'Admin') AS author_name
				 FROM task_comments ic
				 JOIN tasks t ON t.id = ic.task_id
				 LEFT JOIN members m ON m.id = ic.author_member_id
				 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
				 LEFT JOIN api_keys ca ON ca.id = ic.author_api_key_id
				 WHERE (ic.id::text = $1 OR ic.public_id = $1)
				   AND t.team_id = $2 AND t.project_id = $3
				 LIMIT 1`,
				[raw, scope.teamId, scope.projectId],
			);
			if (r.rows.length === 0) return { error: `Comment not found: ${raw}` };
			const row = r.rows[0];
			const commentId = row.id as string;
			const viewerMemberId = await resolveReactorMemberId(db, auth, scope.teamId);
			const reactionsByComment = await loadReactionsForTask(
				db,
				row.task_id as string,
				viewerMemberId,
			);
			const attachmentsByComment = await loadAgentAttachmentsForComments(
				db,
				[commentId],
				masterKeyManager,
				agentOrigin(),
			);
			const base = {
				...row,
				reactions: reactionsByComment.get(commentId) ?? [],
				attachments: attachmentsByComment.get(commentId) ?? [],
			};
			await attachRunStatuses(db, row.task_id as string, [base]);
			const content = row.content as { text?: string } | null;
			const text = content?.text;
			if (row.content_type !== CommentContentType.Text || typeof text !== 'string') {
				return base;
			}
			// Window the body for the same reason read_project_doc does: a comment
			// has no length ceiling, and returning it whole would trip the generic
			// result_too_large guard with no way to reach the rest.
			return windowContent({
				text,
				offset: args.offset as number | undefined,
				maxBytes: args.max_bytes as number | undefined,
				limit: MCP_RESULT_BYTE_LIMIT,
				reserve: DOC_READ_ENVELOPE_RESERVE,
				hint: ({ start, end, total }) =>
					`Comment is larger than one read. Returned bytes ${start}-${end} of ${total}. Call get_comment again with offset: ${end}; repeat until next_offset is null.`,
				// `w` is spread BEFORE `content` on purpose: ContentWindow carries its
				// own `content` string, but a comment's `content` is an object whose
				// `text` holds the body, so the window's copy has to lose. The window's
				// offset/next_offset/truncated/paging_hint fields still come through.
				build: (w: ContentWindow) => ({
					...base,
					...w,
					content: { ...content, text: w.content },
				}),
			});
		},
		db,
	);

	tool(
		server,
		'list_comments',
		`List comments for a task, newest first. Returns the conversation and the task's own changes by default and leaves out the one-row-per-execution agent run markers - pass \`categories\` to change that, and prefer \`list_task_runs\`, which reports each run's status, exit code and log length rather than a bare marker. To catch up rather than re-read, pass \`since\` with the timestamp your last read ended at; a run prompt gives you the time of your previous run on the task. Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false. (\`before\`, taking a comment id or public_id, still works for walking back from a known comment.) Long text comments come back truncated at \`excerpt_chars\` (default ${DEFAULT_COMMENT_EXCERPT_CHARS}, narrowed to whatever a page of \`limit\` rows can carry and reported as \`excerpt_chars_applied\`); structured comments (system/option/task_link) are always returned whole. A truncated row sets \`text_truncated: true\` alongside \`text_length\` and a \`text_paging_hint\` naming the exact follow-up call - the excerpt sits in \`content.text\`, the same field a whole comment uses, so check \`text_truncated\` before treating what you got as the entire comment. Read the full body with \`get_comment\`; raising \`excerpt_chars\` is not the intended recovery path. Each row includes parent_comment_id (UUID or null) so you can see reply threading - when you reply substantively to a comment, pass that comment's id back as parent_comment_id in create_comment. Each row also has a public_id (a creation-timestamp slug like 20261009112345); that's how you cite a specific comment elsewhere: write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345), which renders as a clickable link straight to that comment. A \`run\` row also carries \`run_status\` - how that run actually ended - because the row itself is written when the run starts and the failure notices beside it are not written for every failure.`,
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			before: z
				.string()
				.optional()
				.describe(
					'A comment id (UUID) or public_id - return only comments created before that one. Prefer `cursor` for straight paging; this is for resuming from a comment you already know.',
				),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.max(MAX_COMMENT_EXCERPT_CHARS)
				.optional()
				.describe(
					`Cap for content.text on text-typed comments, with text_truncated/text_length companions (default ${DEFAULT_COMMENT_EXCERPT_CHARS}, ceiling ${MAX_COMMENT_EXCERPT_CHARS}). Narrowed further when a page of \`limit\` rows could not otherwise fit; the value used comes back as \`excerpt_chars_applied\`.`,
				),
			categories: z
				.array(z.enum(THREAD_ROW_CATEGORIES))
				.nonempty()
				.optional()
				.describe(
					`Which kinds of row to return. \`conversation\` is what people and agents wrote plus anything awaiting a person (credential requests, approvals); \`events\` is the task's own machinery - status, assignee, title and parent changes, task links and run-failure notices; \`runs\` is one marker per agent execution. Defaults to ["conversation","events"], because run markers are the bulk of a long thread and say nothing the thread does not.`,
				),
			since: z
				.string()
				.optional()
				.describe(
					'ISO-8601 timestamp. Return only comments created strictly after it, newest first. Use this to read what is new instead of walking a thread you have already read.',
				),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const sinceArg = args.since as string | undefined;
			if (sinceArg !== undefined && !isValidSince(sinceArg)) {
				return {
					error: `Invalid since: ${sinceArg}. Pass an ISO-8601 timestamp, e.g. "2026-08-17T04:00:00.000Z".`,
				};
			}
			const limit = parseListLimit(args.limit);
			const categories =
				(args.categories as ThreadRowCategory[] | undefined) ?? DEFAULT_THREAD_ROW_CATEGORIES;
			const conditions = ['ic.task_id = $1'];
			const params: unknown[] = [taskId];
			if (args.before) {
				params.push(args.before);
				conditions.push(
					`(ic.created_at, ic.id) < (SELECT created_at, id FROM task_comments WHERE (id::text = $${params.length} OR public_id = $${params.length}) AND task_id = $1 LIMIT 1)`,
				);
			}
			const category = commentCategoryPredicate('ic', categories, params);
			if (category) conditions.push(category);
			const since = commentSincePredicate('ic', sinceArg, params);
			if (since) conditions.push(since);
			const keyset = keysetPredicate('ic', decodeCursor(args.cursor as string | undefined), params);
			if (keyset) conditions.push(keyset);
			const r = await db.query<Record<string, unknown>>(
				`SELECT ic.id, ic.public_id, ic.task_id, ic.author_member_id, ic.author_api_key_id,
				        ic.parent_comment_id,
				        ic.content_type, ic.content, ic.chosen_option, ic.created_at,
				        CASE WHEN ic.author_api_key_id IS NOT NULL THEN 'api_key' ELSE m.member_type::text END AS author_type,
				        COALESCE(ca.name, ma.title, m.display_name, 'Admin') AS author_name
				 FROM task_comments ic
				 LEFT JOIN members m ON m.id = ic.author_member_id
				 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
				 LEFT JOIN api_keys ca ON ca.id = ic.author_api_key_id
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY ${keysetOrderBy('ic')} LIMIT ${limit + 1}`,
				params,
			);
			const viewerMemberId = await resolveReactorMemberId(db, auth, teamId);
			const reactionsByComment = await loadReactionsForTask(db, taskId, viewerMemberId);
			const commentIds = r.rows.map((row) => row.id as string);
			const attachmentsByComment = await loadAgentAttachmentsForComments(
				db,
				commentIds,
				masterKeyManager,
				agentOrigin(),
			);
			const enriched: Record<string, unknown>[] = r.rows.map((row) => ({
				...row,
				reactions: reactionsByComment.get(row.id as string) ?? [],
				attachments: attachmentsByComment.get(row.id as string) ?? [],
			}));
			await attachRunStatuses(db, taskId, enriched);
			const requested = args.excerpt_chars as number | undefined;
			const buildPage = (max: number) => {
				const rows = enriched.map((row) => {
					if (row.content_type !== CommentContentType.Text) return row;
					const content = row.content as { text?: string } | null;
					const text = content?.text;
					if (typeof text !== 'string' || text.length <= max) return row;
					const ex = excerpt(text, max);
					// The excerpt is written back into `content.text`, the same key that
					// carries a full body, so nothing about the string itself says it is
					// partial. Name the recovery call on the row - a sibling boolean is
					// easy to miss, and a reader who misses it treats the excerpt as the
					// whole comment.
					return {
						...row,
						content: { ...content, text: ex.excerpt },
						text_truncated: ex.truncated,
						text_length: ex.length,
						text_paging_hint: `Showing the first ${ex.excerpt?.length ?? 0} of ${ex.length} characters. Call get_comment(comment_id: "${row.id}") for the full body.`,
					};
				});
				return {
					...pagedList(rows as ListRow[], limit, 'list_comments'),
					categories_applied: categories,
					excerpt_chars_applied: max,
				};
			};
			// Structured bodies and attachment URLs are returned whole, so sizing the
			// excerpt off the page size cannot promise a fit on its own. Narrow until
			// the page fits rather than letting it be rejected and walked again.
			let max = effectiveCommentExcerptChars(requested, limit);
			const floor = Math.min(MIN_COMMENT_EXCERPT_CHARS, max);
			let page = buildPage(max);
			while (
				max > floor &&
				Buffer.byteLength(JSON.stringify(page, null, 2), 'utf8') > MCP_RESULT_BYTE_LIMIT
			) {
				max = Math.max(floor, Math.floor(max / 2));
				page = buildPage(max);
			}
			return page;
		},
		db,
	);

	tool(
		server,
		'list_task_runs',
		`List the agent runs (container executions) recorded for a task, newest first. Each row is one run: which agent ran, its status and exit code, when it started/finished, the invocation command, and the log length. Metadata only - fetch a run's actual container log with get_run_log(run_id). Useful for reviewing HOW a task was worked (e.g. the Coach checking what an agent actually did, beyond the comments it left). Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const limit = parseListLimit(args.limit);
			const params: unknown[] = [taskId, teamId];
			const runKeyset = { column: 'started_at' } as const;
			const keyset = keysetPredicate(
				'hr',
				decodeCursor(args.cursor as string | undefined),
				params,
				runKeyset,
			);
			const r = await db.query<ListRow>(
				`SELECT hr.id, hr.status, hr.exit_code, hr.started_at, hr.finished_at,
				        hr.invocation_command, ${runLogLengthSql('hr.id')} AS log_length,
				        ma.title AS agent_title, ma.slug AS agent_slug
				 FROM heartbeat_runs hr
				 LEFT JOIN member_agents ma ON ma.id = hr.member_id
				 WHERE hr.task_id = $1 AND hr.team_id = $2${keyset ? ` AND ${keyset}` : ''}
				 ORDER BY ${keysetOrderBy('hr', runKeyset)}
				 LIMIT ${limit + 1}`,
				params,
			);
			return pagedList(r.rows, limit, 'list_task_runs', { column: 'started_at' });
		},
		db,
	);

	tool(
		server,
		'get_run_log',
		"Fetch the container log for a single agent run (a run_id from list_task_runs). Team-scoped: the run must belong to the project you're acting in. By default returns the most recent excerpt_chars characters (default 12000 - the tail, where the outcome and any errors usually are). To read a run that failed EARLY, pass offset (start at 0) and page forward with next_offset until it is null: the tail default would otherwise hide the start of the log, which is where a setup, clone, or install failure appears.",
		{
			project: projectArg(),
			run_id: z.string().describe('Run ID (UUID) from list_task_runs'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Max characters to return from the END of the log (default 12000). Ignored when `offset` is set.',
				),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					'Byte offset to read forward from, instead of the tail. Pass 0 to start at the beginning of the log, then pass back `next_offset` until it is null. Snapped down to a UTF-8 character boundary.',
				),
			max_bytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Max bytes of log to return in this window when paging with `offset` (default and ceiling is the read budget).',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const runId = args.run_id as string;
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
				return { error: `Invalid run_id: ${runId}` };
			}
			const r = await db.query<{
				id: string;
				status: string;
				exit_code: number | null;
				task_id: string | null;
			}>(
				`SELECT id, status, exit_code, task_id
				 FROM heartbeat_runs WHERE id = $1 AND team_id = $2`,
				[runId, scope.teamId],
			);
			if (r.rows.length === 0) return { error: `Run not found in this project: ${runId}` };
			const run = r.rows[0];
			const meta = {
				id: run.id,
				status: run.status,
				exit_code: run.exit_code,
				task_id: run.task_id,
			};
			// Either read is a window over storage rather than an aggregate of the
			// whole log: a run's log reaches 10 MB and either mode returns ~12 KB.
			// Both paths then shrink the loaded slice until the serialized result
			// fits the admission cap - a log full of escaped JSON inflates several-
			// fold when serialized, and without the shrink even this tool's default
			// parameters can produce only `result_too_large`, with no spelling that
			// ever succeeds.
			const offset = args.offset as number | undefined;
			if (offset !== undefined) {
				const max = (args.max_bytes as number | undefined) ?? 12_000;
				const w = await readRunLogWindow(db, run.id, offset, max);
				return fitSerializedWindow({
					text: w.text,
					keep: 'start',
					limit: MCP_RESULT_BYTE_LIMIT,
					build: (kept) => {
						const nextOffset = w.offset + kept.length < w.length ? w.offset + kept.length : null;
						return {
							...meta,
							log: kept,
							offset: w.offset,
							returned_chars: kept.length,
							length: w.length,
							next_offset: nextOffset,
							truncated: w.offset > 0 || nextOffset !== null,
							...(nextOffset !== null
								? {
										paging_hint: `Log is larger than one read. Returned characters ${w.offset}-${w.offset + kept.length} of ${w.length}. Call get_run_log again with offset: ${nextOffset}; repeat until next_offset is null.`,
									}
								: {}),
						};
					},
				});
			}
			const max = (args.excerpt_chars as number | undefined) ?? 12_000;
			const tail = await readRunLogTail(db, run.id, max);
			return fitSerializedWindow({
				text: tail.text,
				keep: 'end',
				limit: MCP_RESULT_BYTE_LIMIT,
				build: (kept) => {
					const truncated = tail.truncated || kept.length < tail.text.length;
					return {
						...meta,
						log: kept,
						length: tail.length,
						truncated,
						...(truncated
							? {
									paging_hint: `This is the last ${kept.length} of ${tail.length} characters. Earlier output was NOT returned - if the run failed early, call get_run_log again with offset: 0 and page forward with next_offset to reach the start.`,
								}
							: {}),
					};
				},
			});
		},
		db,
	);

	const reactionKindSchema = z.enum(Object.values(ReactionKind) as [string, ...string[]]);

	tool(
		server,
		'add_reaction',
		'React to a comment without waking its author. Use this to acknowledge mentions or signal "seen / picked up" without forcing the original commenter to run again. Prefer this over a follow-up create_comment when you have nothing substantive to add - comments wake the author, reactions do not. Only react when the situation calls for it: a clean handoff to your own new task (✓ on the mention), or a brief acknowledgement that a request landed. If you need the original commenter to read something, post a comment instead.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe(
					'UUID of the comment to react to, as returned by list_comments. Sentinels like "last" / "latest" are not supported - you must pass an explicit UUID.',
				),
			kind: reactionKindSchema.describe(
				`Reaction kind. v1 supports: ${Object.values(ReactionKind).join(', ')}`,
			),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const memberId = await resolveReactorMemberId(db, auth, teamId);
			if (!memberId) return { error: 'No member identity for caller' };
			const result = await addCommentReaction({
				db,
				teamId,
				taskId,
				commentId: args.comment_id as string,
				kind: args.kind as string,
				memberId,
			});
			if (!result.ok) return { error: result.message };
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'comment_reactions',
				'INSERT',
				{
					comment_id: args.comment_id,
					task_id: taskId,
					member_id: memberId,
					kind: args.kind,
				},
			);
			return {
				comment_id: args.comment_id,
				kind: args.kind,
				reactions: result.reactions,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'remove_reaction',
		'Remove your own reaction from a comment. Removing a reaction does not wake the comment author.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe(
					'UUID of the comment to remove the reaction from, as returned by list_comments. Sentinels like "last" / "latest" are not supported - you must pass an explicit UUID.',
				),
			kind: reactionKindSchema.describe(
				`Reaction kind. v1 supports: ${Object.values(ReactionKind).join(', ')}`,
			),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			const memberId = await resolveReactorMemberId(db, auth, teamId);
			if (!memberId) return { error: 'No member identity for caller' };
			const result = await removeCommentReaction({
				db,
				teamId,
				taskId,
				commentId: args.comment_id as string,
				kind: args.kind as string,
				memberId,
			});
			if (!result.ok) return { error: result.message };
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'comment_reactions',
				'DELETE',
				{
					comment_id: args.comment_id,
					task_id: taskId,
					member_id: memberId,
					kind: args.kind,
				},
			);
			return {
				comment_id: args.comment_id,
				kind: args.kind,
				reactions: result.reactions,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'create_comment',
		'Add a comment to a task. In content, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert. To point at a specific earlier comment (in this task or another), write a comment link as <TASK-ID>#comment-<public_id> (e.g. IN-42#comment-20261009112345) using a comment public_id from list_comments - do not paraphrase "the comment above". When your comment is a direct response to a specific earlier one (answering a question, confirming/pushing back on a request, providing the follow-up that was asked for) ALWAYS set parent_comment_id to that comment\'s UUID - it wakes the original author with source=reply (so they\'re notified the conversation moved forward) and shows "replying to ..." threading in the UI so other readers can follow the dialogue. Skip parent_comment_id only when the comment is genuinely standalone (a new observation, an unrelated update). If you only need to acknowledge a mention without adding substance, use add_reaction instead.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID'),
			content: z.string().describe('Comment text'),
			parent_comment_id: z
				.string()
				.optional()
				.describe(
					'The comment you are replying to - its id (UUID) or its public_id. Setting this wakes that comment\'s author with source=reply and renders this comment as "replying to ..." in the UI.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			let parentCommentId: string | null = null;
			if (args.parent_comment_id) {
				// Accept the parent's id (UUID) or its public_id; store the resolved
				// UUID as the reply FK. `id::text = $1` avoids the uuid-cast error a
				// raw `id = $1` throws when a public_id is passed.
				const parentCheck = await db.query<{ id: string }>(
					'SELECT id FROM task_comments WHERE (id::text = $1 OR public_id = $1) AND task_id = $2 LIMIT 1',
					[args.parent_comment_id, taskId],
				);
				if (parentCheck.rows.length === 0) {
					return { error: 'parent_comment_id does not belong to this task' };
				}
				parentCommentId = parentCheck.rows[0].id;
			}
			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const authorApiKeyId = apiKeyIdFromAuth(auth);
			// Attribute the comment to the run that wrote it (only on the agent-run path) so the
			// goal detail page can show "this progress-update run commented on task X".
			const createdByRunId = auth.type === AuthType.Agent ? (auth.runId ?? null) : null;
			// Insert + realtime broadcast + mention/@admin/reply wakeups, shared with
			// the runner's handoff-delivery guardrail via postAgentComment so a
			// comment the agent posts and one auto-delivered from a stranded final
			// message are byte-identical. RETURNING * includes public_id (the
			// comment-link slug), so the agent gets it back without a list_comments.
			const { row, woke } = await postAgentComment({
				db,
				wsManager,
				teamId,
				projectId: scope.projectId,
				taskId,
				authorMemberId,
				authorApiKeyId,
				authorUserId: auth.type === AuthType.Admin ? auth.userId : null,
				createdByRunId,
				parentCommentId,
				text: args.content as string,
			});
			trackBackground(
				recordTaskLinks(
					db,
					teamId,
					taskId,
					args.content as string,
					authorMemberId,
					authorApiKeyId,
					wsManager,
					{ kind: 'comment', commentPublicId: row.public_id },
				).catch((e) => log.error('Failed to record task links from comment:', e)),
			);
			// An agent that addresses a teammate by bold/bare name (no @ prefix)
			// notifies no one and the handoff silently stalls. Best-effort warn the
			// author so they can re-post with the proper mention; never block the
			// already-persisted comment on this check.
			if (authorMemberId) {
				const commentText = args.content as string;
				// One roster read per write, shared by the receipt and all three mention
				// advisories. They each used to resolve it themselves, so a single
				// create_comment ran the identical query three times (four once the
				// receipt was added) - see "Budget the DB round trips a request costs".
				const knownSlugs = await resolveWarnableSlugs(db, teamId, authorMemberId);
				const [
					teammateWarning,
					passiveWarning,
					narratedWarning,
					backtickWarning,
					terminalAskWarning,
				] = await Promise.all([
					buildUnlinkedMentionWarning(knownSlugs, commentText).catch((e) => {
						log.error('Failed to check comment for unlinked teammate references:', e);
						return null;
					}),
					buildPassiveMentionWarning(knownSlugs, commentText).catch((e) => {
						log.error('Failed to check comment for passive teammate asks:', e);
						return null;
					}),
					buildNarratedMentionWarning(knownSlugs, commentText).catch((e) => {
						log.error('Failed to check comment for narrated active mentions:', e);
						return null;
					}),
					buildBacktickedEntityWarning(db, teamId, scope.projectId, commentText).catch((e) => {
						log.error('Failed to check comment for backticked entity references:', e);
						return null;
					}),
					buildTerminalTaskAskWarning(db, taskId, commentText).catch((e) => {
						log.error('Failed to check comment for asks on a terminal task:', e);
						return null;
					}),
				]);
				const warning = [
					teammateWarning,
					passiveWarning,
					narratedWarning,
					backtickWarning,
					terminalAskWarning,
				]
					.filter((w): w is string => Boolean(w))
					.join(' ');
				// The receipt ships on every write, warning or not: it is a fact about what
				// the comment delivered, not an advisory that fires when a heuristic guessed
				// right. An agent that meant to ask sees `woke: []` with the teammate it
				// addressed sitting in `named_not_woken`.
				const wake = buildWakeReceipt(commentText, woke, knownSlugs);
				if (warning) return { ...row, wake, warning };
				return { ...row, wake };
			}
			return row;
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'update_comment',
		'Edit the text of a comment you posted earlier in THIS run - use it to fix a mistake (a typo, a broken reference, wrong markdown) instead of posting a correction as a new comment. You can only edit a text comment authored by your current run; comments from earlier runs, other agents, or humans are not editable. Editing re-runs the same notification side effects create_comment does, but idempotently: a teammate already notified by this comment is not woken again, while a mention you ADD in the edit (e.g. a bare @<agent-slug> that replaces a backticked, inert one) wakes that teammate for the first time - so fixing a missed mention by editing works. Same reference rules as create_comment: reference tasks and project docs by their bare identifier/filename, teammates with @<agent-slug>, skills by their slug, and never wrap any of these in backticks.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe('UUID of the comment to edit, as returned by create_comment or list_comments.'),
			content: z.string().describe('The replacement comment text (overwrites the existing body).'),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'Only an agent run can edit a comment' };
			}
			const existing = await db.query<{
				content_type: string;
				author_member_id: string | null;
				created_by_run_id: string | null;
				parent_comment_id: string | null;
			}>(
				`SELECT content_type, author_member_id, created_by_run_id, parent_comment_id
				 FROM task_comments WHERE id = $1 AND task_id = $2`,
				[args.comment_id, taskId],
			);
			if (existing.rows.length === 0) {
				return { error: 'Comment not found on this task' };
			}
			const row = existing.rows[0];
			// Scoped to the caller's own comments from the current run: an agent can
			// tidy up what it just posted, but never rewrite history it did not author.
			if (row.created_by_run_id !== auth.runId || row.author_member_id !== auth.memberId) {
				return { error: 'You can only edit a comment you posted during this run' };
			}
			if (row.content_type !== CommentContentType.Text) {
				return { error: 'Only text comments can be edited' };
			}
			const content = { text: args.content };
			const r = await db.query<{ id: string; public_id: string }>(
				`UPDATE task_comments SET content = $1::jsonb WHERE id = $2 RETURNING *`,
				[JSON.stringify(content), args.comment_id],
			);
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'task_comments',
				'UPDATE',
				r.rows[0],
			);
			// Re-run the create-time side effects against the new text. Every one is
			// keyed to the comment (or the mention/reply pair), so a target already
			// woken by this comment is deduped while a reference the edit *adds* —
			// a mention or a task link that was previously backticked and inert —
			// fires for the first time. That is what makes "fix it by editing"
			// behave the same as posting it correctly the first time.
			const woke = await fireCommentWakeups({
				db,
				taskId,
				teamId,
				commentId: args.comment_id as string,
				content,
				contentType: CommentContentType.Text,
				authorMemberId: auth.memberId,
				authorRunId: auth.runId,
				parentCommentId: row.parent_comment_id,
				wsManager,
			}).catch((e) => {
				log.error('Failed to fire wakeups for edited comment:', e);
				return [] as string[];
			});
			trackBackground(
				recordTaskLinks(
					db,
					teamId,
					taskId,
					args.content as string,
					auth.memberId,
					apiKeyIdFromAuth(auth),
					wsManager,
					{ kind: 'comment', commentPublicId: r.rows[0].public_id },
				).catch((e) => log.error('Failed to record task links from edited comment:', e)),
			);
			// One roster read, shared by the receipt and the three mention advisories.
			const knownSlugs = await resolveWarnableSlugs(db, teamId, auth.memberId);
			const wake = buildWakeReceipt(args.content as string, woke, knownSlugs);
			const [teammateWarning, passiveWarning, narratedWarning, backtickWarning] = await Promise.all(
				[
					buildUnlinkedMentionWarning(knownSlugs, args.content as string).catch((e) => {
						log.error('Failed to check edited comment for unlinked teammate references:', e);
						return null;
					}),
					buildPassiveMentionWarning(knownSlugs, args.content as string).catch((e) => {
						log.error('Failed to check edited comment for passive teammate asks:', e);
						return null;
					}),
					buildNarratedMentionWarning(knownSlugs, args.content as string).catch((e) => {
						log.error('Failed to check edited comment for narrated active mentions:', e);
						return null;
					}),
					buildBacktickedEntityWarning(db, teamId, scope.projectId, args.content as string).catch(
						(e) => {
							log.error('Failed to check edited comment for backticked entity references:', e);
							return null;
						},
					),
				],
			);
			const warning = [teammateWarning, passiveWarning, narratedWarning, backtickWarning]
				.filter((w): w is string => Boolean(w))
				.join(' ');
			if (warning) return { ...r.rows[0], wake, warning };
			return { ...r.rows[0], wake };
		},
		db,
		{ write: true, audience: 'agent_run' },
	);

	const credentialKindSchema = z.enum([
		CredentialKind.ApiKey,
		CredentialKind.SshPrivateKey,
		CredentialKind.GithubPat,
		CredentialKind.OauthToken,
		CredentialKind.WebhookSecret,
		CredentialKind.Other,
	]);
	const credentialInputTypeSchema = z.enum([
		CredentialInputType.Text,
		CredentialInputType.Textarea,
		CredentialInputType.File,
	]);

	tool(
		server,
		'request_credential',
		'Ask the human assignee to provide a secret value (API key, SSH private key, OAuth token, etc.). Posts a structured comment on the task with a paste form. The agent never sees the value; it gets a placeholder string to embed in env vars or HTTP headers, which the egress proxy later substitutes. Returns immediately with the placeholder; the agent should stop work on whatever needed the credential and wait for a credential_provided wakeup. For HTTP-auth kinds (api_key, oauth_token, github_pat) allowed_hosts is REQUIRED - scope it to the provider API host(s) so the secret can only ever reach those hosts. Always ask for the narrowest scope and shortest expiry the provider offers. If a registered connector capability already covers the provider (e.g. a remote MCP server with OAuth), prefer register_connector over a raw paste.',
		{
			project: projectArg(),
			task_id: z.string().describe('Task identifier or UUID - the request comment is posted here'),
			name: z
				.string()
				.describe(
					'Secret name. Must match [A-Z][A-Z0-9_]{0,63} (e.g. GITHUB_PAT, ANTHROPIC_API_KEY). The placeholder returned will be __HEZO_SECRET_<name>__.',
				),
			kind: credentialKindSchema.describe(
				'Type of credential - drives validation when the human submits the value',
			),
			instructions: z
				.string()
				.describe(
					'Human-facing prose explaining why you need this credential and how the human can obtain it. Tell the human to set the minimal scope and the shortest expiry the provider supports (e.g. "I need a GitHub PAT with only `repo` scope to push branches, ideally expiring in 7 days. Create one at https://github.com/settings/tokens"). Make the link the page where a human CREATES the credential (the provider\'s settings/dashboard URL) - the API host belongs in allowed_hosts, not as the link the human is expected to click.',
				),
			input_type: credentialInputTypeSchema
				.optional()
				.describe('Form input type. Defaults: text for short keys, textarea for SSH/multiline.'),
			confirmation_text: z
				.string()
				.optional()
				.describe(
					'Optional yes/no confirmation prompt instead of a paste form (e.g. "Have you added the public key to github.com/owner/repo/settings/keys?"). When set, input_type is ignored.',
				),
			allowed_hosts: z
				.array(z.string())
				.optional()
				.describe(
					'Hostname allowlist for the egress proxy. The credential is only substituted into outbound requests to these hosts. REQUIRED for HTTP-auth kinds (api_key, oauth_token, github_pat) - e.g. ["api.netlify.com"]. Wildcards: *.github.com matches one label segment.',
				),
			allow_body_substitution: z
				.boolean()
				.optional()
				.describe(
					'Request that this credential may be substituted into a small JSON request body, not just headers/URL - for APIs that take the secret in the body, e.g. a login POST that returns a token. The human sees this as a pre-checked box on the paste form and can decline it. Body substitution is gated to a single application/json request under 8KB with a fixed Content-Length; after a login, read the returned token and use it via the Authorization header on later calls.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;

			const name = args.name as string;
			const validation = validateSecretName(name);
			if (!validation.valid) return { error: validation.error };

			// HTTP-auth credentials must be host-scoped: an unscoped api_key/oauth_token/
			// github_pat can never be substituted (egress blocks host-unscoped secrets) or,
			// if later flipped to allow-all, leaks into every host the agent calls. Reject
			// early so the agent re-requests with allowed_hosts. Confirmation-style requests
			// store no value, so hosts don't apply.
			const isConfirmation = !!args.confirmation_text;
			const requestedHosts = (args.allowed_hosts as string[] | undefined) ?? [];
			if (
				!isConfirmation &&
				credentialKindRequiresAllowedHosts(args.kind as string) &&
				requestedHosts.length === 0
			) {
				return {
					error:
						`${args.kind} credentials must declare allowed_hosts - the API host(s) ` +
						`this secret is sent to (e.g. ["api.netlify.com"]). This scopes the egress ` +
						`proxy so the value is only injected into those hosts and never leaks ` +
						`elsewhere. Re-call request_credential with allowed_hosts set.`,
				};
			}

			const placeholder = credentialPlaceholder(name);

			/**
			 * Put the request in the admin's inbox. Nothing here carries `@admin`
			 * text, so it rides the same seam asset-deletion requests do: an
			 * `admin_mentions` row per admin, which is what makes the ask visible
			 * (and dismissable) outside the task thread it was posted in.
			 */
			const raiseCredentialRequestInInbox = async (commentId: string): Promise<void> => {
				await fireAdminMention({
					db,
					teamId,
					taskId,
					commentId,
					// The author is the requesting agent, never a human - so no
					// recipient is excluded as "you asked for this yourself".
					authorUserId: null,
					wsManager,
				}).catch((e) => log.error('Failed to raise credential request in the admin inbox:', e));
			};

			const existing = await db.query<{ id: string; content: Record<string, unknown> }>(
				`SELECT id, content FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'credential_request'::comment_content_type
				   AND chosen_option IS NULL
				   AND content->>'name' = $2
				 ORDER BY created_at ASC LIMIT 1`,
				[taskId, name],
			);
			if (existing.rows.length > 0) {
				// Re-raise for any admin who has no row yet (one added to the team
				// after the ask). `ON CONFLICT DO NOTHING` leaves a row someone has
				// already read alone, so re-asking never nags.
				await raiseCredentialRequestInInbox(existing.rows[0].id);
				return {
					placeholder,
					comment_id: existing.rows[0].id,
					status: 'pending',
					reused: true,
				};
			}

			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const content = {
				name,
				kind: args.kind,
				instructions: args.instructions,
				input_type: args.confirmation_text
					? null
					: ((args.input_type as string | undefined) ?? CredentialInputType.Text),
				confirmation_text: args.confirmation_text ?? null,
				allowed_hosts: requestedHosts,
				allow_body_substitution: !!args.allow_body_substitution,
				placeholder,
			};

			const inserted = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)
				 RETURNING *`,
				[taskId, authorMemberId, JSON.stringify(content)],
			);
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				scope.projectId,
				'task_comments',
				'INSERT',
				inserted.rows[0],
			);
			await raiseCredentialRequestInInbox(inserted.rows[0].id);

			events?.emit({
				type: 'credential.requested',
				teamId,
				projectId: null,
				actorType: AuditActorType.Agent,
				actorMemberId: authorMemberId,
				taskId,
				name,
			});

			return {
				placeholder,
				comment_id: inserted.rows[0].id,
				status: 'pending',
				reused: false,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'register_connector',
		'Register a third-party connector for the team and ask the human to authenticate. Posts a connect_required comment on the task with a Connect button; the human completes it inline (in the task comment or on the Connectors page). The agent never sees the token; subsequent runs receive the connector via the egress proxy + placeholder substitution. Idempotent: re-registering an already-active connector returns its current state and fires the wakeup immediately.\n\nTwo kinds:\n- kind "saas" (default): a hosted MCP server. Give mcp_url. Auth is chosen by what the provider supports: servers that advertise OAuth Dynamic Client Registration (most MCP servers) authorize with zero config; providers whose Authorization Server cannot do DCR (e.g. GitHub) require a pre-registered client_id and the device flow - register those with provider_id set to a known registry key (e.g. "github").\n- kind "api": a credentialed REST API the agent calls directly (no MCP server). Give base_url + allowed_hosts (+ optional auth placement). For an OAuth-backed API, also set oauth_provider_id to a bundled OAuth-broker provider (e.g. "google-youtube"): the human then completes the OAuth device flow by pasting just a client id, with the provider pre-selected and locked. For a plain static-key API, omit oauth_provider_id and the human attaches an API key.',
		{
			project: projectArg(),
			task_id: z
				.string()
				.describe('Task identifier or UUID where the connect_required comment is posted'),
			display_name: z
				.string()
				.describe(
					'Human-readable connector name shown in the task chat and on the Connectors page (e.g. "DatoCMS", "Linear").',
				),
			kind: z
				.enum(['saas', 'api'])
				.optional()
				.describe(
					"Connector kind. 'saas' (default) = a hosted MCP server (needs mcp_url). 'api' = a credentialed REST API the agent calls directly with no MCP server (needs base_url + allowed_hosts) - use this for an OAuth-backed HTTP API like a Google API.",
				),
			mcp_url: z
				.string()
				.optional()
				.describe(
					"URL of the MCP server (HTTP / SSE) - required for kind 'saas'. The OAuth dance is discovered by probing this URL for a 401 + WWW-Authenticate header.",
				),
			mcp_transport: z
				.enum(['http', 'sse'])
				.optional()
				.describe('Transport for the MCP server. Defaults to http.'),
			provider_id: z
				.string()
				.optional()
				.describe(
					'Optional MCP capability-registry key (e.g. "datocms", "github"). When set, capability defaults from the shared registry pre-fill display name and allowed hosts. This is the MCP-server registry namespace - not the OAuth-broker provider (see oauth_provider_id).',
				),
			base_url: z
				.string()
				.optional()
				.describe(
					"For kind 'api' - the REST API base URL agents call (e.g. https://www.googleapis.com/youtube/v3).",
				),
			allowed_hosts: z
				.array(z.string())
				.optional()
				.describe(
					'For kind \'api\' - the hosts the credential may be sent to (e.g. ["*.googleapis.com"]). Required for api connectors.',
				),
			auth: z
				.object({
					placement: z.enum(['header', 'query']),
					name: z.string(),
					scheme: z.string().optional(),
				})
				.optional()
				.describe(
					"For kind 'api' - where the credential rides. Defaults to an `Authorization: Bearer ` header when omitted (the right default for OAuth access tokens).",
				),
			oauth_provider_id: z
				.string()
				.optional()
				.describe(
					'For kind \'api\' only - a bundled OAuth-broker provider key (e.g. "google-youtube") to pre-select for the human. The provider is then LOCKED in the completion UI: the human finishes the OAuth device flow inline (in the task comment or on the Connectors page) by pasting only a client id - no provider picker. Omit for a plain API-key REST connector.',
				),
			skill_id: z
				.string()
				.optional()
				.describe(
					'Optional ID of a previously-fetched skill document (see fetch_skill_file). When set, the skill file is exposed to every team agent run via the per-adapter skill path.',
				),
			access: z
				.enum(['read', 'write'])
				.optional()
				.describe(
					"How much of the server you need. 'write' (default) leaves every method the server advertises available. 'read' asks for read-only: once the human connects it, every write method the server advertises is disabled automatically, and runs never see them. Ask for 'read' whenever the task only needs to look things up - it is the narrowest scope that still does the job, and the human can widen it later. This is a request, not a grant: if the human has already chosen which methods are enabled, their choice stands.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveTaskScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, taskId } = scope;

			const displayName = (args.display_name as string).trim();
			const providerId = (args.provider_id as string | undefined)?.trim() || null;
			const kind = (args.kind as 'saas' | 'api' | undefined) ?? 'saas';
			const mcpTransport = (args.mcp_transport as 'http' | 'sse' | undefined) ?? 'http';
			const skillId = (args.skill_id as string | undefined) ?? null;
			// Only a 'read' request carries meaning downstream — 'write' is today's
			// behaviour, so storing it would just be noise on the row.
			const requestedAccess =
				(args.access as 'read' | 'write' | undefined) === 'read' ? ConnectorAccess.Read : null;

			// For an OAuth REST-API connector, validate the api config and the
			// bundled broker provider (if any) up front. The provider is persisted
			// on the connector so the completion UI can lock it and the device-flow
			// start resolves it without the client re-sending it.
			let apiConfig: Record<string, unknown> | undefined;
			if (kind === 'api') {
				const oauthProviderId = (args.oauth_provider_id as string | undefined)?.trim();
				if (oauthProviderId) {
					const known = resolveConnectorRegistry().oauthProviders.some(
						(p) => p.id === oauthProviderId,
					);
					if (!known) return { error: `unknown oauth_provider_id=${oauthProviderId}` };
				}
				const validated = validateApiConnectorConfig({
					base_url: args.base_url,
					allowed_hosts: args.allowed_hosts,
					// Default to an Authorization: Bearer header — the right carrier for
					// an OAuth access token when the caller doesn't specify.
					auth: (args.auth as Record<string, unknown> | undefined) ?? {
						placement: 'header',
						name: 'Authorization',
						scheme: 'Bearer ',
					},
				});
				if (!validated.ok) return { error: validated.error };
				// Merge the provider preset AFTER validation (the validator strips
				// unknown keys, so oauth_provider_id must not pass through it).
				apiConfig = {
					...(validated.config as unknown as Record<string, unknown>),
					...(oauthProviderId ? { oauth_provider_id: oauthProviderId } : {}),
				};
			} else if (!(args.mcp_url as string | undefined)?.trim()) {
				return { error: "kind 'saas' requires mcp_url" };
			}
			const mcpUrl = kind === 'saas' ? (args.mcp_url as string).trim() : undefined;

			// Slug from providerId if available, else from display_name. Connectors
			// are scoped by project, so `(project_id, name)` is the idempotency key.
			const slugSource = providerId ?? displayName;
			const name = slugSource
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 64);
			if (!name) return { error: 'display_name produced an empty slug' };

			const { createOrFetchConnector, statusOf } = await import('../services/connectors/lifecycle');
			const { row, alreadyExisted } = await createOrFetchConnector(db, {
				name,
				displayName,
				mcpUrl,
				mcpTransport,
				// A known provider (e.g. github) carries static headers like
				// X-MCP-Toolsets in its capability — apply them so an agent-registered
				// connector matches the UI "Connect" path.
				mcpHeaders: providerId ? getConnectorCapability(providerId)?.mcpServer.headers : undefined,
				kind: kind === 'api' ? ConnectorTransport.Api : undefined,
				apiConfig,
				skillId,
				createdByTaskId: taskId,
				projectId: scope.projectId,
				requestedAccess,
			});

			if (!alreadyExisted) {
				events?.emit({
					type: 'mcp_connection.created',
					teamId,
					actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
					actorMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
					connectionId: row.id as string,
					name: name as string,
				});
			}

			const status = statusOf(row);

			// If already active, no need for a Connect comment — just signal the
			// caller; they should retry whatever needed the connector.
			if (status === 'active') {
				return {
					connector_id: row.id,
					status,
					name: row.name,
					display_name: row.display_name,
					reused: true,
				};
			}

			// Idempotent comment: don't post a second connect_required for the same
			// connector_id on the same task.
			const existingComment = await db.query<{ id: string }>(
				`SELECT id FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'connect_required'::comment_content_type
				   AND content->>'connector_id' = $2
				 ORDER BY created_at ASC LIMIT 1`,
				[taskId, row.id],
			);

			let commentId: string;
			if (existingComment.rows.length > 0) {
				commentId = existingComment.rows[0].id;
			} else {
				const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const content = {
					connector_id: row.id,
					display_name: displayName,
					provider_id: providerId,
					// Surfaced on the connect card so the human sees what the agent
					// asked for before they authorize it, not after.
					...(requestedAccess ? { requested_access: requestedAccess } : {}),
				};
				const inserted = await db.query<{ id: string }>(
					`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
					 VALUES ($1, $2, 'connect_required'::comment_content_type, $3::jsonb)
					 RETURNING *`,
					[taskId, authorMemberId, JSON.stringify(content)],
				);
				commentId = inserted.rows[0].id;
				broadcastCommentFamilyChange(
					wsManager,
					teamId,
					scope.projectId,
					'task_comments',
					'INSERT',
					inserted.rows[0],
				);
			}

			return {
				connector_id: row.id,
				status,
				name: row.name,
				display_name: row.display_name,
				comment_id: commentId,
				reused: alreadyExisted,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'fetch_skill_file',
		"Fetch a remote agent skill file (Markdown describing how to use a third-party MCP server) and store it as a skill (auto_load). Returns the skill_id and slug. Subsequent agent runs get this skill file injected into their adapter's skills directory. Idempotent on the derived slug - re-fetching the same URL updates the existing skill. Choose `scope`: 'global' shares it with every project (e.g. a widely-used MCP's usage docs), 'project' keeps it private to this project. Defaults to 'project'.",
		{
			project: projectArg(),
			url: z
				.string()
				.describe(
					'HTTPS URL of the skill file. Only http/https schemes are allowed; response must be < 256KB; 10s timeout.',
				),
			title: z
				.string()
				.optional()
				.describe('Human-readable title shown in the team KB. Defaults to the URL pathname.'),
			scope: z
				.enum(['project', 'global'])
				.optional()
				.describe(
					"'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const url = (args.url as string).trim();
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return { error: 'Invalid URL' };
			}
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return { error: 'Only http/https URLs are allowed' };
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			let res: Response;
			try {
				res = await fetch(url, { signal: controller.signal });
			} catch (e) {
				clearTimeout(timeout);
				return { error: `Fetch failed: ${(e as Error).message}` };
			}
			clearTimeout(timeout);
			if (!res.ok) {
				return { error: `Fetch failed: HTTP ${res.status}` };
			}
			const contentLength = res.headers.get('content-length');
			if (contentLength && Number(contentLength) > 256 * 1024) {
				return { error: 'Response too large (>256KB)' };
			}
			const body = await res.text();
			if (body.length > 256 * 1024) {
				return { error: 'Response too large (>256KB)' };
			}

			// Slug from URL pathname (e.g. /docs/mcp-server/agent-skill.md → agent-skill).
			const pathSlug = parsed.pathname
				.split('/')
				.filter(Boolean)
				.pop()
				?.replace(/\.[a-z0-9]+$/i, '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const hostSlug = parsed.host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const slug = `${hostSlug}--${pathSlug || 'skill'}`.slice(0, 64);
			const title = (args.title as string | undefined) ?? parsed.pathname;

			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const targetProjectId = args.scope === 'global' ? null : scope.projectId;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256').update(body).digest('hex');
			const description = deriveSkillSummary(body);

			const existing = await db.query<{ id: string }>(
				'SELECT id FROM skills WHERE slug = $1 AND project_id IS NOT DISTINCT FROM $2',
				[slug, targetProjectId],
			);
			// Flagged auto_load so the runner writes it to ~/.claude/skills for every
			// (scoped) run. Idempotent on slug within the chosen scope.
			const conflictTarget = targetProjectId
				? '(project_id, slug) WHERE project_id IS NOT NULL'
				: '(slug) WHERE project_id IS NULL';
			const upserted = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (name, slug, description, content, source_url, content_hash, created_by_member_id, tags, auto_load, project_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, true, $8)
				 ON CONFLICT ${conflictTarget} DO UPDATE SET
				   name = EXCLUDED.name,
				   description = EXCLUDED.description,
				   content = EXCLUDED.content,
				   source_url = EXCLUDED.source_url,
				   content_hash = EXCLUDED.content_hash,
				   auto_load = true,
				   updated_at = now()
				 RETURNING id, slug`,
				[title, slug, description, body, url, contentHash, authorMemberId, targetProjectId],
			);

			return {
				skill_id: upserted.rows[0].id,
				slug: upserted.rows[0].slug,
				scope: targetProjectId ? 'project' : 'global',
				source_url: url,
				size_bytes: body.length,
				reused: existing.rows.length > 0,
			};
		},
		db,
	);

	// Approvals
	tool(
		server,
		'list_approvals',
		`List pending approvals, newest first. Long string fields inside payload (e.g. skill-proposal content) come back truncated at \`excerpt_chars\` (default ${DEFAULT_TASK_EXCERPT_CHARS}) with *_truncated/_length companions, so one page cannot be dominated by a single large proposal - read a proposal in full from the approval itself. Paged: returns \`limit\` rows (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			project: projectArg(),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					`Cap for long string fields inside payload, with *_truncated/_length companions (default ${DEFAULT_TASK_EXCERPT_CHARS}).`,
				),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const limit = parseListLimit(args.limit);
			const params: unknown[] = [scope.teamId, ApprovalStatus.Pending];
			const keyset = keysetPredicate('a', decodeCursor(args.cursor as string | undefined), params);
			const r = await db.query<ListRow>(
				`SELECT ${APPROVAL_COLUMNS_ALIASED} FROM approvals a
				 WHERE a.team_id = $1 AND a.status = $2::approval_status${keyset ? ` AND ${keyset}` : ''}
				 ORDER BY ${keysetOrderBy('a')} LIMIT ${limit + 1}`,
				params,
			);
			const max = (args.excerpt_chars as number | undefined) ?? DEFAULT_TASK_EXCERPT_CHARS;
			return pagedList(
				r.rows.map((row) => excerptApprovalPayload(row, max)),
				limit,
				'list_approvals',
			);
		},
		db,
	);

	tool(
		server,
		'resolve_approval',
		'Approve or deny an approval',
		{
			approval_id: z.string().describe('Approval ID'),
			status: z
				.enum([ApprovalStatus.Approved, ApprovalStatus.Denied])
				.describe('Resolution status'),
			resolution_note: z.string().optional().describe('Note'),
		},
		async (args, db, auth) => {
			const existing = await db.query<{ team_id: string; payload: Record<string, unknown> }>(
				'SELECT team_id, payload FROM approvals WHERE id = $1',
				[args.approval_id],
			);
			if (existing.rows.length === 0) return { error: 'Approval not found' };
			const approvalTeamId = existing.rows[0].team_id;
			const approvalProjectId = existing.rows[0].payload?.project_id;
			if (typeof approvalProjectId === 'string') {
				const denied = await authorizeScope(db, auth, {
					teamId: approvalTeamId,
					projectId: approvalProjectId,
				});
				if (denied) return { error: denied };
			} else {
				const denied = await authorizeTeam(db, auth, approvalTeamId);
				if (denied) return { error: denied };
				if (auth.type === AuthType.Agent && !auth.crossProject) {
					return { error: 'Access denied: run is not scoped to resolve this approval' };
				}
			}

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const resolved = await resolveApproval(db, args.approval_id as string, {
				status: args.status as typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied,
				resolutionNote: typeof args.resolution_note === 'string' ? args.resolution_note : null,
				dataDir,
				actorMemberId,
				wsManager,
				events,
			});
			if (!resolved.ok) {
				return { error: resolved.message };
			}

			const { row, sideEffects } = resolved;
			const teamId = existing.rows[0].team_id;
			broadcastApprovalChange(wsManager, teamId, 'UPDATE', row);
			if (wsManager) {
				const room = wsRoom.team(teamId);
				for (const effect of sideEffects) {
					broadcastRowChange(wsManager, room, effect.table, effect.op, effect.row);
				}
			}
			return row;
		},
		db,
		{ write: true },
	);

	// Costs
	tool(
		server,
		'get_costs',
		`Get the cost summary for a project. Ungrouped returns a single total. group_by: 'agent' returns one row per agent (bounded by the roster). group_by: 'day' returns one row per day, newest first - that set grows for as long as the project runs, so it is paged: it returns \`limit\` days (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`, and when \`has_more\` is true you call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			project: projectArg(),
			group_by: z.enum(['agent', 'day']).optional().describe('Group costs by'),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			if (args.group_by === 'agent') {
				const r = await db.query(
					`SELECT ce.member_id, COALESCE(ma.title, m.display_name) AS agent_title, sum(ce.amount_cents)::int AS total_cents
				 FROM cost_entries ce LEFT JOIN members m ON m.id = ce.member_id LEFT JOIN member_agents ma ON ma.id = ce.member_id
				 WHERE ce.project_id = $1 GROUP BY ce.member_id, ma.title, m.display_name`,
					[scope.projectId],
				);
				return r.rows;
			}
			if (args.group_by === 'day') {
				// Cost rows accumulate for the life of the project, so the day grouping
				// is the one branch here without a natural ceiling. It keys on the day
				// itself: the grouping makes it unique, so no id tiebreak is needed.
				const limit = parseListLimit(args.limit);
				const cursor = decodeCursor(args.cursor as string | undefined);
				const params: unknown[] = [scope.projectId];
				let dayFilter = '';
				if (cursor) {
					params.push(cursor.value);
					dayFilter = ` AND date_trunc('day', ce.created_at)::date < $${params.length}::date`;
				}
				const r = await db.query<{ day: string; total_cents: number }>(
					`SELECT date_trunc('day', ce.created_at)::date AS day, sum(ce.amount_cents)::int AS total_cents
				 FROM cost_entries ce WHERE ce.project_id = $1${dayFilter}
				 GROUP BY day ORDER BY day DESC LIMIT ${limit + 1}`,
					params,
				);
				return pagedList(r.rows, limit, 'get_costs', { column: 'day', idKey: 'day' });
			}
			const r = await db.query(
				`SELECT sum(amount_cents)::int AS total_cents, count(*)::int AS entry_count FROM cost_entries WHERE project_id = $1`,
				[scope.projectId],
			);
			return r.rows[0];
		},
		db,
	);

	// System Prompt Management — read: any agent/admin in same team; write: coach only
	tool(
		server,
		'get_agent_system_prompt',
		"Read an agent's system prompt. Accessible by any agent or the admin in the same team. Returns the resolved role doc by default - `{{…}}` placeholders substituted with the real team name, manager, skills, project docs, and team context - so you can see what the agent actually says about itself with real values. Pass placeholders=false to get the raw stored template with `{{…}}` placeholders intact; only do this when you intend to edit the prompt and need a safe round-trip back through update_agent_system_prompt. A prompt too large for one read comes back as a byte window: when `next_offset` is non-null, call again with `offset` set to it until it is null. To read several prompts, use get_agent_system_prompts rather than looping this tool.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
			placeholders: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					'When true (default) substitutes `{{…}}` placeholders with real team/team values. When false returns the raw stored template - needed when reading before update_agent_system_prompt so placeholders survive the round-trip.',
				),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					'Byte offset to start reading the prompt from (default 0). Pass back `next_offset` to page a prompt too large for one read. Snapped down to a UTF-8 character boundary.',
				),
			max_bytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Max bytes of prompt text to return in this window (default and ceiling is the read budget, so a normal-size prompt comes back whole).',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			// Agents reference teammates by slug; accept either form. The team-scoped
			// query below is the authorization check — resolveAgentId can fall back to
			// an HQ agent, which must not be readable through a project team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };

			const agent = await db.query<{ title: string; slug: string }>(
				`SELECT ma.title, ma.slug
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (agent.rows.length === 0) return { error: 'Agent not found in this team' };

			const raw = await getAgentSystemPrompt(db, teamId, agentId);
			const system_prompt = args.placeholders
				? await resolveSystemPrompt(db, raw, {
						teamId,
						agentId,
						mode: 'placeholders',
					})
				: raw;
			// A resolved prompt grows with shared guidance and can outgrow the cap on
			// its own; window it so the single-resource read an agent falls back to is
			// never the one that fails.
			return windowContent({
				text: system_prompt,
				offset: args.offset as number | undefined,
				maxBytes: args.max_bytes as number | undefined,
				limit: SYSTEM_PROMPT_RESULT_BYTES,
				reserve: DOC_READ_ENVELOPE_RESERVE,
				hint: ({ start, end, total }) =>
					`Prompt is larger than one read. Returned bytes ${start}-${end} of ${total}. Call get_agent_system_prompt again with offset: ${end}; repeat until next_offset is null.`,
				build: (w: ContentWindow) => {
					const { content, ...rest } = w;
					return { ...agent.rows[0], system_prompt: content, ...rest };
				},
			});
		},
		db,
		{ audience: 'agent_or_admin', resultByteLimit: SYSTEM_PROMPT_RESULT_BYTES },
	);

	tool(
		server,
		'get_agent_system_prompts',
		`Read multiple agent system prompts in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}). Per-item \`mode\` chooses the resolution depth: \`placeholders\` (default) substitutes \`{{…}}\` with real values and stops, matching get_agent_system_prompt's default; \`preview\` additionally appends the resolver's runtime blocks (Project State, Team Context, Teammates, Working Guidelines) minus the per-run Run Context, matching the web UI's preview panel; \`raw\` returns the stored template untouched. Use this to compare prompts across the team in one round-trip - e.g. Captain auditing how team_context renders for every agent. PAGING: batch as many items as you like in any mode. The result carries as many prompts as fit under the cap plus \`next_index\`; when it is non-null, call again with the SAME \`items\` and \`start_index\` set to it, and repeat until it is null. Do not split the roster into single-item calls. For one prompt, use get_agent_system_prompt.`,
		{
			project: projectArg(),
			items: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent member ID or slug'),
						mode: z
							.enum(['raw', 'placeholders', 'preview'])
							.optional()
							.describe(
								'Resolution depth: raw | placeholders (default) | preview. See tool description.',
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} items.`),
			start_index: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					'Index into `items` to resume from (default 0). Pass back the `next_index` from the previous call, with the same `items`, to fetch the prompts that did not fit.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const items = args.items as Array<{ agent_id: string; mode?: SystemPromptMode }>;
			const startIndex = Math.min((args.start_index as number | undefined) ?? 0, items.length);
			const byteLimit = SYSTEM_PROMPT_RESULT_BYTES;
			const budget = MCP_BATCH_CHUNK_TARGET_BYTES;

			const resolveItem = async (item: (typeof items)[number], index: number) => {
				try {
					const out = await fetchAgentSystemPromptForBatch(
						db,
						teamId,
						item.agent_id,
						item.mode ?? 'placeholders',
					);
					return { index, ok: true as const, ...out };
				} catch (e) {
					if (e instanceof AgentSystemPromptError) {
						return { index, ok: false as const, agent_id: item.agent_id, error: e.message };
					}
					log.error('Unexpected error in get_agent_system_prompts:', e);
					return {
						index,
						ok: false as const,
						agent_id: item.agent_id,
						error: e instanceof Error ? e.message : 'internal_error',
					};
				}
			};

			// Resolve the whole requested tail in parallel (as before), then emit only
			// the prefix that fits under the cap and hand back a cursor for the rest.
			// A prompt is a single DB read, so resolving a few extra is far cheaper
			// than the round trip an agent pays to discover the page boundary.
			const resolved = await Promise.all(
				items.slice(startIndex).map((item, i) => resolveItem(item, startIndex + i)),
			);

			const page: unknown[] = [];
			let used = 0;
			let nextIndex: number | null = null;
			for (const [i, entry] of resolved.entries()) {
				const cost = Buffer.byteLength(JSON.stringify(entry), 'utf8');
				// Always emit at least one entry so the cursor cannot stall. A single
				// oversized `preview` is truncated to a window rather than dropped -
				// otherwise this index would never advance and the caller would loop.
				if (page.length > 0 && used + cost > budget) {
					nextIndex = startIndex + i;
					break;
				}
				if (page.length === 0 && cost > budget && entry.ok) {
					const buf = Buffer.from(entry.system_prompt, 'utf8');
					const keep = buf.subarray(0, utf8FloorBoundary(buf, budget - 2_048));
					page.push({
						...entry,
						system_prompt: keep.toString('utf8'),
						truncated: true,
						returned_bytes: keep.length,
						total_bytes: buf.length,
						truncation_hint: `This prompt alone exceeds the result cap. Read the rest with get_agent_system_prompt (agent_id: "${entry.agent_id}"), which pages via offset/next_offset.`,
					});
					used = budget;
					continue;
				}
				page.push(entry);
				used += cost;
			}
			if (nextIndex === null && startIndex + page.length < items.length) {
				nextIndex = startIndex + page.length;
			}

			return {
				items: page,
				start_index: startIndex,
				returned: page.length,
				total: items.length,
				next_index: nextIndex,
				...(nextIndex !== null
					? {
							paging_hint: `Returned prompts ${startIndex}-${startIndex + page.length - 1} of ${items.length}. Call get_agent_system_prompts again with the same items and start_index: ${nextIndex}; repeat until next_index is null.`,
						}
					: {}),
			};
		},
		db,
		{
			audience: 'agent_or_admin',
			resultByteLimit: SYSTEM_PROMPT_RESULT_BYTES,
			batchArrayParam: 'items',
		},
	);

	tool(
		server,
		'update_agent_system_prompt',
		'Apply a system prompt change for an agent. Callable by the Coach agent (for after-task learned-rules updates), the CEO (during cross-project coherence, from anywhere including its live chat), or the Captain of the same team (during team-coherence reviews). The change is applied immediately and a revision snapshot is stored so the admin can restore previous versions.',
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
			new_system_prompt: z
				.string()
				.describe(
					'The full updated system prompt. No substitution variable is required: Hezo composes the agent identity above this body and the live skills, preferences and project-docs context below it, adding only what the body does not already name. Read the current prompt with get_agent_system_prompt(placeholders=false) first so the round-trip is safe.',
				),
			change_summary: z.string().describe('Summary of what changed and why'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			const allowed =
				(await isHqInstanceAgent(db, auth)) || (await canCoordinateTeam(db, auth, teamId));
			if (!allowed) {
				return {
					error: 'Access denied: only the CEO, Coach, or Captain can update system prompts',
				};
			}

			// Accept a slug or member ID; the team-scoped check keeps an HQ agent
			// (resolveAgentId's fallback) from being editable through a project team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const agentCheck = await db.query<{ id: string; slug: string }>(
				`SELECT ma.id, ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (agentCheck.rows.length === 0) return { error: 'Agent not found in this team' };

			const targetSlug = agentCheck.rows[0].slug;
			// The house register: mechanical violations reject, judgement calls come
			// back as an advisory on the successful write (see prompt-style-guard).
			// The current length goes in so a prompt provisioned over the ceiling can
			// be consolidated downwards rather than being unwritable.
			const currentPrompt = await getDocument(db, {
				type: DocumentType.AgentSystemPrompt,
				teamId,
				memberAgentId: agentId,
			});
			const tooLarge = checkInjectedTextCap(
				'agent_system_prompt',
				args.new_system_prompt as string,
				currentPrompt?.content.length,
			);
			if (tooLarge) return { error: tooLarge.error };

			const styleError = authoredPromptError(args.new_system_prompt as string);
			if (styleError) return { error: styleError };

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.AgentSystemPrompt,
					teamId,
					memberAgentId: agentId,
				},
				content: args.new_system_prompt as string,
				changeSummary: args.change_summary as string,
				authorMemberId: callerMemberId,
			});

			trackBackground(
				enqueueTeamCoherenceReviewTask(db, teamId, 'prompt_updated', {
					changeSummary: `Updated ${targetSlug}'s system prompt: ${args.change_summary as string}`,
				}).catch((e) =>
					log.error('Failed to enqueue team coherence review after prompt update:', e),
				),
			);

			const styleWarning = authoredPromptWarning(args.new_system_prompt as string);
			return {
				applied: true,
				document_id: doc.row.id,
				...(styleWarning ? { warning: styleWarning } : {}),
			};
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'update_agent_system_prompts',
		`Apply system prompt changes to MULTIPLE agents in one call - the preferred way when a review touches several agents at once (e.g. the Coach applying learned rules across everyone in a feedback loop). Same callers and rules as update_agent_system_prompt (the CEO, the Coach, or the team's Captain); each change is applied immediately with its own revision snapshot. Files a SINGLE team-coherence review that summarises all the updates, so the Captain/CEO can account for them together. Prefer this over calling update_agent_system_prompt in a loop. Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} at once.`,
		{
			project: projectArg(),
			updates: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
						new_system_prompt: z
							.string()
							.describe(
								'Full updated prompt for this agent. No substitution variable is required; Hezo composes the identity and live-context blocks around it.',
							),
						change_summary: z.string().describe('Summary of what changed and why for this agent'),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} prompt updates.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			const allowed =
				(await isHqInstanceAgent(db, auth)) || (await canCoordinateTeam(db, auth, teamId));
			if (!allowed) {
				return {
					error: 'Access denied: only the CEO, Coach, or Captain can update system prompts',
				};
			}

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const updates = args.updates as Array<{
				agent_id: string;
				new_system_prompt: string;
				change_summary: string;
			}>;

			const results: Array<Record<string, unknown>> = [];
			const applied: Array<{ slug: string; change_summary: string }> = [];
			for (let i = 0; i < updates.length; i++) {
				const u = updates[i];
				const agentId = await resolveAgentId(db, teamId, u.agent_id);
				const agentCheck = agentId
					? await db.query<{ id: string; slug: string }>(
							`SELECT ma.id, ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
							 WHERE ma.id = $1 AND m.team_id = $2`,
							[agentId, teamId],
						)
					: null;
				if (!agentId || !agentCheck || agentCheck.rows.length === 0) {
					results.push({
						index: i,
						agent_id: u.agent_id,
						ok: false,
						error: 'Agent not found in this team',
					});
					continue;
				}
				const slug = agentCheck.rows[0].slug;
				const currentPrompt = await getDocument(db, {
					type: DocumentType.AgentSystemPrompt,
					teamId,
					memberAgentId: agentId,
				});
				const tooLarge = checkInjectedTextCap(
					'agent_system_prompt',
					u.new_system_prompt,
					currentPrompt?.content.length,
				);
				if (tooLarge) {
					results.push({ index: i, agent_id: u.agent_id, ok: false, error: tooLarge.error });
					continue;
				}

				const styleError = authoredPromptError(u.new_system_prompt);
				if (styleError) {
					results.push({ index: i, agent_id: u.agent_id, ok: false, error: styleError });
					continue;
				}
				const doc = await upsertDocument(db, undefined, {
					scope: { type: DocumentType.AgentSystemPrompt, teamId, memberAgentId: agentId },
					content: u.new_system_prompt,
					changeSummary: u.change_summary,
					authorMemberId: callerMemberId,
				});
				results.push({ index: i, agent_id: u.agent_id, slug, ok: true, document_id: doc.row.id });
				applied.push({ slug, change_summary: u.change_summary });
			}

			if (applied.length > 0) {
				const summary = `Updated ${applied.length} agent prompt(s): ${applied
					.map((a) => `${a.slug} (${a.change_summary})`)
					.join('; ')}`;
				trackBackground(
					enqueueTeamCoherenceReviewTask(db, teamId, 'prompt_updated', {
						changeSummary: summary,
					}).catch((e) =>
						log.error('Failed to enqueue team coherence review after batch prompt update:', e),
					),
				);
			}

			return { results, applied_count: applied.length };
		},
		db,
		{ write: true, audience: 'coordinator', batchArrayParam: 'updates' },
	);

	tool(
		server,
		'get_project_custom_prompt',
		'Read this project\'s Custom Prompt - the project-wide instruction block (the project context / "preferences") that is injected verbatim into every agent\'s system prompt in this project. Returns the current content plus its length and last-updated time (empty content when none is set yet). Read this before update_project_custom_prompt so you extend the existing guidance rather than overwrite it.',
		{
			project: projectArg(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const doc = await getDocument(db, {
				type: DocumentType.TeamPreferences,
				teamId: scope.teamId,
			});
			const content = doc?.content ?? '';
			return { content, length: content.length, updated_at: doc?.updated_at ?? null };
		},
		db,
	);

	tool(
		server,
		'update_project_custom_prompt',
		"Replace this project's Custom Prompt - the project-wide instruction block (the project context / \"preferences\") injected verbatim into every agent's system prompt in this project. Reach for this when guidance should apply to ALL of the project's agents from the very start of every run (a shared convention, standard, or fact) - it saves editing each agent's prompt one by one. This sends the WHOLE value and replaces it, so prefer edit_project_custom_prompt for any change to existing guidance - it sends only the span you are changing, so one bad rewrite cannot drop conventions you meant to keep. Reach for this tool to author the first version, or to restructure the whole thing deliberately; when you do, call get_project_custom_prompt first and extend what is there. Applied immediately; a revision snapshot is stored so the admin can restore previous versions. Only callable by the CEO, Coach, or the project's Captain.",
		{
			project: projectArg(),
			content: z
				.string()
				.describe(
					'The full new Custom Prompt content (Markdown). Replaces the current value entirely - include the existing guidance you want to keep.',
				),
			change_summary: z
				.string()
				.optional()
				.describe('Short summary of what changed and why (stored on the revision).'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			// Shared with the REST route so the role gate, the style guard and the
			// coherence review can never apply on one path and not the other.
			const result = await writeCustomPrompt(db, wsManager, {
				teamId,
				content: args.content as string,
				changeSummary: args.change_summary as string | undefined,
				auth,
			});
			if (result.status !== 'written') return { error: result.error };

			return {
				applied: true,
				document_id: result.row.id,
				length: (args.content as string).length,
				...(result.warning ? { warning: result.warning } : {}),
			};
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'edit_project_custom_prompt',
		"Replace one span of this project's Custom Prompt, leaving the rest untouched. Prefer this over update_project_custom_prompt for any change to existing guidance: it sends only the text you are changing, so a rewrite cannot silently drop a convention you meant to keep, and the argument stays proportional to the edit rather than to the whole prompt. `old_string` must match the current text EXACTLY, including indentation and line breaks: call get_project_custom_prompt first and copy the span verbatim rather than retyping it. It must also be unique - if it matches several places the call is refused, so extend it with surrounding lines until it is unique, or pass replace_all to change every match. The result returns the applied hunk with surrounding context plus the new length, so you can confirm what landed without reading it back. Records a revision, and files a team-coherence review when the content really changed. Only callable by the CEO, Coach, or the project's Captain.",
		{
			project: projectArg(),
			old_string: z
				.string()
				.describe(
					'The exact text to replace, copied verbatim from the Custom Prompt (including indentation and line breaks). Must be unique unless replace_all is set.',
				),
			new_string: z
				.string()
				.describe('The text to put in its place. May be empty to delete the span.'),
			replace_all: z
				.boolean()
				.optional()
				.describe(
					'Replace every occurrence of `old_string` rather than requiring it to be unique. Use for a rename that legitimately recurs; otherwise prefer extending `old_string` so the edit is unambiguous.',
				),
			change_summary: z
				.string()
				.optional()
				.describe('Short summary of what changed and why (stored on the revision).'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			const prior = await getDocument(db, { type: DocumentType.TeamPreferences, teamId });
			if (!prior?.content) {
				return {
					error:
						'This project has no Custom Prompt yet. edit_project_custom_prompt changes existing guidance; author the first version with update_project_custom_prompt.',
				};
			}

			const edited = applyStringEdit(
				prior.content,
				args.old_string as string,
				args.new_string as string,
				{ replaceAll: args.replace_all === true },
			);
			if (!edited.ok) return { error: edited.error };

			// The shared write path: same role gate, style guard and coherence review
			// as a full rewrite, so an edit cannot slip past a check a replace runs.
			const result = await writeCustomPrompt(db, wsManager, {
				teamId,
				content: edited.content,
				changeSummary: args.change_summary as string | undefined,
				auth,
			});
			if (result.status !== 'written') return { error: result.error };

			return {
				edited: true,
				document_id: result.row.id,
				replacements: edited.replacements,
				length: result.row.content.length,
				hunk: edited.hunk,
				...(result.warning ? { warning: result.warning } : {}),
			};
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	// Description maintenance — used by the Captain (and self) to write back
	// auto-generated agent and team summaries.
	tool(
		server,
		'set_agent_summary',
		'Save a short human-readable summary for an agent (≤1000 chars, single paragraph, plain prose). Callable by any agent in the same team or any the admin; the Captain is the expected caller, but agents may also self-summarise.',
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
			summary: z
				.string()
				.trim()
				.min(1, 'summary must be non-empty')
				.max(1000, 'summary too long (max 1000)')
				.describe('The new summary, ≤1000 chars'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			// Length/non-empty enforced by the schema; the SDK rejects violations
			// before the handler. `.trim()` in the schema means the stored value is
			// already trimmed.
			const summary = (args.summary as string).trim();

			// Accept a slug or member ID; the team_id filter scopes the write so an HQ
			// agent (resolveAgentId's fallback) can't be summarised through this team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const r = await db.query<{ id: string }>(
				`UPDATE member_agents SET summary = $1, updated_at = now()
				 WHERE id = $2 AND id IN (
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
				 )
				 RETURNING id`,
				[summary, agentId, teamId],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			trackBackground(
				enqueueTeamCoherenceReviewTask(db, teamId, 'summary_updated').catch((e) =>
					log.error('Failed to enqueue team coherence review after summary update:', e),
				),
			);

			const styleWarning = authoredPromptWarning(args.summary as string);
			return { updated: true, ...(styleWarning ? { warning: styleWarning } : {}) };
		},
		db,
		{ write: true, audience: 'agent_or_admin' },
	);

	// Identity — the name a teammate is addressed by, and the face it shows.
	tool(
		server,
		'set_agent_name',
		'Give an agent the human name it is addressed by (e.g. "Max" for the Engineer), or clear it with an empty string to fall back to its role. The name displays in place of the role everywhere and becomes a second mention handle, so both @max and @engineer reach the agent. Names must be unique within the team, and the Captain, CEO and Coach are always addressed by role and cannot be named. Callable by the Captain of that team, or the CEO.',
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
			name: z
				.string()
				.trim()
				.max(AGENT_HUMAN_NAME_MAX, `name too long (max ${AGENT_HUMAN_NAME_MAX})`)
				.describe('The name to use, or an empty string to clear it'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Only the Captain of this team or the CEO can name an agent' };
			}

			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const target = await db.query<{ slug: string }>(
				`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			const slug = target.rows[0]?.slug;
			if (!slug) return { error: 'Agent not found in this team' };
			if (isNameOnlyRole(slug)) {
				return {
					error: `${slug} is always addressed by its role and cannot be given a human name`,
				};
			}

			const name = (args.name as string).trim();
			// Checked and applied together so two concurrent renames cannot both
			// take one handle.
			const rejection = await withTransaction(db, async () => {
				const conflict = await checkHumanNameAvailable(db, {
					teamId,
					name,
					excludeMemberId: agentId,
				});
				if (conflict) return conflict;
				await applyAgentHumanName(db, agentId, name, inferGender(name));
				return null;
			});
			if (rejection) return { error: rejection.message };

			return { updated: true, name: name || null };
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'generate_agent_avatar',
		"Generate a fresh pixel avatar for an agent. The face is composed from the agent's role and name, so there is nothing to choose beyond asking for a new one; call it again for a different face. Use it for a newly hired agent, or one that still has no avatar. Callable by the Captain of that team, or the CEO.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Only the Captain of this team or the CEO can change an avatar' };
			}

			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const target = await db.query<{ slug: string; title: string; gender: AgentGender | null }>(
				`SELECT ma.slug, ma.title, ma.gender FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			const row = target.rows[0];
			if (!row) return { error: 'Agent not found in this team' };

			const spec = buildAgentAvatarSpec({ slug: row.slug, title: row.title, gender: row.gender });
			await db.query(
				'UPDATE member_agents SET avatar_spec = $2, updated_at = now() WHERE id = $1',
				[agentId, JSON.stringify(spec)],
			);
			return { updated: true };
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'set_team_summary',
		'Save the team-level collaboration summary for a team (≤4000 chars, plain prose, may span paragraphs). Only callable by the Captain of that team.',
		{
			project: projectArg(),
			summary: z
				.string()
				.trim()
				.min(1, 'summary must be non-empty')
				.max(4000, 'summary too long (max 4000)')
				.describe('The new team summary, ≤4000 chars'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain can update the team summary' };
			}

			// Length/non-empty enforced by the schema; `.trim()` already trimmed it.
			const summary = (args.summary as string).trim();

			await db.query('UPDATE teams SET summary = $1, updated_at = now() WHERE id = $2', [
				summary,
				teamId,
			]);

			const styleWarning = authoredPromptWarning(args.summary as string);
			return { updated: true, ...(styleWarning ? { warning: styleWarning } : {}) };
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'report_no_work',
		'Declare that, after evaluating the current task this run, there is genuinely nothing to do - no comment, sub-task, status change, code change, or other action is warranted. Records the run as an intentional no-op so it is NOT flagged as a failed empty run, and is the correct, auditable way to end such a turn (preferred over posting a redundant "nothing to do" comment). Use ONLY when you have truly concluded no action is needed this turn - never to skip, defer, or avoid real work.',
		{
			reason: z
				.string()
				.trim()
				.min(1, 'reason must be non-empty')
				.describe('One-line explanation of why there is nothing to do this run.'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent || !auth.runId) {
				return { error: 'report_no_work is only available within an agent run' };
			}
			// Non-empty (after trim) enforced by the schema.
			const reason = (args.reason as string).trim();
			await markRunReportedNoWork(db, auth.runId, reason);
			return { ok: true };
		},
		db,
		{ audience: 'agent_run' },
	);

	tool(
		server,
		'set_agent_team_context',
		`Save the team-relationships context for an agent (≤${INJECTED_TEXT_CAPS.agent_team_context} chars, plain prose, second-person 'you', describes how this agent relates to its manager, direct reports, peers, indirect reports, and humans). This blob is injected into the agent's system prompt at the start of every run. Only callable by the Captain of the same team.`,
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
			content: z
				.string()
				.trim()
				.min(1, 'content must be non-empty')
				.describe(`The new team_context, ≤${INJECTED_TEXT_CAPS.agent_team_context} chars`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain can update agent team contexts' };
			}

			// Non-empty enforced by the schema; `.trim()` already trimmed it.
			const content = (args.content as string).trim();

			// Accept a slug or member ID; the team_id filter scopes the write so an HQ
			// agent (resolveAgentId's fallback) can't be written through this team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };

			// The ceiling is checked here rather than as a schema `.max()` so it can
			// see the value being replaced: provisioning writes this field uncapped,
			// so one that starts over the line must stay editable downwards.
			const current = await db.query<{ team_context: string | null }>(
				`SELECT ma.team_context FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			const tooLarge = checkInjectedTextCap(
				'agent_team_context',
				content,
				current.rows[0]?.team_context?.length,
			);
			if (tooLarge) return { error: tooLarge.error };

			const r = await db.query<{ id: string }>(
				`UPDATE member_agents SET team_context = $1, updated_at = now()
				 WHERE id = $2 AND id IN (
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
				 )
				 RETURNING id`,
				[content, agentId, teamId],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			const styleWarning = authoredPromptWarning(args.content as string);
			return { updated: true, ...(styleWarning ? { warning: styleWarning } : {}) };
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'set_agent_team_contexts',
		`Save team-relationships contexts for MULTIPLE agents in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}) - the preferred way during a coherence review, which rewrites every affected agent's context together. Same rules and caller as set_agent_team_context (the Captain of the same team); each content is ≤${INJECTED_TEXT_CAPS.agent_team_context} chars of plain second-person prose. Returns a per-item result so one bad agent_id does not lose the rest of the batch. Prefer this over calling set_agent_team_context in a loop.`,
		{
			project: projectArg(),
			updates: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
						content: z
							.string()
							.trim()
							.min(1, 'content must be non-empty')
							.describe(
								`The new team_context for this agent, ≤${INJECTED_TEXT_CAPS.agent_team_context} chars`,
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} context updates.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain can update agent team contexts' };
			}

			const updates = args.updates as Array<{ agent_id: string; content: string }>;
			const results: Array<Record<string, unknown>> = [];
			for (let i = 0; i < updates.length; i++) {
				const u = updates[i];
				const agentId = await resolveAgentId(db, teamId, u.agent_id);
				const current = agentId
					? await db.query<{ team_context: string | null }>(
							`SELECT ma.team_context FROM member_agents ma JOIN members m ON m.id = ma.id
							 WHERE ma.id = $1 AND m.team_id = $2`,
							[agentId, teamId],
						)
					: null;
				if (!agentId || !current || current.rows.length === 0) {
					results.push({
						index: i,
						agent_id: u.agent_id,
						ok: false,
						error: 'Agent not found in this team',
					});
					continue;
				}
				// Per item, so one over-ceiling context does not lose the rest of the
				// batch — the same reason the prompt batch refuses per item.
				const tooLarge = checkInjectedTextCap(
					'agent_team_context',
					u.content.trim(),
					current.rows[0].team_context?.length,
				);
				if (tooLarge) {
					results.push({ index: i, agent_id: u.agent_id, ok: false, error: tooLarge.error });
					continue;
				}
				const r = await db.query<{ id: string; slug: string }>(
					`UPDATE member_agents SET team_context = $1, updated_at = now()
					 WHERE id = $2 AND id IN (
					   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
					 )
					 RETURNING id, slug`,
					[u.content.trim(), agentId, teamId],
				);
				if (r.rows.length === 0) {
					results.push({
						index: i,
						agent_id: u.agent_id,
						ok: false,
						error: 'Agent not found in this team',
					});
					continue;
				}
				results.push({ index: i, agent_id: agentId, slug: r.rows[0].slug, ok: true });
			}
			return { items: results, updated: results.filter((r) => r.ok).length, total: updates.length };
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'set_agent_summaries',
		`Save short human-readable summaries for MULTIPLE agents in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}) - the preferred way during a coherence review, which rewrites every affected agent's summary together. Same rules and callers as set_agent_summary (any agent in the same team, or the admin); each summary is ≤1000 chars, a single plain-prose paragraph. Files a SINGLE team-coherence review for the whole batch rather than one per agent. Returns a per-item result so one bad agent_id does not lose the rest of the batch. Prefer this over calling set_agent_summary in a loop.`,
		{
			project: projectArg(),
			updates: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
						summary: z
							.string()
							.trim()
							.min(1, 'summary must be non-empty')
							.max(1000, 'summary too long (max 1000)')
							.describe('The new summary for this agent, ≤1000 chars'),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} summary updates.`),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const updates = args.updates as Array<{ agent_id: string; summary: string }>;
			const results: Array<Record<string, unknown>> = [];
			for (let i = 0; i < updates.length; i++) {
				const u = updates[i];
				const agentId = await resolveAgentId(db, teamId, u.agent_id);
				const r = agentId
					? await db.query<{ id: string; slug: string }>(
							`UPDATE member_agents SET summary = $1, updated_at = now()
							 WHERE id = $2 AND id IN (
							   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
							 )
							 RETURNING id, slug`,
							[u.summary.trim(), agentId, teamId],
						)
					: null;
				if (!agentId || !r || r.rows.length === 0) {
					results.push({
						index: i,
						agent_id: u.agent_id,
						ok: false,
						error: 'Agent not found in this team',
					});
					continue;
				}
				results.push({ index: i, agent_id: agentId, slug: r.rows[0].slug, ok: true });
			}

			// One review for the batch, not one per agent - the singular tool files
			// its own, so a loop over it would queue N coalescing events for what is
			// a single roster-wide edit.
			if (results.some((r) => r.ok)) {
				trackBackground(
					enqueueTeamCoherenceReviewTask(db, teamId, 'summary_updated').catch((e) =>
						log.error('Failed to enqueue team coherence review after summary batch:', e),
					),
				);
			}

			return { items: results, updated: results.filter((r) => r.ok).length, total: updates.length };
		},
		db,
		{ write: true, audience: 'agent_or_admin' },
	);

	tool(
		server,
		'set_agent_reports_to',
		"Set or change the manager an agent reports to - the structural reporting line in the org chart that gates delegation. Work can only be assigned to/from an agent along this line, so an agent whose manager is unset can't be delegated to or hand work down. Use this to wire up reporting structure (e.g. after hiring specialists, point them at their lead) or fix it during a coherence review. Pass the target agent and its new manager (both by slug or member ID); pass an empty reports_to to clear the line. Callable by the team's Captain or an HQ instance agent (CEO/Coach) acting in the team. The Captain, CEO, and Coach have fixed reporting lines (Captain → CEO; CEO/Coach → admin) that cannot be changed.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
			reports_to: z
				.string()
				.describe(
					"The new manager - an existing agent's slug (or member ID) on this team. Pass an empty string to clear the reporting line.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (!(await canCoordinateTeam(db, auth, teamId))) {
				return { error: 'Access denied: only the Captain or CEO can set reporting lines' };
			}

			// Resolve the target and confirm it belongs to this team (not an HQ fallback).
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const target = await db.query<{ slug: string }>(
				`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (target.rows.length === 0) return { error: 'Agent not found in this team' };

			// Structurally-fixed lines are immutable: the Captain always reports to the
			// CEO; the CEO and Coach report to the admin. These cannot be re-pointed.
			if (hasFixedReportsTo(target.rows[0].slug)) {
				return {
					error: `The ${target.rows[0].slug} reporting line is fixed and cannot be changed`,
				};
			}

			const raw = String(args.reports_to ?? '').trim();
			let managerId: string | null = null;
			if (raw) {
				managerId = await resolveAgentId(db, teamId, raw);
				if (!managerId) return { error: `reports_to: no agent '${raw}' in this team` };
				if (managerId === agentId) return { error: 'An agent cannot report to itself' };
				// Reject a cycle: walk up the proposed manager's chain — if it reaches
				// the target, the new link would close a loop.
				const seen = new Set<string>();
				let cursor: string | null = managerId;
				while (cursor !== null) {
					if (cursor === agentId) {
						return { error: 'reports_to would create a reporting cycle' };
					}
					if (seen.has(cursor)) break;
					seen.add(cursor);
					const parent: { rows: Array<{ reports_to: string | null }> } = await db.query<{
						reports_to: string | null;
					}>(`SELECT reports_to FROM member_agents WHERE id = $1`, [cursor]);
					cursor = parent.rows[0]?.reports_to ?? null;
				}
			}

			await db.query(`UPDATE member_agents SET reports_to = $1, updated_at = now() WHERE id = $2`, [
				managerId,
				agentId,
			]);

			const updated = await db.query<Record<string, unknown>>(
				`SELECT m.id, m.team_id, ma.slug, ma.title, ma.reports_to,
				        (SELECT ma2.title FROM member_agents ma2 WHERE ma2.id = ma.reports_to)
				          AS reports_to_title
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.id = $1`,
				[agentId],
			);
			if (updated.rows[0]) {
				broadcastRowChange(
					wsManager,
					wsRoom.team(teamId),
					'member_agents',
					'UPDATE',
					updated.rows[0],
				);
			}

			return {
				applied: true,
				agent: target.rows[0].slug,
				reports_to: managerId ? raw : null,
			};
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	tool(
		server,
		'get_agent_team_context',
		"Read an agent's stored team-relationships context. Useful for the Captain when regenerating siblings' contexts. Accessible by any agent or the admin in the same team.",
		{
			project: projectArg(),
			agent_id: z.string().describe('Target agent - its slug (e.g. "engineer") or member ID'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			// Accept a slug or member ID; the team-scoped query is the authorization
			// check, keeping an HQ agent (resolveAgentId's fallback) out of this team.
			const agentId = await resolveAgentId(db, teamId, args.agent_id as string);
			if (!agentId) return { error: 'Agent not found in this team' };
			const r = await db.query<{ title: string; slug: string; team_context: string }>(
				`SELECT ma.title, ma.slug, ma.team_context
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[agentId, teamId],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			return r.rows[0];
		},
		db,
		{ audience: 'agent_or_admin' },
	);

	tool(
		server,
		'get_agent_team_contexts',
		`Read the stored team-relationships context for MULTIPLE agents in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}). This is the read a coherence review wants: regenerating one agent's context requires seeing its siblings', so fetch the whole roster at once rather than calling get_agent_team_context per agent. Contexts are capped at 6000 chars each, so a normal roster comes back whole. PAGING: the result carries as many contexts as fit under the cap plus \`next_index\`; when it is non-null, call again with the SAME \`items\` and \`start_index\` set to it, and repeat until it is null. Accessible by any agent or the admin in the same team.`,
		{
			project: projectArg(),
			items: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent member ID or slug'),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} items.`),
			start_index: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					'Index into `items` to resume from (default 0). Pass back the `next_index` from the previous call, with the same `items`.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const items = args.items as Array<{ agent_id: string }>;
			const startIndex = Math.min((args.start_index as number | undefined) ?? 0, items.length);

			const resolveItem = async (item: { agent_id: string }, index: number) => {
				// The team-scoped query is the authorization check, keeping an HQ
				// agent (resolveAgentId's fallback) out of this team's results.
				const agentId = await resolveAgentId(db, teamId, item.agent_id);
				const r = agentId
					? await db.query<{ title: string; slug: string; team_context: string }>(
							`SELECT ma.title, ma.slug, ma.team_context
							 FROM member_agents ma JOIN members m ON m.id = ma.id
							 WHERE ma.id = $1 AND m.team_id = $2`,
							[agentId, teamId],
						)
					: null;
				if (!agentId || !r || r.rows.length === 0) {
					return {
						index,
						ok: false as const,
						agent_id: item.agent_id,
						error: 'Agent not found in this team',
					};
				}
				return { index, ok: true as const, agent_id: agentId, ...r.rows[0] };
			};

			const resolved = await Promise.all(
				items.slice(startIndex).map((item, i) => resolveItem(item, startIndex + i)),
			);

			// Same chunking contract as get_agent_system_prompts: emit the prefix
			// that fits and hand back a cursor for the rest, always at least one
			// entry so the cursor cannot stall.
			const page: unknown[] = [];
			let used = 0;
			let nextIndex: number | null = null;
			for (const [i, entry] of resolved.entries()) {
				const cost = Buffer.byteLength(JSON.stringify(entry), 'utf8');
				if (page.length > 0 && used + cost > MCP_BATCH_CHUNK_TARGET_BYTES) {
					nextIndex = startIndex + i;
					break;
				}
				page.push(entry);
				used += cost;
			}
			if (nextIndex === null && startIndex + page.length < items.length) {
				nextIndex = startIndex + page.length;
			}

			return {
				items: page,
				start_index: startIndex,
				returned: page.length,
				total: items.length,
				next_index: nextIndex,
				...(nextIndex !== null
					? {
							paging_hint: `Returned contexts ${startIndex}-${startIndex + page.length - 1} of ${items.length}. Call get_agent_team_contexts again with the same items and start_index: ${nextIndex}; repeat until next_index is null.`,
						}
					: {}),
			};
		},
		db,
		{ audience: 'agent_or_admin' },
	);

	tool(
		server,
		'set_agent_status',
		"Retire (disable) or reinstate (enable) an agent on a project's team. Callable by the team's Captain or by the CEO running in the team. Disabling stops the agent from being scheduled and unassigns it from every open task; enabling resumes scheduling. The change is fully reversible and preserves all of the agent's history, so this is the right way to remove a role the team no longer needs (e.g. after a coherence review). The Captain and the instance agents (CEO/Coach) cannot be disabled this way. Confirm with the admin before retiring an agent.",
		{
			project: projectArg(),
			agent: z
				.string()
				.trim()
				.min(1, 'agent is required')
				.describe(
					'Target agent - its slug (e.g. "engineer") or member ID. Must be a member of this project\'s team.',
				),
			status: z
				.enum([AgentAdminStatus.Enabled, AgentAdminStatus.Disabled])
				.describe('"disabled" retires the agent; "enabled" reinstates it.'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId } = scope;

			if (auth.type !== AuthType.Agent) {
				return { error: 'set_agent_status is only callable by agents' };
			}
			// The team's own Captain (running in-team) or an HQ instance agent — the
			// CEO, whether acting from the cross-team chat session or a task run scoped
			// into this team. canCoordinateTeam covers the Captain and the in-team HQ
			// case; isHqInstanceAgent additionally covers the cross-team CEO session,
			// whose run is scoped to HQ rather than this team.
			const allowed =
				(await canCoordinateTeam(db, auth, teamId)) || (await isHqInstanceAgent(db, auth));
			if (!allowed) {
				return {
					error: "Access denied: only the Captain or the CEO can change an agent's status",
				};
			}

			// agent non-empty enforced by the schema.
			const ref = (args.agent as string).trim();
			const target = await db.query<{ id: string; slug: string }>(
				`SELECT ma.id, ma.slug FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND (ma.id::text = $2 OR ma.slug = $2)
				 LIMIT 1`,
				[teamId, ref],
			);
			if (target.rows.length === 0) return { error: `Agent not found in this team: ${ref}` };
			const { id: agentId, slug } = target.rows[0];

			const status = args.status as AgentAdminStatus;
			const protectedSlugs: readonly string[] = [
				CAPTAIN_AGENT_SLUG,
				CEO_AGENT_SLUG,
				COACH_AGENT_SLUG,
			];
			if (status === AgentAdminStatus.Disabled && protectedSlugs.includes(slug)) {
				// The HQ instance singletons (CEO/Coach) are essential to the whole
				// instance and cannot be disabled through any path — not even the admin
				// web UI. The Captain is protected from agent-initiated disabling here,
				// but the admin may still retire one from the web UI if truly needed.
				const isInstance = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(slug);
				return {
					error: isInstance
						? `The ${slug} role is essential to the instance and cannot be disabled.`
						: `The ${slug} role is essential and cannot be retired with this tool; the admin can disable it from the web UI if truly needed.`,
				};
			}

			const result = await setAgentAdminStatus(
				{ db, wsManager, events },
				{
					teamId,
					agentId,
					status,
					actorType: AuditActorType.Agent,
					actorMemberId: auth.memberId,
				},
			);
			if (!result.ok && result.reason === 'not_found') {
				return { error: `Agent not found in this team: ${ref}` };
			}
			if (!result.ok && result.reason === 'already_in_state') {
				return { error: `Agent is already ${status}` };
			}
			return { updated: true, agent_id: agentId, slug, admin_status: status };
		},
		db,
		{ write: true, audience: 'coordinator' },
	);

	// Project docs
	tool(
		server,
		'list_project_docs',
		`List project documentation files (PRD, spec, implementation plan, etc.). Each entry carries its \`filename\`, a one-line \`description\` (what the doc is / when to read it, '' if unset), and \`content_length\` - the doc's size, so you can tell before opening it whether read_project_doc will need more than one window. Bodies are not returned here; read one with read_project_doc. Archived (soft-deleted) docs are excluded by default - set filter: 'archived' or 'all' to see them (entries then carry an \`archived\` flag). Paged: returns \`limit\` entries (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			project: projectArg(),
			filter: archiveFilterArg(),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const filter = toArchiveFilter(args.filter);
			const limit = parseListLimit(args.limit);
			// Summaries, not documents: the full-body read would ship every doc in
			// the project to render a list of filenames.
			const docs = await listDocumentSummaries(db, {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				includeArchived: filter !== ArchiveFilter.Active,
			});
			const visible = docs
				.filter((d) => matchesArchiveFilter(d.archived_at, filter))
				.map((d) => ({
					id: d.id,
					filename: d.slug,
					description: d.description,
					content_length: d.content_length,
					created_at: d.created_at,
					updated_at: d.updated_at,
					...(filter !== ArchiveFilter.Active ? { archived: d.archived_at !== null } : {}),
				}));
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? visible.findIndex((d) => d.id === cursor.id) + 1 : 0;
			return pagedList(visible.slice(from, from + limit + 1), limit, 'list_project_docs');
		},
		db,
	);

	// Shared error copy for tools that take an asset path.
	const assetPathError = (raw: string) =>
		`Invalid asset path '${raw}': up to ${ASSET_MAX_FOLDER_DEPTH} folder levels, each segment starting with a letter or digit (e.g. "launch/images/hero.png").`;

	/** Refusal copy for a write aimed at a path an archived asset still holds. */
	const archivedAssetWriteError = (filename: string) =>
		`Asset 'assets/${filename}' exists but is archived - call unarchive_project_asset first to overwrite it, or write under a different path.`;

	tool(
		server,
		'list_project_assets',
		"List the project's assets - files in the assets library (UI mockups, wireframes, diagrams, images, PDFs, scripts, and generated markdown such as blog posts or reports). Filenames may carry a folder prefix up to 2 levels deep (e.g. `launch/images/hero.png`); reference one in a comment or doc as `assets/<path>` exactly as returned here (e.g. assets/launch/images/hero.png), no backticks. Author both text and binary assets with write_project_asset (binary via encoding: 'base64') and reorganize with move_project_asset / copy_project_asset; obsolete assets are archived with archive_project_asset (hard deletion is admin-only). Archived assets are excluded by default - set filter: 'archived' or 'all' to see them (entries then carry an `archived` flag). Raster image entries (PNG/JPEG/GIF/WebP) also carry their pixel `width`/`height`. Every entry carries `byte_size`, so you can tell before opening one whether read_project_asset will need more than one window. Results are ordered newest-first by default; pass sort to order by name, size or file extension instead.",
		{
			project: projectArg(),
			filter: archiveFilterArg(),
			sort: assetSortArg(),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const filter = toArchiveFilter(args.filter);
			const sort = toAssetSortOrder(args.sort);
			const limit = parseListLimit(args.limit);
			const where =
				filter === ArchiveFilter.Active
					? ' AND archived_at IS NULL'
					: filter === ArchiveFilter.Archived
						? ' AND archived_at IS NOT NULL'
						: '';
			const assets = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				created_at: string;
				byte_size: string | number;
				width: number | null;
				height: number | null;
				archived_at: string | null;
			}>(
				`SELECT id, original_filename, content_type, created_at, byte_size, width, height, archived_at
				 FROM assets WHERE project_id = $1${where}
				 ORDER BY ${assetSortOrderBy(sort)}`,
				[scope.projectId],
			);
			// The caller picks the sort (by date, name, size or type), so the
			// cursor anchors on row identity rather than a fixed sort column.
			const rows = assets.rows.map((a) => ({
				id: a.id,
				filename: a.original_filename,
				content_type: a.content_type,
				created_at: a.created_at,
				// A size hint, for the same reason list_project_docs carries
				// content_length: without it a caller cannot tell before opening an
				// asset whether read_project_asset will need more than one window.
				byte_size: Number(a.byte_size),
				...(a.width !== null && a.height !== null ? { width: a.width, height: a.height } : {}),
				...(filter !== ArchiveFilter.Active ? { archived: a.archived_at !== null } : {}),
			}));
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? rows.findIndex((a) => a.id === cursor.id) + 1 : 0;
			return pagedList(rows.slice(from, from + limit + 1), limit, 'list_project_assets');
		},
		db,
	);

	/**
	 * Store a blob at an asset path and reconcile everything that hangs off it:
	 * the row upsert, dropping the blob it superseded, clearing any pending
	 * review comments, and the two broadcasts the web app listens for.
	 *
	 * Shared by write_project_asset and edit_project_asset so the edit path
	 * cannot drift from the write path. Each of these steps fails quietly if
	 * forgotten - a leaked blob costs storage with nothing pointing at it, and a
	 * missed broadcast leaves a stale review pane open in front of a user.
	 */
	const storeAssetBlob = async (opts: {
		db: Db;
		teamId: string;
		projectId: string;
		filename: string;
		blob: Blob;
		contentType: string;
		width: number | null;
		height: number | null;
		uploadedByMemberId: string | null;
	}): Promise<
		| { error: string }
		// The archived variant is turned into an `error` below, so callers get the
		// stored-successfully shape and keep their narrowing.
		| { result: Exclude<Awaited<ReturnType<typeof upsertProjectAsset>>, { status: 'archived' }> }
	> => {
		const { db: adb, teamId, projectId, filename, blob, contentType } = opts;
		const assetId = crypto.randomUUID();
		// Extracted here rather than in each caller so write_project_asset and
		// edit_project_asset cannot drift apart - the same reason this helper exists.
		const searchText = await assetSearchTextFromBlob(blob, contentType);
		const { byteSize, sha256 } = await assets.write(projectId, assetId, blob);
		let result: Awaited<ReturnType<typeof upsertProjectAsset>>;
		try {
			result = await upsertProjectAsset(adb, {
				assetId,
				teamId,
				projectId,
				contentType,
				byteSize,
				sha256,
				desiredName: filename,
				uploadedByMemberId: opts.uploadedByMemberId,
				width: opts.width,
				height: opts.height,
				searchText,
			});
		} catch (e) {
			await assets.delete(projectId, assetId).catch(() => {});
			throw e;
		}
		if (result.status === 'archived') {
			// Archived between the pre-flight and the upsert — the bytes we just
			// stored have no row pointing at them.
			await assets.delete(projectId, assetId).catch(() => {});
			return { error: archivedAssetWriteError(filename) };
		}
		if (result.replacedAssetId) {
			await assets.delete(projectId, result.replacedAssetId).catch(() => {});
		}
		if (result.wipedReviewComments) {
			// The overwrite consumed the pending review (wiped inside the upsert's
			// transaction) — tell viewers so their comment panes clear live.
			broadcastCommentFamilyChange(
				wsManager,
				teamId,
				projectId,
				'asset_review_comments',
				'DELETE',
				{ asset_id: result.replacedAssetId, cleared: true },
			);
		}
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'assets', 'INSERT', {
			id: result.asset.id,
			team_id: teamId,
			project_id: projectId,
			original_filename: result.asset.original_filename,
		});
		return { result };
	};

	tool(
		server,
		'write_project_asset',
		'Save a file to the project assets library so a human can open it AND other agents (your teammates and your own future runs) can read it back with read_project_asset - including a binary deliverable or generation output you produced (a rendered image, chart, diagram, screenshot, PDF, dataset, or media file). This is how such a file reaches both the admin and the next agent: a file left on the ephemeral container disk vanishes when the run ends and is invisible to everyone else, so anything a later step or teammate will reuse belongs here. Text formats (.html, .svg, .txt, .md, plus script/text formats stored as plain text: .sh, .py, .js, .ts, .json, .csv, .yaml, .yml) are written with the default encoding "utf8". Binary formats - any type a human can upload (.png, .jpg, .jpeg, .gif, .webp, .pdf, .mp3, .mp4, .webm, archives such as .zip/.tar/.tar.gz/.7z, …) - MUST pass encoding: "base64" with the file\'s bytes base64-encoded in `content`. For a LARGE binary, upload it instead via a multipart/form-data POST to `/mcp/assets` (fields `file` and `path` for the full destination path, plus optional `overwrite=true` to replace an existing asset in place, same Bearer auth): base64 in a JSON-RPC tool call can be silently truncated by a runtime\'s argument-size cap, whereas the multipart endpoint streams the bytes; the result is identical and shows up in list_project_assets / read_project_asset. When you DO write a binary through this tool, pass `byte_size` (the file\'s exact byte length) so a truncated `content` is rejected instead of stored corrupt. The filename may include a folder path up to 2 levels deep (e.g. "scripts/deploy-check.sh" or "launch/images/hero.png") - folders spring into existence with their first asset. Re-saving the same path overwrites it, so the reference stays stable; overwrite matching is PATH-EXACT ("x.html" and "blog/x.html" are different assets - after a move, write to the new full path or you will fork the file). IMPORTANT: any write to an existing path deletes ALL of its pending review comments (the admin\'s feedback returned by read_project_asset) - capture every comment in your context before the first write, and make all desired edits in one consolidated write. Returns the reference string to drop into a comment as `assets/<path>` (no backticks). HTML opens interactively in a new tab; markdown renders with a rich preview and a view-source toggle; a .csv renders as a table with the raw file behind the same toggle; images render inline in the assets library. Use a markdown asset for a standalone deliverable opened from the assets library; use write_project_doc for project context docs (specs, PRDs, research). Mockups and other deliverables belong here, never committed to the source repo.',
		{
			project: projectArg(),
			filename: z
				.string()
				.describe(
					'Path to write, optionally foldered (e.g. "ui-mockups.html", "launch/images/hero.png")',
				),
			content: z
				.string()
				.describe('File content - raw text for utf8, or base64-encoded bytes for base64'),
			encoding: z
				.enum(['utf8', 'base64'])
				.optional()
				.describe(
					'utf8 (default) for text assets; base64 for binary assets (images, PDFs, media) - required for any non-text type',
				),
			byte_size: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					"For a base64 binary: the file's exact byte length. When provided, the decoded content is checked against it and a truncated upload (a runtime capping the tool-call argument size, cutting `content` mid-stream) is rejected instead of silently stored. Strongly recommended for binaries.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const { teamId, projectId } = scope;
			const filename = normalizeAssetPath(args.filename as string);
			if (filename === null) return { error: assetPathError(args.filename as string) };
			const ext = extensionOf(assetBasename(filename));
			const contentType = ext
				? ATTACHMENT_EXTENSIONS[ext as keyof typeof ATTACHMENT_EXTENSIONS]
				: undefined;
			if (!contentType || !isAllowedAttachmentMime(contentType)) {
				return {
					error:
						'Unsupported asset type. Allowed: text formats (.html, .svg, .txt, .md, and .sh/.py/.js/.ts/.json/.csv/.yaml/.yml stored as plain text) written with encoding "utf8"; and binary formats (.png, .jpg, .jpeg, .gif, .webp, .pdf, .mp3, .mp4, .webm, and archives .zip/.tar/.gz/.tgz/.7z/.rar, …) written with encoding "base64".',
				};
			}

			const content = args.content as string;
			const encoding = (args.encoding as 'utf8' | 'base64' | undefined) ?? 'utf8';
			const isText = isTextAssetMime(contentType);
			if (!isText && encoding !== 'base64') {
				return {
					error: `Binary asset '${filename}' (${contentType}) must be written with encoding: "base64" - base64-encode the file's bytes in \`content\`. Only text formats accept the default utf8 encoding.`,
				};
			}
			let blob: Blob;
			if (encoding === 'base64') {
				// Buffer.from is lenient (it silently drops invalid chars), so validate
				// first and surface a clear error rather than storing corrupt bytes.
				const compact = content.replace(/\s+/g, '');
				if (compact.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
					return {
						error:
							'`content` is not valid base64. Base64-encode the file bytes (standard alphabet, optional `=` padding) and pass them as `content` with encoding: "base64".',
					};
				}
				// Truncation guard. Some coding-CLI runtimes silently cap tool-call
				// argument size, cutting a large base64 `content` mid-stream — which
				// would decode to a truncated, corrupt file while the tool still reports
				// success (the exact failure that produced 15 KB from a 1.16 MB PNG). A
				// valid base64 string's length is never ≡1 (mod 4), and a padded (`=`)
				// string is always a whole number of 4-char groups; either misalignment
				// means the content arrived truncated. Reject loudly and point at the
				// streaming multipart endpoint, which has no JSON-RPC argument limit.
				if (compact.length % 4 === 1 || (compact.includes('=') && compact.length % 4 !== 0)) {
					return {
						error:
							'`content` appears truncated - its base64 length is invalid, which usually means the runtime capped the tool-call argument size. Upload binaries via a multipart/form-data POST to `/mcp/assets` (field `file`, same Bearer auth); it streams the bytes and is not subject to the JSON-RPC argument limit, unlike base64 in write_project_asset.',
					};
				}
				blob = new Blob([new Uint8Array(Buffer.from(compact, 'base64'))], { type: contentType });
				// Deterministic truncation check: when the caller declares the file's
				// byte length, a decode that comes up short means the base64 argument
				// was cut before it reached us (the %4 heuristic above misses cuts that
				// land on a 4-char boundary). Reject rather than store a corrupt file.
				if (args.byte_size !== undefined && blob.size !== (args.byte_size as number)) {
					return {
						error: `\`content\` decoded to ${blob.size} bytes but byte_size=${args.byte_size} was declared - the base64 arrived truncated (a runtime can cap the tool-call argument size, cutting \`content\` mid-stream). Upload binaries via a multipart/form-data POST to \`/mcp/assets\` (fields \`file\`, \`path\`, optional \`overwrite=true\`); it streams the bytes and is not subject to the JSON-RPC argument limit.`,
					};
				}
			} else {
				// Text stays a string BlobPart — Blob encodes it as UTF-8, byte-identical
				// to the prior behaviour.
				blob = new Blob([content], { type: contentType });
			}
			if (blob.size > ATTACHMENT_MAX_BYTES) {
				return { error: 'Asset exceeds 10 MB.' };
			}

			// An archived asset keeps its path reserved; overwriting it would
			// silently resurrect (and clobber) soft-deleted content. The upsert
			// refuses it transactionally too — this pre-flight just avoids spending
			// the blob write on a doomed call.
			if (await archivedAssetHolderId(db, projectId, filename)) {
				return { error: archivedAssetWriteError(filename) };
			}

			// Capture raster-image pixel dimensions so read_project_asset /
			// list_project_assets can report them without re-parsing the blob.
			const dims = isRasterImageMime(contentType)
				? readImageDimensions(Buffer.from(await blob.arrayBuffer()))
				: null;
			const uploadedBy = auth.type === AuthType.Agent ? auth.memberId : null;
			const stored = await storeAssetBlob({
				db,
				teamId,
				projectId,
				filename,
				blob,
				contentType,
				width: dims?.width ?? null,
				height: dims?.height ?? null,
				uploadedByMemberId: uploadedBy,
			});
			if ('error' in stored) return stored;
			const result = stored.result;
			return {
				written: true,
				id: result.asset.id,
				reference: `assets/${result.asset.original_filename}`,
				byte_size: result.asset.byte_size,
				...(dims ? { width: dims.width, height: dims.height } : {}),
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'read_project_asset',
		"Read a project asset's contents by path (e.g. \"ui-mockups.html\" or \"scripts/check.sh\") - the files that list_project_assets returns (UI mockups, wireframes, SVG diagrams, text exports, scripts, markdown deliverables). Use the full path exactly as listed, folder prefix included. Text-based assets (HTML, SVG, plain text, markdown) come back inline as `content`. Raster images (PNG/JPEG/GIF/WebP) come back with their pixel `width`/`height` AND the image itself inline, so a vision-capable model can see it to review it - pass `include_image: false` to skip the pixels and get metadata only, and images above ~4 MB return metadata + `url` only. Other binary assets (PDFs, media, archives) are not inlined; the response gives a signed download `url` - fetch it with a plain `curl -fsSL '<url>' -o /tmp/<filename>` (no auth header needed; the URL is valid for 24h, re-call this tool for a fresh one). An archive (.zip, .tar, .tar.gz/.tgz, .7z) is downloaded that same way and then unpacked in your container - `unzip`, `tar` and `7z` are preinstalled. If an admin has left review comments on the asset they come back as `review_comments`: for text assets (markdown, plain text) each anchors to an exact `quote` (with `occurrence` = 0-based Nth match of that snippet); a comment without a quote applies to the whole file. Capture them all before any write_project_asset to the path - overwriting deletes every review comment. Archived assets are not readable by default - set filter: 'archived' or 'all' to read one. Large text assets come back one byte-window at a time: when `truncated` is true, call again with `offset` set to the returned `next_offset` and keep going until `next_offset` is null (`list_project_assets` reports each asset's `byte_size`, so you can tell in advance whether that will be needed). For markdown project docs use read_project_doc instead.",
		{
			project: projectArg(),
			filename: z
				.string()
				.describe('Asset path to read (e.g. "ui-mockups.html", "launch/images/hero.png")'),
			filter: archiveFilterArg(),
			include_image: z
				.boolean()
				.optional()
				.describe(
					'For raster images (PNG/JPEG/GIF/WebP): when true (default) the image is returned inline so a vision-capable model can see it. Pass false to get metadata only (dimensions + download URL) and skip the pixels.',
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'For a text asset: byte offset to start reading from (default 0). To page an asset too large for one read, pass back the `next_offset` from the previous call. Snapped down to a UTF-8 character boundary so a window never begins mid-character. Ignored for binary assets, which return a download URL instead.',
				),
			max_bytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'For a text asset: max bytes of content to return in this window (default and ceiling is the read budget, so a normal-size asset comes back whole). Clamped to the budget; the returned slice ends on a UTF-8 character boundary, so it can come back a few bytes short.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			const { projectId } = scope;
			const filename = normalizeAssetPath(args.filename as string);
			if (filename === null) return { error: assetPathError(args.filename as string) };

			const found = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				byte_size: string;
				width: number | null;
				height: number | null;
				archived_at: string | null;
			}>(
				`SELECT id, original_filename, content_type, byte_size, width, height, archived_at
				 FROM assets WHERE project_id = $1 AND original_filename = $2`,
				[projectId, filename],
			);
			if (found.rows.length === 0) return { error: `Asset '${filename}' not found` };
			const asset = found.rows[0];
			const archived = asset.archived_at !== null;
			const filter = toArchiveFilter(args.filter);
			if (!matchesArchiveFilter(asset.archived_at, filter)) {
				return {
					error: archived
						? `Asset 'assets/${filename}' is archived and the call's filter is 'active' (the default). Set filter: 'archived' or 'all' to read it, or unarchive_project_asset to restore it.`
						: `Asset 'assets/${filename}' is active but the call's filter is '${filter}'. Use filter: 'active' or 'all'.`,
				};
			}

			// A pending admin review rides along on every read (text and binary
			// alike — a whole-asset comment on an image matters as much as a quote
			// anchor in markdown).
			const reviewComments = await listReviewComments(db, { kind: 'asset', assetId: asset.id });
			const reviewField =
				reviewComments.length === 0
					? {}
					: {
							review_comments: reviewComments.map((r) => ({
								id: r.id,
								...(r.quote !== null ? { quote: r.quote, occurrence: r.occurrence } : {}),
								comment: r.comment,
								created_at: r.created_at,
							})),
						};

			// Text-based assets are returned inline; binary assets get a signed
			// download URL the agent fetches itself (curl) — blobs are never on the
			// container filesystem.
			const isText = isTextAssetMime(asset.content_type);
			if (!isText) {
				const raster = isRasterImageMime(asset.content_type);
				const byteSize = Number(asset.byte_size);
				const includeImage = args.include_image !== false;
				let width = asset.width;
				let height = asset.height;
				// A raster asset needs its bytes to backfill missing dimensions
				// and/or to return the image inline for a vision runtime to see.
				const wantInline = raster && includeImage && byteSize <= MCP_INLINE_IMAGE_MAX_BYTES;
				const needBytes = wantInline || (raster && (width === null || height === null));
				let buf: Buffer | null = null;
				if (needBytes) {
					// If the blob can't be read (e.g. a store hiccup or a row with no
					// backing bytes) fall back to the URL-only metadata rather than
					// failing the whole read.
					try {
						buf = await assets.read(projectId, asset.id);
					} catch {
						buf = null;
					}
					if (buf && raster && (width === null || height === null)) {
						const dims = readImageDimensions(buf);
						if (dims) {
							width = dims.width;
							height = dims.height;
							// Self-heal: persist so future reads / list_project_assets
							// don't re-parse this pre-existing asset's blob. Skipped on an
							// archived row — nothing writes an archived asset, and an
							// invariant with a carve-out is one no reader can rely on. The
							// dimensions are still reported; only the caching is skipped,
							// and archived reads are rare (explicitly opted into).
							if (!archived) {
								await db
									.query('UPDATE assets SET width = $1, height = $2 WHERE id = $3', [
										dims.width,
										dims.height,
										asset.id,
									])
									.catch(() => {});
							}
						}
					}
				}
				const metadata = {
					filename: asset.original_filename,
					content_type: asset.content_type,
					byte_size: byteSize,
					binary: true,
					...(width !== null && height !== null ? { width, height } : {}),
					url: await signAgentAssetUrl(asset.id, masterKeyManager, agentOrigin()),
					...(archived ? { archived: true } : {}),
					...reviewField,
				};
				// Under the cap and not opted out: hand the runtime the actual
				// pixels (as an MCP image block) alongside the metadata text.
				if (wantInline && buf) {
					return {
						__mcpContent: [
							{ type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
							{
								type: 'image' as const,
								data: buf.toString('base64'),
								mimeType: asset.content_type,
							},
						],
					};
				}
				return metadata;
			}

			const buf = await assets.read(projectId, asset.id);
			// Window the body exactly as read_project_doc does. Returned whole, a
			// text asset over the result cap tripped the generic result_too_large
			// guard - and because this tool declared no narrowing parameter, the
			// guard's advice fell through to "read it through a tool that pages",
			// of which there is none for an asset. That was a dead end, and the
			// likeliest asset to hit it is the self-contained interactive HTML
			// mockup the UI Designer is told to produce.
			return windowContent({
				text: buf.toString('utf-8'),
				offset: args.offset as number | undefined,
				maxBytes: args.max_bytes as number | undefined,
				limit: MCP_RESULT_BYTE_LIMIT,
				reserve: DOC_READ_ENVELOPE_RESERVE,
				hint: ({ start, end, total }) =>
					`Asset is larger than one read. Returned bytes ${start}-${end} of ${total}. Call read_project_asset again with offset: ${end}; repeat until next_offset is null.`,
				build: (w: ContentWindow) => ({
					filename: asset.original_filename,
					content_type: asset.content_type,
					...w,
					...(archived ? { archived: true } : {}),
					...reviewField,
				}),
			});
		},
		db,
	);

	tool(
		server,
		'edit_project_asset',
		"Replace one span of a TEXT project asset (HTML, SVG, markdown, plain text, a script), leaving the rest untouched. Prefer this over write_project_asset for any change to an existing text asset: it sends only the text you are changing, so the argument stays proportional to the edit rather than to the file - which matters most for exactly the assets that get tweaked, like a self-contained interactive HTML mockup, where re-sending the whole file risks a runtime's tool-call argument-size cap cutting it mid-stream. Binary assets (images, PDFs, media, archives) cannot be edited this way; rewrite them with write_project_asset. `old_string` must match the current text EXACTLY, including indentation and line breaks: read the asset first and copy the span verbatim rather than retyping it. It must also be unique - if it matches several places the call is refused, so extend it with surrounding lines until it is unique, or pass replace_all to change every match. The result returns the applied hunk with surrounding context plus the asset's new `byte_size`, so you can confirm what landed without reading it again. Like any overwrite this clears the asset's pending review comments, so capture those first.",
		{
			project: projectArg(),
			filename: z
				.string()
				.describe('Asset path to edit (e.g. "ui-mockups.html", "launch/notes.md")'),
			old_string: z
				.string()
				.describe(
					'The exact text to replace, copied verbatim from the asset (including indentation and line breaks). Must be unique in the asset unless replace_all is set.',
				),
			new_string: z
				.string()
				.describe('The text to put in its place. May be empty to delete the span.'),
			replace_all: z
				.boolean()
				.optional()
				.describe(
					'Replace every occurrence of `old_string` rather than requiring it to be unique. Use for a rename that legitimately recurs; otherwise prefer extending `old_string` so the edit is unambiguous.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { teamId, projectId } = scope;
			const filename = normalizeAssetPath(args.filename as string);
			if (filename === null) return { error: assetPathError(args.filename as string) };

			const found = await db.query<{
				id: string;
				content_type: string;
				archived_at: string | null;
			}>(
				`SELECT id, content_type, archived_at FROM assets
				 WHERE project_id = $1 AND original_filename = $2`,
				[projectId, filename],
			);
			if (found.rows.length === 0) {
				return {
					error: `Asset '${filename}' not found. edit_project_asset changes an existing asset; create a new one with write_project_asset.`,
				};
			}
			const asset = found.rows[0];
			if (asset.archived_at !== null) return { error: archivedAssetWriteError(filename) };
			if (!isTextAssetMime(asset.content_type)) {
				return {
					error: `Asset '${filename}' is ${asset.content_type}, which is binary - there is no text span to edit. Rewrite it with write_project_asset instead.`,
				};
			}

			const current = (await assets.read(projectId, asset.id)).toString('utf-8');
			const edited = applyStringEdit(
				current,
				args.old_string as string,
				args.new_string as string,
				{ replaceAll: args.replace_all === true },
			);
			if (!edited.ok) return { error: edited.error };

			const blob = new Blob([edited.content], { type: asset.content_type });
			if (blob.size > ATTACHMENT_MAX_BYTES) {
				return { error: 'Asset exceeds 10 MB.' };
			}
			const stored = await storeAssetBlob({
				db,
				teamId,
				projectId,
				filename,
				blob,
				contentType: asset.content_type,
				// Text assets carry no pixel dimensions.
				width: null,
				height: null,
				uploadedByMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
			});
			if ('error' in stored) return stored;
			return {
				edited: true,
				id: stored.result.asset.id,
				reference: `assets/${stored.result.asset.original_filename}`,
				replacements: edited.replacements,
				byte_size: stored.result.asset.byte_size,
				hunk: edited.hunk,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'move_project_asset',
		'Move or rename a project asset within the assets library: change its folder (up to 2 levels deep), its filename, or both - folders spring into existence when the first asset lands in them and vanish with their last one. The stored file does not change, so the destination must keep the same extension. Moves never overwrite: if the destination path is taken the call fails. IMPORTANT: existing text references to the old `assets/<path>` in comments and docs are NOT rewritten - they degrade to plain text - so update the places that cite the old path, and prefer organizing assets early over moving them later. To retire an obsolete asset, use archive_project_asset instead of moving it aside (hard deletion is admin-only).',
		{
			project: projectArg(),
			from: z.string().describe('Current asset path (e.g. "hero.png" or "launch/hero.png")'),
			to: z.string().describe('Destination path (e.g. "launch/images/hero.png")'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const from = normalizeAssetPath(args.from as string);
			if (from === null) return { error: assetPathError(args.from as string) };
			const to = normalizeAssetPath(args.to as string);
			if (to === null) return { error: assetPathError(args.to as string) };
			if (from === to) return { error: 'Source and destination are the same path.' };
			const fromExt = extensionOf(assetBasename(from));
			if (extensionOf(assetBasename(to)) !== fromExt) {
				return {
					error: `Destination must keep the '.${fromExt ?? ''}' extension - the stored file type does not change on a move. Use copy_project_asset or a fresh write_project_asset for format changes.`,
				};
			}
			const found = await db.query<{ id: string; archived_at: string | null }>(
				'SELECT id, archived_at FROM assets WHERE project_id = $1 AND original_filename = $2',
				[scope.projectId, from],
			);
			if (found.rows.length === 0) return { error: `Asset 'assets/${from}' not found` };
			if (found.rows[0].archived_at !== null) {
				return {
					error: `Asset 'assets/${from}' is archived - unarchive_project_asset first if you need to move it.`,
				};
			}
			const assetId = found.rows[0].id;
			try {
				await db.query('UPDATE assets SET original_filename = $1 WHERE id = $2', [to, assetId]);
			} catch (e) {
				if (isUniqueViolation(e)) {
					return {
						error: `Destination 'assets/${to}' already exists (it may be an archived asset holding the path) - moves never overwrite. Pick a different name.`,
					};
				}
				throw e;
			}
			broadcastRowChange(wsManager, wsRoom.team(scope.teamId), 'assets', 'UPDATE', {
				id: assetId,
				team_id: scope.teamId,
				project_id: scope.projectId,
				original_filename: to,
			});
			return {
				moved: true,
				id: assetId,
				from: `assets/${from}`,
				reference: `assets/${to}`,
				note: 'Existing text references to the old path no longer link - update comments/docs that cite it.',
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'copy_project_asset',
		'Copy a project asset to a new path in the assets library (any type, including binary). The copy is a new asset with its own id; the source is untouched and existing references keep pointing at it. Copies never overwrite: if the destination path is taken the call fails. Use it to duplicate a template before editing, or to stage related files into a folder.',
		{
			project: projectArg(),
			from: z.string().describe('Source asset path (e.g. "templates/report.md")'),
			to: z.string().describe('Destination path (e.g. "2026-q3/report.md")'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const from = normalizeAssetPath(args.from as string);
			if (from === null) return { error: assetPathError(args.from as string) };
			const to = normalizeAssetPath(args.to as string);
			if (to === null) return { error: assetPathError(args.to as string) };
			if (from === to) return { error: 'Source and destination are the same path.' };
			const found = await db.query<{
				id: string;
				content_type: string;
				archived_at: string | null;
				search_text: string | null;
			}>(
				'SELECT id, content_type, archived_at, search_text FROM assets WHERE project_id = $1 AND original_filename = $2',
				[scope.projectId, from],
			);
			if (found.rows.length === 0) return { error: `Asset 'assets/${from}' not found` };
			if (found.rows[0].archived_at !== null) {
				return {
					error: `Asset 'assets/${from}' is archived - unarchive_project_asset first if you need to copy it.`,
				};
			}
			const source = found.rows[0];

			const { teamId, projectId } = scope;
			const buf = await assets.read(projectId, source.id);
			const assetId = crypto.randomUUID();
			const { byteSize, sha256 } = await assets.write(
				projectId,
				assetId,
				new Blob([new Uint8Array(buf)]),
			);
			const uploadedBy = auth.type === AuthType.Agent ? auth.memberId : null;
			let inserted: { id: string; original_filename: string };
			try {
				const r = await db.query<{ id: string; original_filename: string }>(
					// The copy has identical bytes, so its search text is the source's -
					// carry the column across rather than re-extracting it.
					`INSERT INTO assets (id, team_id, project_id, content_type, byte_size, sha256, original_filename, uploaded_by_member_id, search_text)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
					 RETURNING id, original_filename`,
					[
						assetId,
						teamId,
						projectId,
						source.content_type,
						byteSize,
						sha256,
						to,
						uploadedBy,
						source.search_text,
					],
				);
				inserted = r.rows[0];
			} catch (e) {
				await assets.delete(projectId, assetId).catch(() => {});
				if (isUniqueViolation(e)) {
					return {
						error: `Destination 'assets/${to}' already exists - copies never overwrite. Pick a different name.`,
					};
				}
				throw e;
			}
			events?.emit({
				type: 'asset.created',
				teamId,
				projectId,
				actorType: actorTypeFromAuth(auth),
				actorMemberId: uploadedBy,
				actorApiKeyId: apiKeyIdFromAuth(auth),
				assetId: inserted.id,
				filename: inserted.original_filename,
				taskId: auth.type === AuthType.Agent ? auth.taskId : null,
				runId: auth.type === AuthType.Agent ? auth.runId : null,
			});
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'assets', 'INSERT', {
				id: inserted.id,
				team_id: teamId,
				project_id: projectId,
				original_filename: inserted.original_filename,
			});
			return { copied: true, id: inserted.id, reference: `assets/${to}` };
		},
		db,
		{ write: true },
	);

	// Archival is the agent-facing "delete" for assets: reversible, self-serve,
	// and the archived asset keeps its path reserved so references stay
	// unambiguous. Hard deletion remains a human/admin-only UI action.
	const setAssetArchived = async (
		args: Record<string, unknown>,
		db: Db,
		auth: AuthInfo,
		archived: boolean,
	) => {
		const scope = await resolveScope(db, auth, args);
		if ('error' in scope) return scope;
		const filename = normalizeAssetPath(args.filename as string);
		if (filename === null) return { error: assetPathError(args.filename as string) };
		const found = await db.query<{ id: string; archived_at: string | null }>(
			'SELECT id, archived_at FROM assets WHERE project_id = $1 AND original_filename = $2',
			[scope.projectId, filename],
		);
		if (found.rows.length === 0) return { error: `Asset 'assets/${filename}' not found` };
		const asset = found.rows[0];

		// Idempotent: re-asserting the current state succeeds without stacking
		// events, so a retried run never double-fires.
		if ((asset.archived_at !== null) === archived) {
			return { archived, reference: `assets/${filename}`, changed: false };
		}

		const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
		await db.query(
			`UPDATE assets
			 SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END,
			     archived_by_member_id = CASE WHEN $2 THEN $3::uuid ELSE NULL END
			 WHERE id = $1`,
			[asset.id, archived, archived ? actorMemberId : null],
		);
		events?.emit({
			type: 'asset.archived',
			teamId: scope.teamId,
			projectId: scope.projectId,
			actorType: actorTypeFromAuth(auth),
			actorMemberId,
			actorApiKeyId: apiKeyIdFromAuth(auth),
			assetId: asset.id,
			filename,
			archived,
			// Attribution: an agent restoring an asset so it can overwrite it is
			// exactly what the operator needs to trace back to a run.
			taskId: auth.type === AuthType.Agent ? auth.taskId : null,
			runId: auth.type === AuthType.Agent ? auth.runId : null,
		});
		broadcastRowChange(wsManager, wsRoom.team(scope.teamId), 'assets', 'UPDATE', {
			id: asset.id,
			team_id: scope.teamId,
			project_id: scope.projectId,
			original_filename: filename,
		});
		return { archived, reference: `assets/${filename}`, changed: true };
	};

	tool(
		server,
		'archive_project_asset',
		'Archive a project asset - the reversible soft delete, and the ONLY way an agent retires an asset (hard deletion is admin-only, so treat any "delete this asset" instruction as archive). The asset disappears from list_project_assets and default reads but keeps its path reserved; existing assets/<path> references in comments and docs keep resolving. Reverse with unarchive_project_asset. No approval needed.',
		{
			project: projectArg(),
			filename: z
				.string()
				.describe(
					'Asset path to archive - the full path exactly as list_project_assets returns it (e.g. "drafts/old-v1.md")',
				),
		},
		async (args, db, auth) => setAssetArchived(args, db, auth, true),
		db,
		{ write: true },
	);

	tool(
		server,
		'unarchive_project_asset',
		'Restore an archived project asset to active. It reappears in list_project_assets, becomes readable and writable again, and its assets/<path> reference links as before.',
		{
			project: projectArg(),
			filename: z.string().describe('Asset path to restore (the same path it was archived under)'),
		},
		async (args, db, auth) => setAssetArchived(args, db, auth, false),
		db,
		{ write: true },
	);

	tool(
		server,
		'read_project_doc',
		"Read a markdown project doc by filename (e.g. \"spec.md\") - the high-level project context (PRDs, specs, architecture decisions, research) that list_project_docs returns; the full body comes back inline as `content`. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so do not reach for the Read/cat file tools - always load a doc through this tool by its bare filename. Archived docs are not readable by default - set filter: 'archived' or 'all' to read one. When the admin has left review feedback on the doc, the result includes `review_comments` - each anchors a `comment` to a `quote` (an exact text snippet; `occurrence` disambiguates repeated snippets). Action them when asked to. IMPORTANT: any write to the doc deletes ALL of its review comments, so capture every comment from this result BEFORE your first write_project_doc call - after one write they are gone. For non-markdown assets (mockups, wireframes, diagrams) use read_project_asset instead. Large docs come back one byte-window at a time: when `truncated` is true, call again with `offset` set to the returned `next_offset` and keep going until `next_offset` is null.",
		{
			project: projectArg(),
			filename: z.string().describe('Filename to read (e.g. "spec.md")'),
			filter: archiveFilterArg(),
			offset: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe(
					'Byte offset to start reading from (default 0). To page through a doc too large for one read, pass back the `next_offset` from the previous call. Snapped down to a UTF-8 character boundary so a window never begins mid-character.',
				),
			max_bytes: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'Max bytes of content to return in this window (default and ceiling is the read budget, so a normal-size doc comes back whole). Clamped to the budget; the returned slice ends on a UTF-8 character boundary, so it can come back a few bytes short.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const doc = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: args.filename as string,
			});
			if (!doc) return { error: `File '${args.filename}' not found` };
			const archived = doc.archived_at !== null;
			const filter = toArchiveFilter(args.filter);
			if (!matchesArchiveFilter(doc.archived_at, filter)) {
				return {
					error: archived
						? `Doc '${doc.slug}' is archived and the call's filter is 'active' (the default). Set filter: 'archived' or 'all' to read it, or unarchive_project_doc to restore it.`
						: `Doc '${doc.slug}' is active but the call's filter is '${filter}'. Use filter: 'active' or 'all'.`,
				};
			}
			const archivedField = archived ? { archived: true } : {};
			const reviewComments = await listReviewComments(db, {
				kind: 'document',
				documentId: doc.id,
			});
			const descriptionField = doc.description ? { description: doc.description } : {};
			const reviewCommentsField =
				reviewComments.length > 0
					? {
							review_comments: reviewComments.map((r) => ({
								id: r.id,
								quote: r.quote,
								occurrence: r.occurrence,
								comment: r.comment,
								created_at: r.created_at,
							})),
						}
					: {};

			// Window the body so the serialized result stays under this tool's cap,
			// letting an agent page an arbitrarily large doc via offset/next_offset
			// instead of tripping the generic result_too_large guard. The windowing
			// itself is the shared convention (mcp/paging.ts); only the result shape
			// and the continuation sentence are this tool's own.
			return windowContent({
				text: doc.content,
				offset: args.offset as number | undefined,
				maxBytes: args.max_bytes as number | undefined,
				limit: MCP_RESULT_BYTE_LIMIT,
				reserve: DOC_READ_ENVELOPE_RESERVE,
				hint: ({ start, end, total }) =>
					`Doc is larger than one read. Returned bytes ${start}-${end} of ${total}. Call read_project_doc again with offset: ${end}; repeat until next_offset is null.`,
				build: (w: ContentWindow) => ({
					filename: doc.slug,
					...descriptionField,
					...w,
					...archivedField,
					...reviewCommentsField,
				}),
			});
		},
		db,
	);

	tool(
		server,
		'write_project_doc',
		"Write a project documentation file, replacing its whole body. These docs live in the project-doc store in the database, NOT on the filesystem: there is no /workspace/.hezo/project-docs path, so never author or edit one with the Write/Edit file tools or a shell redirect - a markdown file you save to disk persists nothing, is invisible to every teammate, and leaves the real doc stale. To change PART of an existing doc, prefer edit_project_doc: this tool sends the entire body, so a large doc means a large argument, and a runtime that caps tool-call argument size can cut `content` mid-stream. Pass `content_length` (the exact character count of `content`) so a truncated argument is rejected rather than silently overwriting the doc and wiping its review comments. Project docs are markdown only - the filename must end in .md. For high-level project context: PRD, spec, implementation plan, research. Make ALL desired edits in ONE consolidated write per run, for two reasons: (1) writing a doc deletes ALL of its pending review comments (the admin's highlight feedback returned by read_project_doc) - a single write clears the whole review, so capture every comment in your context before the first write; (2) docs are revisioned - every content-changing write records a revision, so many partial writes bury the history in noise. Pass a `changelog` summarizing what changed in this write and why - it becomes that revision's entry in the document's history; keep update/changelog logs OUT of the document body and put them in `changelog` instead. Also pass a `description`: an overall summary of what the doc is and when to read it, in no more than one or two sentences, shown next to the filename in the Documents list and the doc header so teammates and future runs can tell what the doc is at a glance. Describe the doc's stable purpose, NOT its current contents: do not list its sections, findings, dates, counts, or latest revisions (those live in the body and the `changelog`), so the description stays steady across updates. Keep it short and out of the body. Non-markdown files (mockups, wireframes, images, PDFs) live in the project assets library instead - reference those as `assets/<filename>`. In content, reference teammates with @<agent-slug>. Reference tasks and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug - no @ prefix. Do not wrap any of these in backticks - that makes them inert.",
		{
			project: projectArg(),
			filename: z.string().describe('Markdown filename to write (e.g. "spec.md")'),
			content: z.string().describe('File content (markdown)'),
			description: z
				.string()
				.optional()
				.describe(
					'An overall summary of what this doc is and when to read it, in no more than one or two sentences (e.g. "How we track and report campaign analytics each week"). Describe its stable purpose, not its current contents: do NOT list the sections, findings, dates, counts, or latest revisions here (those belong in the body and the `changelog`), so the description stays steady across updates. Shown next to the filename in the Documents list and the doc header so teammates and future runs can tell what the doc is without opening it. It is NOT the changelog and NOT part of the body. Omit to leave any existing description unchanged.',
				),
			changelog: z
				.string()
				.optional()
				.describe(
					"Markdown summary of what changed in THIS update and why - recorded as the revision's changelog and shown in the document's revision history. Put update/status notes here, never in the document body. Reference tasks/docs/agents by bare identifier as in content.",
				),
			content_length: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe(
					'The exact character count of `content`. When provided, a mismatch is rejected instead of stored, so an argument the runtime truncated mid-stream cannot silently overwrite the doc with a partial body (which would also delete every pending review comment on it). Strongly recommended for anything large.',
				),
			allow_empty: z
				.boolean()
				.optional()
				.describe(
					'Permit an empty `content` to blank an existing non-empty doc. Off by default, because an empty body is far more often a truncated argument than an intent - and blanking also deletes every pending review comment. To retire a doc, call archive_project_doc instead.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const filename = args.filename as string;
			if (!isMarkdownDocSlug(filename)) {
				return {
					error:
						'Project docs must be markdown (.md). Non-markdown files belong in the assets library, referenced as assets/<filename>.',
				};
			}
			const content = args.content as string;
			// A runtime can cap tool-call argument size and cut `content` mid-stream.
			// The asset writer already defends against exactly this; docs did not, so
			// a truncated body was stored silently - and, because a content-changing
			// write wipes the doc's pending review comments, it destroyed the admin's
			// feedback on the way past. Check before anything is written.
			const declaredLength = args.content_length as number | undefined;
			if (declaredLength !== undefined && content.length !== declaredLength) {
				return {
					error: `\`content\` arrived as ${content.length} characters but content_length=${declaredLength} was declared - the argument was truncated in transit (a runtime can cap the tool-call argument size, cutting \`content\` mid-stream). Nothing was written. Retry, and for a large doc prefer edit_project_doc, which sends only the span you are changing.`,
				};
			}
			const docScope = {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: filename,
			} as const;
			if (content.trim() === '' && args.allow_empty !== true) {
				const prior = await getDocument(db, docScope);
				if (prior && prior.content.trim() !== '') {
					return {
						error: `Refusing to blank '${filename}' (currently ${prior.content.length} characters) with empty content - that would also delete every pending review comment on it. An empty body is usually a truncated argument rather than an intent. If you really mean to empty it, pass allow_empty: true; if you mean to retire it, call archive_project_doc.`,
					};
				}
			}
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const callerApiKeyId = apiKeyIdFromAuth(auth);
			const doc = await upsertDocument(db, wsManager, {
				scope: docScope,
				content,
				description: args.description as string | undefined,
				changeSummary: args.changelog as string | undefined,
				authorMemberId: callerMemberId,
				authorApiKeyId: callerApiKeyId,
				audit: {
					events,
					actorType: actorTypeFromAuth(auth),
					actorApiKeyId: callerApiKeyId,
				},
			});
			// An archived doc is read-only; writing would silently resurrect it. The
			// refusal comes from upsertDocument itself, so no caller can forget it.
			if (doc.status === 'archived') {
				return {
					error: `Doc '${filename}' is archived - call unarchive_project_doc first, or write under a different filename.`,
				};
			}
			// `content_length` back out so the caller can compare against what it
			// sent without a re-read - the same check `content_length` performs on
			// the way in, available even when that argument was omitted.
			return {
				written: true,
				id: doc.row.id,
				filename: doc.row.slug,
				content_length: doc.row.content.length,
				...changelogNotRecordedWarning(args.changelog, doc.changelogRecorded),
			};
		},
		db,
		{ write: true },
	);

	// `edit_` rather than `update_`: the REST/MCP verb table maps PATCH to
	// `update_`, but the project-doc family already reads `read_`/`write_`, and
	// `edit_project_doc` sits with those far more legibly than `update_` would.
	// The resource noun still matches its REST route exactly, which is the half
	// of the naming rule that actually has to hold.
	tool(
		server,
		'edit_project_doc',
		"Replace one span of a project doc, leaving the rest untouched. Prefer this over write_project_doc for any change to an existing doc: it sends only the text you are changing, so the argument stays proportional to the edit rather than to the document, which keeps a large doc out of reach of a runtime's tool-call argument-size cap. These docs live in the database, not the filesystem - the Write/Edit file tools target disk and will not touch them. `old_string` must match the current text EXACTLY, including indentation and line breaks: read the doc first and copy the span verbatim rather than retyping it. It must also be unique - if it matches several places the call is refused, so extend it with surrounding lines until it is unique, or pass replace_all to change every match. The result returns the applied hunk with surrounding context plus the doc's new `content_length`, so you can confirm what landed without reading the doc again. Like any content-changing write this records a revision and clears the doc's pending review comments, so capture those first.",
		{
			project: projectArg(),
			filename: z.string().describe('Markdown filename to edit (e.g. "spec.md")'),
			old_string: z
				.string()
				.describe(
					'The exact text to replace, copied verbatim from the doc (including indentation and line breaks). Must be unique in the doc unless replace_all is set.',
				),
			new_string: z
				.string()
				.describe('The text to put in its place. May be empty to delete the span.'),
			replace_all: z
				.boolean()
				.optional()
				.describe(
					'Replace every occurrence of `old_string` rather than requiring it to be unique. Use for a rename that legitimately recurs; otherwise prefer extending `old_string` so the edit is unambiguous.',
				),
			changelog: z
				.string()
				.optional()
				.describe(
					"Markdown summary of what changed in THIS edit and why - recorded as the revision's changelog. Put update/status notes here, never in the document body.",
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const filename = args.filename as string;
			const docScope = {
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: filename,
			} as const;
			const prior = await getDocument(db, docScope);
			if (!prior) {
				return {
					error: `Doc '${filename}' not found. edit_project_doc changes an existing doc; create a new one with write_project_doc.`,
				};
			}
			if (prior.archived_at !== null) {
				return {
					error: `Doc '${filename}' is archived - call unarchive_project_doc first.`,
				};
			}
			const edited = applyStringEdit(
				prior.content,
				args.old_string as string,
				args.new_string as string,
				{
					replaceAll: args.replace_all === true,
				},
			);
			if (!edited.ok) return { error: edited.error };

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const callerApiKeyId = apiKeyIdFromAuth(auth);
			const doc = await upsertDocument(db, wsManager, {
				scope: docScope,
				content: edited.content,
				changeSummary: args.changelog as string | undefined,
				authorMemberId: callerMemberId,
				authorApiKeyId: callerApiKeyId,
				audit: {
					events,
					actorType: actorTypeFromAuth(auth),
					actorApiKeyId: callerApiKeyId,
				},
			});
			if (doc.status === 'archived') {
				return {
					error: `Doc '${filename}' is archived - call unarchive_project_doc first.`,
				};
			}
			return {
				edited: true,
				id: doc.row.id,
				filename: doc.row.slug,
				replacements: edited.replacements,
				content_length: doc.row.content.length,
				hunk: edited.hunk,
				...changelogNotRecordedWarning(args.changelog, doc.changelogRecorded),
			};
		},
		db,
		{ write: true },
	);

	// Archival is the agent-facing "delete" for project docs too: reversible,
	// self-serve, keeps the slug reserved and references resolving. Hard
	// deletion remains a human/admin-only UI action.
	const setDocArchivedTool = async (
		args: Record<string, unknown>,
		db: Db,
		auth: AuthInfo,
		archived: boolean,
	) => {
		const scope = await resolveScope(db, auth, args);
		if ('error' in scope) return scope;
		const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
		const result = await setDocumentArchived(
			db,
			wsManager,
			{
				type: DocumentType.ProjectDoc,
				teamId: scope.teamId,
				projectId: scope.projectId,
				slug: args.filename as string,
			},
			archived,
			callerMemberId,
			{
				events,
				actorType: actorTypeFromAuth(auth),
				actorApiKeyId: apiKeyIdFromAuth(auth),
				// Attribution: an agent restoring a doc so it can overwrite it is
				// exactly what the operator needs to trace back to a run.
				taskId: auth.type === AuthType.Agent ? auth.taskId : null,
				runId: auth.type === AuthType.Agent ? auth.runId : null,
			},
		);
		if (!result) return { error: `File '${args.filename}' not found` };
		return { archived, filename: result.row.slug, changed: result.changed };
	};

	tool(
		server,
		'archive_project_doc',
		'Archive a project doc - the reversible soft delete, and the ONLY way an agent retires a doc (hard deletion is admin-only, so treat any "delete this doc" instruction as archive). The doc disappears from list_project_docs, default reads, and future runs\' context, but keeps its filename reserved and its revision history; existing references keep resolving. Reverse with unarchive_project_doc. No approval needed.',
		{
			project: projectArg(),
			filename: z.string().describe('Doc filename to archive (e.g. "old-plan.md")'),
		},
		async (args, db, auth) => setDocArchivedTool(args, db, auth, true),
		db,
		{ write: true },
	);

	tool(
		server,
		'unarchive_project_doc',
		'Restore an archived project doc to active. It reappears in list_project_docs and agent-run context, and becomes readable and writable again with its content and revision history intact.',
		{
			project: projectArg(),
			filename: z.string().describe('Doc filename to restore (e.g. "old-plan.md")'),
		},
		async (args, db, auth) => setDocArchivedTool(args, db, auth, false),
		db,
		{ write: true },
	);

	tool(
		server,
		'update_chat_memory',
		"Replace a long-term chat memory - the durable notes carried into every turn of a live chat. Without `conversation` it is YOUR memory, carried into your operator DM; with `conversation` (a group room's conversation id, given to you by that room's compaction instructions) it is that room's shared memory instead. Pass the FULL revised markdown; it overwrites the stored memory wholesale (there is no append). Record durable, standing knowledge only: operator preferences, decisions, and a rough gist of off-project threads. Do NOT store live data you can re-fetch each turn (project/task/roster state). Memory is compacted automatically when the conversation window fills - you'll be handed the window and asked to fold it in via this tool - but you may also call it any time to record something standing.",
		{
			content: z.string().describe('The full long-term memory markdown (replaces existing memory)'),
			conversation: z
				.string()
				.optional()
				.describe(
					"Group room conversation id whose shared memory to replace. Omit for your own DM memory. Only a room you participate in; the room's compaction instructions carry the id.",
				),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent || !auth.memberId) {
				return {
					error: 'update_chat_memory can only be called by an agent updating its own memory',
				};
			}
			const conversationId = typeof args.conversation === 'string' ? args.conversation : null;
			if (conversationId && !isUuid(conversationId)) {
				return { error: 'conversation must be a conversation id (UUID)' };
			}
			if (conversationId) {
				// A room's shared memory is writable only by its own participants, in
				// the caller's own team - the same boundary its turns run under.
				const room = await db.query(
					`SELECT 1 FROM chat_conversations c
					 JOIN chat_conversation_participants p
					   ON p.conversation_id = c.id AND p.member_id = $2
					 JOIN members m ON m.id = $2
					 WHERE c.id = $1 AND c.kind = 'group' AND c.team_id = m.team_id`,
					[conversationId, auth.memberId],
				);
				if (!room.rows[0]) {
					return { error: 'conversation is not a group room you participate in' };
				}
			}
			let mem: Awaited<ReturnType<typeof upsertChatMemory>>;
			try {
				mem = conversationId
					? await upsertConversationChatMemory(db, conversationId, args.content as string)
					: await upsertChatMemory(db, auth.memberId, args.content as string);
			} catch (e) {
				// A dead-end refusal would wedge the chat, since compaction is what
				// drains the window — the message names the ceiling so the retry is a
				// shorter rewrite.
				if (e instanceof InjectedTextCapError) return { error: e.message };
				throw e;
			}
			return { written: true, updated_at: mem.updated_at };
		},
		db,
		{ write: true, audience: 'agent' },
	);

	// Skill proposals
	tool(
		server,
		'propose_skill',
		"Propose a new skill for the team's skills database (reusable team know-how: MCP server usage, integration steps, conventions, how agents coordinate). Creates an approval request; when approved the skill is written to the skills database. Choose `scope`: 'global' shares it with every project, 'project' keeps it private to this project. Defaults to 'project'.",
		{
			project: projectArg(),
			skill_name: z.string().describe('Human-readable skill name'),
			skill_slug: z.string().describe('URL-safe slug for the skill file'),
			content: z.string().describe('Skill content (markdown)'),
			reason: z.string().describe('Why this skill should be added'),
			scope: z
				.enum(['project', 'global'])
				.optional()
				.describe(
					"'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'.",
				),
		},
		async (args, db, auth) => {
			// `connector-recipes` is a reserved built-in virtual skill — reject a
			// proposal that would shadow it.
			if (isConnectorRecipesSlug(args.skill_slug as string)) {
				return {
					error: `'${CONNECTOR_RECIPES_SLUG}' is a reserved built-in skill and cannot be proposed`,
				};
			}
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const teamId = scope.teamId;
			const result = await db.query<Record<string, unknown>>(
				`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
				 VALUES ($1, $2::approval_type, $3, $4::jsonb)
				 RETURNING ${APPROVAL_COLUMNS}`,
				[
					teamId,
					ApprovalType.SkillProposal,
					callerMemberId,
					JSON.stringify({
						skill_name: args.skill_name,
						skill_slug: args.skill_slug,
						content: args.content,
						reason: args.reason,
						scope: args.scope === 'global' ? 'global' : 'project',
					}),
				],
			);
			const row = result.rows[0];
			if (row) {
				broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			}
			return { approval_id: row?.id, status: row?.status };
		},
		db,
		{ write: true },
	);

	// Full-text search
	tool(
		server,
		'full_text_search',
		'Full-text keyword search across the team skills database, tasks, project docs, task comments, and project assets. Returns results ranked by relevance (keyword + stemming match). A bare task number or full identifier (e.g. "169" or "HM-169") resolves directly to that task, ranked first. Assets match on their library path, folders included, so any segment of "launch/hero-image.png" finds it; textual assets (.md, .txt, .html, .svg, and the script/data formats stored as plain text such as .py, .js, .json, .csv, .yaml) also match on their content, while binary ones (images, PDFs, media, archives) match on path alone. Use it to find work product an earlier run produced before rebuilding it; an asset hit returns its path, which you pass to read_project_asset. An asset saved before this search existed matches on path until it is next written. Archived items are excluded.',
		{
			project: projectArg(),
			query: z.string().describe('Search query (keywords)'),
			scope: z
				.enum(SEARCH_SCOPES)
				.optional()
				.describe('Limit search to specific content type (default: all)'),
			limit: z.number().optional().describe('Max results per type (default: 10)'),
		},
		async (args, db, auth) => {
			const projectScope = await resolveScope(db, auth, args);
			if ('error' in projectScope) return projectScope;

			const { fullTextSearch } = await import('../services/search');
			const results = await fullTextSearch(db, [projectScope.teamId], args.query as string, {
				scope: (args.scope as SearchScope) ?? 'all',
				limit: (args.limit as number) ?? 10,
			});

			return { results, count: results.length };
		},
		db,
	);

	// Skills - DB-backed CRUD
	tool(
		server,
		'list_skills',
		`List the team's skills database - the manifest of reusable team know-how (MCP server usage, integration steps, conventions, how agents coordinate). Returns each skill's name, slug, and description; call get_skill to load a skill's full body on demand. Paged: returns \`limit\` entries (default ${DEFAULT_LIST_LIMIT}) plus \`next_cursor\`/\`has_more\`; when \`has_more\` is true, call again with \`cursor\` set to \`next_cursor\` until it is false.`,
		{
			project: projectArg(),
			tags: z.string().optional().describe('Filter by tag (comma-separated)'),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			// This project's own skills plus globals (project shadows a global of
			// the same slug — de-duped below).
			let query = `SELECT id, name, slug, description, tags, project_id, created_at, updated_at
			             FROM skills WHERE is_active = true AND (project_id = $1 OR project_id IS NULL)`;
			const params: unknown[] = [scope.projectId];

			if (args.tags) {
				const tagList = (args.tags as string).split(',').map((t) => t.trim());
				query += ` AND tags ?| $${params.length + 1}`;
				params.push(tagList);
			}

			// Project row before global so the de-dupe keeps the project's shadowing copy.
			query += ' ORDER BY name, project_id NULLS LAST';
			const result = await db.query<ListRow & { slug: string }>(query, params);
			const seen = new Set<string>();
			// De-dupe must run over the whole set before paging: shadowed globals are
			// dropped here, so slicing first would leave short pages and could hide a
			// project skill behind the global it shadows.
			const skills = result.rows.filter((r) => {
				if (seen.has(r.slug)) return false;
				seen.add(r.slug);
				return true;
			});
			const limit = parseListLimit(args.limit);
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? skills.findIndex((s) => s.id === cursor.id) + 1 : 0;
			return pagedList(skills.slice(from, from + limit + 1), limit, 'list_skills', {
				column: 'name',
			});
		},
		db,
	);

	tool(
		server,
		'get_skill',
		"Load the full body of a skill from the team's skills database by slug. Use after list_skills surfaces a relevant skill in the manifest.",
		{
			project: projectArg(),
			slug: z.string().describe('Skill slug'),
		},
		async (args, db, auth) => {
			// The built-in `connector-recipes` skill is generated from the connector
			// registry, not a DB row — return it directly (no scope needed; it is a
			// global read-only guide).
			if (args.slug === CONNECTOR_RECIPES_SLUG) {
				const s = buildConnectorRecipesSkill();
				return { name: s.name, slug: s.slug, description: s.description, content: s.content };
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			// Prefer this project's own skill over a global one of the same slug.
			const result = await db.query(
				`SELECT ${SKILL_COLUMNS} FROM skills
				 WHERE slug = $1 AND (project_id = $2 OR project_id IS NULL)
				 ORDER BY project_id NULLS LAST LIMIT 1`,
				[args.slug, scope.projectId],
			);
			if (result.rows.length === 0) return { error: 'Skill not found' };
			return result.rows[0];
		},
		db,
	);

	tool(
		server,
		'create_skill',
		"Add or update a skill in the team's skills database directly (no approval needed) - record reusable team know-how such as MCP server usage, integration steps, conventions, and how agents coordinate. Use propose_skill when approval is required. If description is omitted it is derived from the skill body. Choose `scope` deliberately: 'global' when the know-how helps agents in ANY project (related or not), 'project' when it is specific to this project. Omitting scope defaults to 'project'.",
		{
			project: projectArg(),
			name: z.string().describe('Human-readable skill name'),
			slug: z.string().describe('URL-safe slug'),
			content: z.string().describe('Skill content (markdown)'),
			description: z.string().optional().describe('Short description'),
			tags: z.string().optional().describe('Comma-separated tags'),
			scope: z
				.enum(['project', 'global'])
				.optional()
				.describe(
					"'global' shares the skill with every project; 'project' keeps it private to this project. Defaults to 'project'.",
				),
		},
		async (args, db, auth) => {
			// `connector-recipes` is a reserved built-in virtual skill (generated from
			// the connector registry) — an agent may read it but not shadow it.
			if (isConnectorRecipesSlug(args.slug as string)) {
				return {
					error: `'${CONNECTOR_RECIPES_SLUG}' is a reserved built-in skill and cannot be created or overwritten`,
				};
			}

			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;

			// The agent chooses the scope; absent a choice we keep it project-private.
			const targetProjectId = args.scope === 'global' ? null : scope.projectId;
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256')
				.update(args.content as string)
				.digest('hex');
			const tagList = args.tags ? (args.tags as string).split(',').map((t) => t.trim()) : [];
			// Backfill the manifest description from the body when omitted, so the
			// per-run skills manifest always has a usable one-line summary.
			const description =
				(args.description as string)?.trim() || deriveSkillSummary(args.content as string);

			const priorSkill = await db.query<{ content: string }>(
				'SELECT content FROM skills WHERE slug = $1 AND project_id IS NOT DISTINCT FROM $2',
				[args.slug, targetProjectId],
			);

			// Upsert against the partial unique index matching the chosen scope.
			const conflictTarget = targetProjectId
				? '(project_id, slug) WHERE project_id IS NOT NULL'
				: '(slug) WHERE project_id IS NULL';
			const result = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (name, slug, description, content, content_hash, created_by_member_id, tags, project_id)
				 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
				 ON CONFLICT ${conflictTarget} DO UPDATE SET
				   content = EXCLUDED.content,
				   content_hash = EXCLUDED.content_hash,
				   description = EXCLUDED.description,
				   tags = EXCLUDED.tags,
				   updated_at = now()
				 RETURNING id, slug`,
				[
					args.name,
					args.slug,
					description,
					args.content,
					contentHash,
					callerMemberId,
					JSON.stringify(tagList),
					targetProjectId,
				],
			);

			const skillId = result.rows[0].id;
			await recordSkillRevisionIfChanged(
				db,
				skillId,
				priorSkill.rows[0]?.content ?? null,
				args.content as string,
				'Updated via MCP',
				callerMemberId,
			);

			return {
				skill_id: skillId,
				slug: result.rows[0].slug,
				scope: targetProjectId ? 'project' : 'global',
				created: true,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'list_connectors',
		'List the connectors available to agent runs in your project (its own connectors plus global "all projects" ones; a project connector shadows a global one of the same name). Each row includes a derived `oauth_status` so you can tell whether a connector is usable: "active" means it is credentialed and connected, or Hezo probed the server and it answered with no credential needed, so its MCP tools should appear in your tool list on your next run; "degraded" means it WAS connected and its stored token has stopped working (the grant expired or was revoked - see auth_error), so its tools may still be listed but calls through them fail, and only the human can fix it by reconnecting; "pending" means it cannot reach a run yet, either waiting on the human to click Connect or waiting on a probe that has not yet found the server answering without a credential; "failed" means the connect attempt errored before it ever connected (see auth_error); "revoked" means a human disconnected it; "none" means the row is not a hosted MCP server at all (a local stdio server, or an `api` REST connector), so it has no OAuth story to report. A "degraded" connector is not a Hezo bug and not something to retry around silently - report it to the human with an active @admin comment naming the connector and asking them to reconnect it. Two fields carry the probe evidence behind a hosted row: `probed_at` is when Hezo last checked the server, and `probe_error` is why that check failed ("auth_required" when the server demanded a credential Hezo does not have, "unreachable" when it did not answer), or null when it completed the MCP handshake. A connector whose auth rides a __HEZO_SECRET_<NAME>__ header is exempt: the egress proxy substitutes that at request time, which a server-side probe cannot reproduce, so it reads "active" with no probe needed. Do NOT confuse `install_status` (which tracks local-package install state and is meaningless for SaaS MCPs) with `oauth_status`. An active OAuth-backed connector also carries `rest_auth` = `{ placeholder, allowed_hosts, scopes }`: put `placeholder` (e.g. in an `Authorization: Bearer <placeholder>` header) on a raw HTTP request to authenticate the provider\'s REST API directly when no MCP tool covers what you need - the egress proxy substitutes the real token, but ONLY for requests to `allowed_hosts`; you never see the value. Use this instead of requesting a PAT (e.g. for GitHub repo-settings edits that the `github` MCP does not expose). A connector of kind `api` (a credentialed REST API with no MCP server) carries `api_auth` = `{ base_url, placeholder, allowed_hosts, placement, name, docs_url }` instead: put `placeholder` in the `name` header (when `placement` is "header", prefixed by any scheme) or `name` query parameter (when `placement` is "query") and send the request to `base_url` - the egress proxy substitutes the real key, scoped to `allowed_hosts`. `placeholder` is null until a human attaches the credential on the Connectors page; `api_auth` is null for non-api rows. An `api` connector may instead be OAuth-backed (a human connected it via the device flow): then `api_auth.placeholder` is a broker-managed OAuth access token that Hezo keeps refreshed host-side - use it exactly the same way.',
		{
			project: projectArg(),
			...listPagingArgs(),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			// What this run's runtime actually handed the model, per server. A
			// connector's status says the session came up, not that its tools arrived,
			// and that gap is what let an agent report a connector as toolless with
			// nothing able to confirm or refute it. Null outside an agent run (a CEO
			// chat principal carries no runId) and on runtimes that report no tool
			// list, which stays distinct from a recorded zero.
			const runToolCounts =
				auth.type === AuthType.Agent && auth.runId
					? ((
							await db.query<{ mcp_tool_counts: Record<string, number> | null }>(
								`SELECT mcp_tool_counts FROM heartbeat_runs WHERE id = $1`,
								[auth.runId],
							)
						).rows[0]?.mcp_tool_counts ?? null)
					: null;
			const r = await db.query<{
				id: string;
				name: string;
				display_name: string | null;
				kind: string;
				config: Record<string, unknown>;
				oauth_connection_id: string | null;
				api_key_secret_id: string | null;
				install_status: string;
				install_error: string | null;
				skill_id: string | null;
				created_by_task_id: string | null;
				activated_at: string | null;
				revoked_at: string | null;
				auth_error: string | null;
				probed_at: string | null;
				probe_error: string | null;
				created_at: string;
				updated_at: string;
				oauth_secret_name: string | null;
				oauth_allowed_hosts: string[] | null;
				oauth_scopes: string[] | null;
				oauth_account_label: string | null;
				api_key_secret_name: string | null;
				enabled_methods: string[] | null;
				discovered_methods: McpMethodInfo[] | null;
			}>(
				`SELECT mc.id, mc.name, mc.display_name, mc.kind::text AS kind,
				        mc.config, mc.oauth_connection_id, mc.api_key_secret_id,
				        mc.install_status::text AS install_status, mc.install_error,
				        mc.skill_id, mc.created_by_task_id,
				        mc.activated_at::text AS activated_at, mc.revoked_at::text AS revoked_at, mc.auth_error,
				        mc.probed_at::text AS probed_at, mc.probe_error::text AS probe_error,
				        mc.enabled_methods, mc.discovered_methods,
				        mc.created_at::text, mc.updated_at::text,
				        s.name AS oauth_secret_name, s.allowed_hosts AS oauth_allowed_hosts, oc.scopes AS oauth_scopes,
				        oc.provider_account_label AS oauth_account_label,
				        aks.name AS api_key_secret_name
				 FROM mcp_connections mc
				 LEFT JOIN oauth_connections oc ON oc.id = mc.oauth_connection_id
				 LEFT JOIN secrets s ON s.id = oc.access_token_secret_id
				 LEFT JOIN secrets aks ON aks.id = mc.api_key_secret_id
				 WHERE mc.project_id = $1 OR mc.project_id IS NULL
				 ORDER BY mc.name ASC, (mc.project_id IS NULL) ASC`,
				[scope.projectId],
			);
			// A project connector shadows a global one of the same name (the run sees
			// the same set — see loadConnectorsForRun). Rows are ordered project
			// first, so keep the first occurrence per name.
			const byName = new Map<string, (typeof r.rows)[number]>();
			for (const row of r.rows) if (!byName.has(row.name)) byName.set(row.name, row);
			// Which git remotes ride each connector's OAuth connection. Same field the
			// Connectors page gets - an agent that can see this understands why
			// remove_connector refuses before it tries, instead of reading the refusal
			// as a Hezo fault. One batched query, not one per row.
			const { linkedReposByConnection } = await import('../services/connectors/lifecycle');
			const linkedRepos = await linkedReposByConnection(
				db,
				[...byName.values()]
					.map((row) => row.oauth_connection_id)
					.filter((id): id is string => id !== null),
				// The run's own team. A global connector is visible from every project
				// on the instance, so an unscoped read would hand an agent the repo
				// identifiers and project names of teams its JWT cannot reach.
				scope.teamId,
			);
			const connectors = [...byName.values()].map((row) => {
				// oauth_status is the load-bearing signal for whether the connector is
				// usable by agents on subsequent runs. Derived by the shared ladder so
				// it cannot drift from what the operator sees on the Connections page.
				const oauth_status = connectorOAuthStatus(row);

				// An active OAuth-backed connector can also authenticate raw REST calls
				// to the provider's API: expose the secret's placeholder (never its
				// value) plus the hosts the egress proxy will substitute it for, so an
				// agent can hit endpoints the MCP server doesn't cover without ever
				// requesting a PAT. Omitted unless the token is scoped to at least one
				// host, since an unscoped secret can never be substituted.
				const {
					oauth_secret_name,
					oauth_allowed_hosts,
					oauth_scopes,
					api_key_secret_name,
					enabled_methods,
					discovered_methods,
					...rest
				} = row;
				// `degraded` keeps its rest_auth block: the placeholder and host scoping
				// are unchanged facts about the credential, and dropping them would make
				// the REST fallback vanish mid-task with no explanation. oauth_status
				// alone carries the news that the token needs reconnecting.
				const rest_auth =
					(oauth_status === ConnectorStatus.Active || oauth_status === ConnectorStatus.Degraded) &&
					oauth_secret_name &&
					(oauth_allowed_hosts?.length ?? 0) > 0
						? {
								placeholder: credentialPlaceholder(oauth_secret_name),
								allowed_hosts: oauth_allowed_hosts ?? [],
								scopes: oauth_scopes ?? [],
							}
						: null;

				// For an `api` connector (a direct REST API, no MCP server), surface how
				// to call it: base_url + auth placement/name, and — once a credential is
				// attached — the `__HEZO_SECRET_*__` placeholder to put in that
				// header/query. The agent hits base_url directly and the egress proxy
				// substitutes the real key, scoped to allowed_hosts. Null placeholder
				// until a key is attached; the whole block is null for non-api rows.
				const apiCfg = row.config as {
					base_url?: unknown;
					allowed_hosts?: unknown;
					auth?: { placement?: unknown; name?: unknown };
					docs_url?: unknown;
				} | null;
				const api_auth =
					row.kind === 'api' && apiCfg
						? {
								base_url: typeof apiCfg.base_url === 'string' ? apiCfg.base_url : null,
								// An api connector may be OAuth-backed (broker-managed): its access
								// token rides the same api_auth placeholder as a pasted key, so
								// surface the OAuth access-token secret name when no pasted key is set.
								placeholder: api_key_secret_name
									? credentialPlaceholder(api_key_secret_name)
									: oauth_secret_name
										? credentialPlaceholder(oauth_secret_name)
										: null,
								allowed_hosts: Array.isArray(apiCfg.allowed_hosts) ? apiCfg.allowed_hosts : [],
								placement:
									apiCfg.auth && typeof apiCfg.auth.placement === 'string'
										? apiCfg.auth.placement
										: null,
								name: apiCfg.auth && typeof apiCfg.auth.name === 'string' ? apiCfg.auth.name : null,
								docs_url: typeof apiCfg.docs_url === 'string' ? apiCfg.docs_url : null,
							}
						: null;

				// Withheld methods simply don't appear in a run's tool list, so without
				// this an agent burns a run hunting a tool that "should" exist. Say up
				// front that the gap is deliberate and how wide it is.
				const method_access =
					row.kind === 'saas' && (discovered_methods?.length ?? 0) > 0
						? summarizeMethodAccess(discovered_methods ?? [], enabled_methods)
						: null;

				return {
					...rest,
					oauth_status,
					rest_auth,
					api_auth,
					method_access: method_access
						? {
								mode: method_access.mode,
								enabled: method_access.enabled,
								total: method_access.total,
								disabled_write: method_access.writeDisabled,
							}
						: null,
					// A number here is a fact about THIS run, not a guess: 0 means the
					// server connected and contributed nothing callable, which is worth
					// reporting to the human. Null means nobody measured it.
					tools_this_run: runToolCounts ? (runToolCounts[row.name] ?? null) : null,
					linked_repos: row.oauth_connection_id
						? (linkedRepos.get(row.oauth_connection_id) ?? [])
						: [],
				};
			});
			// Shadowed duplicates are dropped above, so page the de-duped set.
			const limit = parseListLimit(args.limit);
			const cursor = decodeCursor(args.cursor as string | undefined);
			const from = cursor ? connectors.findIndex((c) => c.id === cursor.id) + 1 : 0;
			return pagedList(
				connectors.slice(from, from + limit + 1) as unknown as ListRow[],
				limit,
				'list_connectors',
			);
		},
		db,
	);

	tool(
		server,
		'test_connector',
		'Test an MCP connector end-to-end from the server side. Resolves the stored OAuth token from the vault and makes a direct HTTP call to the MCP server. Returns the upstream status code, a response excerpt, the secret name used, and whether a token was attached - never the token or any part of it. Use this when oauth_status says "active" but the MCP\'s tools are absent from your tool list - it isolates "is the token still valid against the provider?" from "does the proxy chain in the container work?". A 401 here means the stored credential is no longer accepted: report it to the human with an active @admin comment asking them to reconnect the connector. You do not need this call when oauth_status already says "degraded" - that answer is known.',
		{
			project: projectArg(),
			connector_id: z.string().describe('connector id or name (both shown by list_connectors)'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const connectorId = args.connector_id as string;

			const row = await db.query<{
				id: string;
				name: string;
				kind: string;
				config: Record<string, unknown>;
				oauth_connection_id: string | null;
			}>(
				`SELECT id, name, kind::text AS kind, config, oauth_connection_id
				 FROM mcp_connections
				 WHERE (id::text = $1 OR name = $1) AND (project_id = $2 OR project_id IS NULL)
					 ORDER BY (project_id IS NOT NULL) DESC
					 LIMIT 1`,
				[connectorId, scope.projectId],
			);
			if (row.rows.length === 0) return { error: 'connector not found' };
			const connector = row.rows[0];
			if (connector.kind !== 'saas') {
				return { error: `connector kind=${connector.kind}; test only meaningful for kind=saas` };
			}
			const config = connector.config as { url?: string };
			if (!config.url) return { error: 'connector has no mcp url' };

			let bearerToken: string | null = null;
			let secretName: string | null = null;
			if (connector.oauth_connection_id) {
				const secret = await db.query<{ name: string; encrypted_value: string }>(
					`SELECT s.name, s.encrypted_value FROM oauth_connections oc
					 JOIN secrets s ON s.id = oc.access_token_secret_id
					 WHERE oc.id = $1`,
					[connector.oauth_connection_id],
				);
				if (secret.rows.length === 0) {
					return {
						error:
							'oauth_connection_id is set but no matching secret row found - vault is corrupted for this connector',
						connector_id: connector.id,
						oauth_connection_id: connector.oauth_connection_id,
					};
				}
				const key = masterKeyManager.getKey();
				if (!key) return { error: 'master key is locked; cannot decrypt secret to test' };
				const { decrypt } = await import('../crypto/encryption');
				try {
					bearerToken = decrypt(secret.rows[0].encrypted_value, key);
				} catch (e) {
					return {
						error: `failed to decrypt stored token: ${(e as Error).message}`,
						secret_name: secret.rows[0].name,
					};
				}
				secretName = secret.rows[0].name;
			}

			const headers: Record<string, string> = { Accept: 'application/json' };
			if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

			let probeRes: Response;
			try {
				probeRes = await fetch(config.url, { method: 'GET', headers });
			} catch (e) {
				return {
					ok: false,
					error: `network probe failed: ${(e as Error).message}`,
					mcp_url: config.url,
					secret_name: secretName,
					token_sent: bearerToken !== null,
				};
			}
			const bodyText = await probeRes.text().catch(() => '');
			const wwwAuth = probeRes.headers.get('WWW-Authenticate') ?? null;
			// The upstream may reflect the credential we just sent it (an echo route,
			// or an error quoting the Authorization header). This response crosses the
			// agent boundary, so scrub the token out of anything we relay. Nothing
			// derived from the token value itself is returned either — a prefix plus an
			// exact length is a partial credential disclosure, and the diagnostic
			// question ("was a token attached?") is answered by `token_sent`.
			const redact = (s: string): string =>
				bearerToken ? s.split(bearerToken).join('[redacted]') : s;
			// The probe just learned first-hand whether the stored credential is
			// still accepted. Record it so that knowledge reaches the operator's
			// banner and the card's reconnect button instead of living only in this
			// tool result, where the previous incident left it: an agent saw the
			// 401, wrote it into a report as a "known gap", and the connector stayed
			// broken for days. Only meaningful when a token was actually sent.
			// A non-auth failure (a 500, a timeout) says nothing about the credential,
			// so it leaves whatever health is already recorded alone.
			const credentialVerdict =
				probeRes.status === 401 || probeRes.status === 403
					? `probe: HTTP ${probeRes.status}`
					: probeRes.ok
						? null
						: undefined;
			if (bearerToken && credentialVerdict !== undefined) {
				await setConnectorAuthError(
					{ db, masterKeyManager },
					connector.id,
					credentialVerdict,
				).catch(() => {});
			}

			return {
				ok: probeRes.ok,
				status: probeRes.status,
				mcp_url: config.url,
				secret_name: secretName,
				token_sent: bearerToken !== null,
				www_authenticate: redact(wwwAuth ?? '') || null,
				body_excerpt: redact(bodyText.slice(0, 400)),
				hint:
					probeRes.status === 401
						? bearerToken
							? 'Token rejected by upstream. Either the token expired, the scopes are insufficient, or the provider revoked it. Surface to the user; they may need to reconnect.'
							: 'No token sent (connector has no oauth_connection_id). OAuth never completed for this connector.'
						: probeRes.ok
							? "Token valid against upstream. If the MCP tools still don't appear in your tool list, the issue is in the container/proxy chain - file a bug with the launch-command headers and any audit_log entries for this host."
							: `Upstream returned ${probeRes.status}; check body_excerpt for details.`,
			};
		},
		db,
	);

	tool(
		server,
		'add_connector',
		'Register a connector for your project - a SaaS HTTP MCP server (`saas`), a local stdio MCP server (`local`), or a credentialed REST API you call directly with no MCP server (`api`). The connection is scoped to your project - available to this project\'s agent runs, alongside any global "all projects" connectors. Hezo checks a SaaS server at registration and hands it to agent runs only while it answers that check without a credential; the response tells you which happened in `reachable`, `probe` and `note`. A server that wants auth stays out of runs until a human connects it or attaches an API key. Header values may include __HEZO_SECRET_<NAME>__ placeholders that the egress proxy substitutes at request time; those count as the connector\'s credential, so a server authenticated that way reaches runs without needing to pass the check. Local servers must be installed before they take effect. An `api` connector has no MCP server: attach a credential to it (Connectors page → API key) and it surfaces in `list_connectors` as an `api_auth` block whose placeholder you put in the auth header/query and send to `base_url` directly - the egress proxy substitutes, scoped to `allowed_hosts`.',
		{
			project: projectArg(),
			name: z
				.string()
				.trim()
				.min(1, 'name is required')
				.describe('Server identifier - used as the MCP descriptor name and as the unique key.'),
			kind: z
				.enum(['saas', 'local', 'api'])
				.describe('saas = HTTP MCP, local = stdio MCP, api = direct REST API (no MCP server)'),
			config: z
				.record(z.string(), z.unknown())
				.describe(
					'For saas: { url, headers? }. For local: { command, args?, env?, package? }. For api: { base_url, allowed_hosts: string[], auth: { placement: "header"|"query", name, scheme? }, docs_url? }.',
				),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			// name non-empty enforced by the schema; kind is a schema enum.
			const name = (args.name as string).trim();
			const kind = args.kind as 'saas' | 'local' | 'api';
			let config = args.config as Record<string, unknown>;

			if (kind === 'saas') {
				if (!config?.url || typeof config.url !== 'string') {
					return { error: 'saas connections require config.url (string)' };
				}
			} else if (kind === 'api') {
				const validated = validateApiConnectorConfig(config);
				if (!validated.ok) return { error: validated.error };
				config = validated.config as unknown as Record<string, unknown>;
			} else {
				if (!config?.command || typeof config.command !== 'string') {
					return { error: 'local connections require config.command (string)' };
				}
			}

			// api behaves like saas for install state (nothing to install — it's a
			// direct REST call); only local needs an installer pass.
			const initialStatus = kind === 'local' ? 'pending' : 'installed';
			// A connector carrying a credential (a completed OAuth flow, or an
			// attached API key) may NOT be re-pointed by an agent. Without this the
			// upsert rewrote `config` — the destination URL — while leaving
			// `oauth_connection_id` attached, and `test_connector` would then resolve
			// that token and send it, in plaintext and off the egress proxy, to a host
			// the agent chose. Re-binding a credentialed connector is a widening of
			// access and stays human-only (Connectors page), like every other widening.
			//
			// The guard is the `WHERE` on the DO UPDATE rather than a preceding SELECT
			// so it is atomic: a check-then-upsert could be raced by a concurrent OAuth
			// completion. An unchanged re-registration still succeeds, so an agent
			// re-declaring a connector it already owns is a no-op, not an error.
			//
			// A re-point drops the probe evidence with the config it was gathered
			// against: a server proven public at one URL is not proven at another.
			const r = await db.query<{
				id: string;
				install_status: string;
			}>(
				`INSERT INTO mcp_connections (name, kind, config, install_status, project_id)
				 VALUES ($1, $2::mcp_connection_kind, $3::jsonb, $4::mcp_install_status, $5)
				 ON CONFLICT (project_id, name) WHERE project_id IS NOT NULL DO UPDATE
				 SET kind = EXCLUDED.kind,
				     config = EXCLUDED.config,
				     install_status = EXCLUDED.install_status,
				     install_error = NULL,
				     probed_at = NULL,
				     probe_error = NULL,
				     updated_at = now()
				 WHERE (mcp_connections.oauth_connection_id IS NULL
				        AND mcp_connections.api_key_secret_id IS NULL)
				    OR (mcp_connections.kind = EXCLUDED.kind
				        AND mcp_connections.config IS NOT DISTINCT FROM EXCLUDED.config)
				 RETURNING id, install_status::text AS install_status`,
				[name, kind, JSON.stringify(config), initialStatus, scope.projectId],
			);
			if (r.rows.length === 0) {
				// The DO UPDATE was suppressed: the row exists and is credentialed.
				const existing = await db.query<{ id: string; has_oauth: boolean }>(
					`SELECT id, oauth_connection_id IS NOT NULL AS has_oauth
					 FROM mcp_connections
					 WHERE project_id = $1 AND name = $2`,
					[scope.projectId, name],
				);
				return {
					error: `connector ${name} already exists and has a credential attached (${
						existing.rows[0]?.has_oauth ? 'OAuth connection' : 'API key'
					}); its configuration cannot be changed from here`,
					connector_id: existing.rows[0]?.id ?? null,
					hint: 'Re-pointing a credentialed connector is a human-only operation - ask an admin to change it on the Connectors page, or register a new connector under a different name.',
				};
			}
			if (kind !== 'saas') {
				return {
					id: r.rows[0].id,
					install_status: r.rows[0].install_status,
					reachable: null,
					probe: null,
					note:
						kind === 'local'
							? 'Local MCP registered with status pending. Install via the installer or container provision before agent runs can use it.'
							: 'API connector registered. Attach a credential (Connectors page → API key), then call list_connectors to get its api_auth placeholder + base_url.',
				};
			}
			// Hosted servers are checked here rather than assumed reachable. An
			// uncredentialed one that quietly demands auth used to be handed to every
			// run and fail its handshake inside the container, where nothing could
			// see it. Awaited: whether it answers decides whether it reaches a run,
			// so the agent that registered it learns that now.
			const { describeProbeVerdict, discoverConnectorMethods } = await import(
				'../services/connectors/method-discovery'
			);
			const verdict = describeProbeVerdict(
				await discoverConnectorMethods({ db, masterKeyManager }, r.rows[0].id, 'create'),
			);
			return {
				id: r.rows[0].id,
				install_status: r.rows[0].install_status,
				reachable: verdict.reachable,
				probe: verdict.probe,
				note: verdict.note,
			};
		},
		db,
		{ write: true },
	);

	tool(
		server,
		'remove_connector',
		"Remove one of your project's registered MCP connections. Only connectors owned by your project can be removed - global \"all projects\" connectors and other projects' are managed elsewhere. Refused when the connector's OAuth connection still authenticates a linked git repo anywhere on the instance: that returns an error naming what blocks it and changes nothing. If you reached for this because a connector's tools were missing, read the run log's `[runner] MCP connectors:` line and list_connectors first - removing the connector is not how a missing tool is fixed. Otherwise the next agent run will not see it.",
		{
			project: projectArg(),
			id: z
				.string()
				.describe('connector id or name (returned by add_connector or list_connectors)'),
		},
		async (args, db, auth) => {
			const scope = await resolveScope(db, auth, args);
			if ('error' in scope) return scope;
			const { deleteConnector } = await import('../services/connectors/lifecycle');
			// `guardLinkedRepos` refuses a connector whose OAuth connection still
			// authenticates a linked git remote ANYWHERE on the instance, not just in
			// this project - a shared connection's repos are exactly the ones a
			// project-scoped check would miss. Deleting it would not break git
			// (`repos.oauth_connection_id` survives) but every MCP tool it carried
			// would vanish from the next run. Removing a human-configured capability
			// that way is not the agent's call to make; the human paths are
			// unguarded, and their dialogs name the repos first.
			const outcome = await deleteConnector(db, args.id as string, {
				matchName: true,
				projectId: scope.projectId,
				guardLinkedRepos: true,
				// The guard counts every team's repos; only the naming is scoped.
				discloseTeamId: scope.teamId,
			});
			if (outcome.outcome === 'not_found') return { error: 'MCP connection not found' };
			if (outcome.outcome === 'backs_linked_repos') {
				// The count is instance-wide because the guard is; the names are only
				// the ones this team may be told about, and can be empty while the
				// refusal stands. Say so rather than printing an empty list, which
				// would read as the guard misfiring.
				const visible = outcome.repos.map((r) => r.repo_identifier);
				const named =
					visible.length > 0
						? ` (${visible.join(', ')})`
						: ' (none of them in your team, so they are not named here)';
				return {
					error: `connector ${outcome.name} still authenticates ${outcome.totalRepoCount} linked repo(s)${named}; removing it would leave git working but strip its MCP tools from every run`,
					connector_id: outcome.id,
					hint: 'Unlink the repo on the project Git page first if you really want this connector gone, or ask an admin to remove it on the Connectors page. If you were trying to fix missing tools, call list_connectors and read tools_this_run before removing anything.',
				};
			}
			// Both REST deletes record the removal in the audit log (the project route
			// also tells open tabs), and `register_connector` emits the matching
			// `mcp_connection.created`. This path emitted neither, so an
			// agent-initiated delete left no audit trail and no UI update - the row
			// simply vanished from a page on next refetch.
			events?.emit({
				type: 'mcp_connection.deleted',
				teamId: scope.teamId,
				actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
				actorMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
				connectionId: outcome.id,
				name: outcome.name,
			});
			broadcastConnectorRowChange(
				wsManager,
				{ teamId: scope.teamId, projectId: scope.projectId },
				'DELETE',
				{ id: outcome.id },
			);
			return { removed: true, id: outcome.id };
		},
		db,
		{ write: true },
	);

	return [...registeredTools];
}
