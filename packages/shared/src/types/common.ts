export const MemberType = { Agent: 'agent', User: 'user' } as const;
export type MemberType = (typeof MemberType)[keyof typeof MemberType];

export const AgentRuntime = {
	ClaudeCode: 'claude_code',
	Codex: 'codex',
	Gemini: 'gemini',
	OpenCode: 'opencode',
	Grok: 'grok',
} as const;
export type AgentRuntime = (typeof AgentRuntime)[keyof typeof AgentRuntime];

/**
 * Reasoning/thinking effort level applied to an individual agent run.
 *
 * Each runtime maps this to its native knob (Claude Code → "think" / "ultrathink"
 * prompt keywords, Codex → `model_reasoning_effort` CLI flag, etc.). See
 * `packages/server/src/services/effort.ts` for the concrete mappings.
 */
export const AgentEffort = {
	Minimal: 'minimal',
	Low: 'low',
	Medium: 'medium',
	High: 'high',
	Max: 'max',
} as const;
export type AgentEffort = (typeof AgentEffort)[keyof typeof AgentEffort];

export const EFFORT_ORDER: Record<AgentEffort, number> = {
	[AgentEffort.Minimal]: 0,
	[AgentEffort.Low]: 1,
	[AgentEffort.Medium]: 2,
	[AgentEffort.High]: 3,
	[AgentEffort.Max]: 4,
};

export const DEFAULT_EFFORT: AgentEffort = AgentEffort.Medium;

export function isAgentEffort(value: unknown): value is AgentEffort {
	return typeof value === 'string' && value in EFFORT_ORDER;
}

export const AgentRuntimeStatus = {
	Active: 'active',
	Idle: 'idle',
	/** Reactively paused because the agent breached one of its own daily/weekly/
	 *  monthly budget windows. Cleared automatically once the window rolls over.
	 *  (A human turning an agent off is `admin_status = 'disabled'`, a separate axis.) */
	OutOfAgentBudget: 'out_of_agent_budget',
	/** Reactively paused because the agent's project breached a budget window.
	 *  Cleared automatically once the project's window rolls over. */
	OutOfProjectBudget: 'out_of_project_budget',
} as const;
export type AgentRuntimeStatus = (typeof AgentRuntimeStatus)[keyof typeof AgentRuntimeStatus];

/** The runtime states an agent sits in while reactively paused for budget (vs a
 *  human-initiated `Paused`). Pausing and resuming for any of the three windows
 *  flows through these uniformly. */
export const BUDGET_PAUSE_STATUSES = [
	AgentRuntimeStatus.OutOfAgentBudget,
	AgentRuntimeStatus.OutOfProjectBudget,
] as const;

/** True when a runtime status is one of the budget-pause states. */
export function isBudgetPauseStatus(status: string): boolean {
	return (BUDGET_PAUSE_STATUSES as readonly string[]).includes(status);
}

export const AgentAdminStatus = {
	Enabled: 'enabled',
	Disabled: 'disabled',
} as const;
export type AgentAdminStatus = (typeof AgentAdminStatus)[keyof typeof AgentAdminStatus];

export const ContainerStatus = {
	Creating: 'creating',
	Running: 'running',
	Stopping: 'stopping',
	Stopped: 'stopped',
	Error: 'error',
} as const;
export type ContainerStatus = (typeof ContainerStatus)[keyof typeof ContainerStatus];

/**
 * Lifecycle of a base-image (`docker build`) job. The image is shared across
 * every project, so its build is tracked globally — independent of any single
 * project's `container_status` — and surfaced as a progress bar while a
 * container waits on it. `Done`/`Error` are terminal and clear the indicator.
 */
export const ImageBuildStatus = {
	Building: 'building',
	Done: 'done',
	Error: 'error',
} as const;
export type ImageBuildStatus = (typeof ImageBuildStatus)[keyof typeof ImageBuildStatus];

export const TaskStatus = {
	Backlog: 'backlog',
	InProgress: 'in_progress',
	Review: 'review',
	Blocked: 'blocked',
	Done: 'done',
	Cancelled: 'cancelled',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
	[TaskStatus.Backlog]: 'Backlog',
	[TaskStatus.InProgress]: 'In Progress',
	[TaskStatus.Review]: 'Review',
	[TaskStatus.Blocked]: 'Blocked',
	[TaskStatus.Done]: 'Done',
	[TaskStatus.Cancelled]: 'Cancelled',
};

export function formatTaskStatus(status: string): string {
	return TASK_STATUS_LABELS[status as TaskStatus] ?? status;
}

export const TaskPriority = {
	Urgent: 'urgent',
	High: 'high',
	Medium: 'medium',
	Low: 'low',
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const CommentContentType = {
	Text: 'text',
	Preview: 'preview',
	System: 'system',
	Run: 'run',
	Action: 'action',
	CredentialRequest: 'credential_request',
	ConnectRequired: 'connect_required',
	AssetDeletionRequest: 'asset_deletion_request',
} as const;
export type CommentContentType = (typeof CommentContentType)[keyof typeof CommentContentType];

/**
 * Full-text search. `SEARCH_SCOPES` is the single source of truth shared by the
 * server `fullTextSearch` service, the REST/MCP search surfaces, and the web
 * command palette. `SearchResult` carries navigation hints so a cross-project hit
 * can be linked to its underlying page.
 */
export const SEARCH_SCOPES = ['all', 'tasks', 'skills', 'project_docs', 'comments'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_RESULT_TYPES = ['task', 'skill', 'project_doc', 'comment'] as const;
export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

/**
 * Marks the start/end of a matched term inside `SearchResult.snippet`. The server
 * wraps each highlighted span in this sentinel and the web palette splits on it to
 * render `<mark>` (never via `dangerouslySetInnerHTML`). NUL is used because
 * Postgres `text`/`jsonb` reject NUL bytes on insert, so the indexed corpus can
 * never contain it — the marker is collision-free by construction, and it
 * round-trips cleanly through JSON.
 */
export const HIGHLIGHT_SENTINEL = '\u0000';

export interface SearchResult {
	type: SearchResultType;
	id: string;
	title: string;
	snippet: string;
	score: number;
	/** Project slug for the destination route (tasks, comments, project docs). */
	projectSlug?: string;
	/** Friendly task identifier, e.g. `TO-4` (tasks and comments). */
	taskIdentifier?: string;
	/** Comment `public_id` for the `#comment-<id>` deep-link hash (comments). */
	commentPublicId?: string;
	/** Document slug/filename for the documents route (project docs). */
	docSlug?: string;
}

/**
 * Exit code the server (worker) uses to tell its supervisor "swap in the staged
 * binary and relaunch me" rather than exit for good. Any other exit code is
 * propagated by the supervisor so existing restart policies behave as before.
 * 75 = EX_TEMPFAIL in sysexits(3), chosen to avoid clashing with 0/1/2.
 */
export const UPDATE_RESTART_EXIT_CODE = 75;

/** Lifecycle of a staged self-update, surfaced by `GET /updates/status`. */
export const UpdateState = {
	Idle: 'idle',
	Checking: 'checking',
	Downloading: 'downloading',
	Staged: 'staged',
	Applying: 'applying',
	Error: 'error',
} as const;
export type UpdateState = (typeof UpdateState)[keyof typeof UpdateState];

/**
 * Docker label stamped on agent containers provisioned during a test run. The test
 * harness scopes its container cleanup to this label so it only ever removes
 * test-spawned containers — never a developer's running dev-server containers, which
 * share the same `hezo-<slug>-…` name prefix. The provisioner applies the label when
 * TEST_CONTAINERS_ENV is set in its environment.
 */
export const TEST_CONTAINER_LABEL_KEY = 'hezo.test';
export const TEST_CONTAINER_LABEL_VALUE = '1';
export const TEST_CONTAINERS_ENV = 'HEZO_TEST_CONTAINERS';

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 3600;

// Project icons are normalized client-side to a square PNG no larger than
// PROJECT_ICON_MAX_DIMENSION on each side before upload; the server enforces
// both caps defensively. The byte cap is generous for a 512×512 PNG (~1 MB).
export const PROJECT_ICON_MAX_DIMENSION = 512;
export const PROJECT_ICON_MAX_BYTES = 1024 * 1024;

// Formats accepted from the file picker. Everything is rasterized to a PNG on
// the client (animated GIFs flatten to a still frame; SVG is rasterized), so the
// bytes the server stores are always one of the raster types below.
export const PROJECT_ICON_INPUT_MIME: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
	'image/svg+xml',
]);

// Raster content types the server will store for an icon (post client-side
// normalization). SVG is intentionally excluded — its pixel dimensions can't be
// bounded, and the client always sends a rasterized PNG.
export const PROJECT_ICON_STORED_MIME: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
]);

export function isAllowedProjectIconInputMime(mime: string): boolean {
	return PROJECT_ICON_INPUT_MIME.has(mime);
}

export function isAllowedProjectIconStoredMime(mime: string): boolean {
	return PROJECT_ICON_STORED_MIME.has(mime);
}

export const ATTACHMENT_EXTENSIONS = {
	txt: 'text/plain',
	md: 'text/markdown',
	html: 'text/html',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	mp3: 'audio/mpeg',
	opus: 'audio/opus',
	aac: 'audio/aac',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	// Script/config/text formats store and serve as inert text/plain: browsers
	// never execute text/plain (the asset serving route also sends nosniff), so
	// a `.js` or `.sh` asset is readable and downloadable but can never run on
	// our origin. Lets teams keep e.g. a scripts/ folder of reusable helpers.
	sh: 'text/plain',
	py: 'text/plain',
	js: 'text/plain',
	ts: 'text/plain',
	json: 'text/plain',
	csv: 'text/plain',
	yaml: 'text/plain',
	yml: 'text/plain',
} as const;
export type AttachmentExtension = keyof typeof ATTACHMENT_EXTENSIONS;

export const ATTACHMENT_MIME_ALLOWLIST: ReadonlySet<string> = new Set(
	Object.values(ATTACHMENT_EXTENSIONS),
);

// Content types that can carry active script and must never be served inline on
// our own origin — a top-level navigation to one would execute as us (stored
// XSS). They are served as a forced download instead. Rendering them inside an
// <img> tag (as the asset gallery does) is still safe: browsers disable scripting
// for image-loaded SVGs.
export const ASSET_INLINE_UNSAFE_MIME: ReadonlySet<string> = new Set(['image/svg+xml']);

// `forceDownload` lets the serve route honor an explicit `?download=1` — the
// "Download" affordance in the viewer — so any asset (a rendered-inline image,
// an HTML mockup) can be saved to disk on demand, regardless of its default
// inline/attachment disposition.
export function assetContentDisposition(
	contentType: string,
	forceDownload = false,
): 'inline' | 'attachment' {
	if (forceDownload) return 'attachment';
	return ASSET_INLINE_UNSAFE_MIME.has(contentType) ? 'attachment' : 'inline';
}

// Content types that may carry active script yet are meant to render inline (an
// interactive HTML mockup a human opens in a new tab). Serving them on our own
// origin would let agent-authored script read the app's credentials, so they are
// pinned to an opaque origin via a `sandbox` Content-Security-Policy: scripts run,
// but they cannot reach same-origin cookies/storage. `allow-downloads` lets a
// user-initiated in-page button (e.g. a "Download PNG" that builds a blob/data
// URL) actually save the file — without it the sandbox silently blocks the
// download in both the viewer iframe and a raw top-level tab. It grants no
// same-origin access, so the credential isolation above is unaffected.
const ASSET_SANDBOX_CSP =
	'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const ASSET_SANDBOX_SERVE_MIME: ReadonlySet<string> = new Set(['text/html']);

export function assetServeCsp(contentType: string): string | null {
	return ASSET_SANDBOX_SERVE_MIME.has(contentType) ? ASSET_SANDBOX_CSP : null;
}

// Asset content types that the app renders as markdown (rich preview + a raw
// "source" toggle) rather than downloading or framing. Project docs are a
// separate store; this is for markdown that lives in the assets library, e.g. a
// generated blog post or report.
export const ASSET_MARKDOWN_MIME: ReadonlySet<string> = new Set(['text/markdown']);

export function isMarkdownAssetMime(mime: string): boolean {
	return ASSET_MARKDOWN_MIME.has(mime);
}

// An asset whose bytes are UTF-8 text the tools return/accept inline (as opposed
// to binary assets that round-trip through a signed URL / base64). Keep this in
// lockstep with read_project_asset's inline-vs-binary split and write_project_asset's
// encoding requirement.
export function isTextAssetMime(mime: string): boolean {
	return mime.startsWith('text/') || mime === 'image/svg+xml';
}

// Asset content types whose review comments anchor to a text selection
// (`quote` + `occurrence`, exactly like project docs). Every other type takes
// un-anchored whole-asset comments. Region (rect) anchors for visual types are
// future work — see .dev/architecture.md.
export const TEXT_REVIEWABLE_ASSET_MIME: ReadonlySet<string> = new Set([
	'text/markdown',
	'text/plain',
]);

export function isTextReviewableAssetMime(mime: string): boolean {
	return TEXT_REVIEWABLE_ASSET_MIME.has(mime);
}

/**
 * A review comment on a project document or an asset (exactly one target —
 * enforced by DB CHECK). Doc comments always carry `quote`/`doc_updated_at`;
 * asset comments carry `asset_sha256` and, for text assets only, a
 * `quote`/`occurrence` anchor (NULL quote = whole-asset comment). Row shape of
 * the `review_comments` table, shared by the server service, REST responses,
 * and the web hooks.
 */
export interface ReviewComment {
	id: string;
	document_id: string | null;
	asset_id: string | null;
	/** Exact rendered-text snippet the comment anchors to; NULL = whole-asset. */
	quote: string | null;
	/** 0-based Nth occurrence of `quote` in the rendered text stream. */
	occurrence: number;
	comment: string;
	/** NULL means the admin (same convention as task_comments). */
	author_member_id: string | null;
	/** documents.updated_at at authoring time (doc targets only). */
	doc_updated_at: string | null;
	/** assets.sha256 at authoring time (asset targets only). */
	asset_sha256: string | null;
	created_at: string;
	updated_at: string;
}

// Clean one path segment (a folder name or a basename) into its link-safe
// form: start with an alphanumeric, then `[A-Za-z0-9._-]`. Returns '' when
// nothing survives so callers can decide between a fallback and a rejection.
function normalizeAssetSegment(segment: string): string {
	return segment
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[._-]+/, '')
		.replace(/[._-]+$/, '')
		.replace(/-(\.[^.]*)$/, '$1');
}

// Normalize an uploaded filename into a link-safe identity. This is the name an
// asset is referenced by (`assets/<name>.<ext>`) so it must match the mention
// parser's asset rule: start with an alphanumeric, then `[A-Za-z0-9._-]`. Any
// directory prefix is stripped — use `normalizeAssetPath` when a folder path
// should survive.
export function normalizeAssetFilename(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? name;
	const cleaned = normalizeAssetSegment(base);
	return cleaned.length > 0 ? cleaned : 'file';
}

// Assets can live in folders nested up to this many levels below the library
// root (`sub/subsub/file.ext` is the deepest valid path).
export const ASSET_MAX_FOLDER_DEPTH = 2;

/**
 * Normalize a full asset path (`folder/sub/name.ext`) into its link-safe form.
 * Character-level issues are cleaned per segment (same rules as
 * `normalizeAssetFilename`); literal empty segments (`a//b.png`,
 * leading/trailing slashes) are dropped and backslashes act as separators.
 * Structural violations are rejected rather than repaired: more than
 * ASSET_MAX_FOLDER_DEPTH folder segments, or any segment with nothing left
 * after cleanup, returns null (silently relocating a file because its folder
 * name evaporated would surprise the caller).
 */
export function normalizeAssetPath(raw: string): string | null {
	const parts = raw.split(/[/\\]/).filter((s) => s.length > 0);
	if (parts.length === 0) return null;
	if (parts.length - 1 > ASSET_MAX_FOLDER_DEPTH) return null;
	const segments: string[] = [];
	for (const part of parts) {
		const cleaned = normalizeAssetSegment(part);
		if (cleaned.length === 0) return null;
		segments.push(cleaned);
	}
	return segments.join('/');
}

/**
 * Normalize a folder path (0..ASSET_MAX_FOLDER_DEPTH segments, no basename).
 * An empty string (or only separators) is the library root and returns ''.
 * Returns null when a segment is unusable or the folder is nested too deep.
 */
export function normalizeAssetFolder(raw: string): string | null {
	const parts = raw.split(/[/\\]/).filter((s) => s.length > 0);
	if (parts.length === 0) return '';
	if (parts.length > ASSET_MAX_FOLDER_DEPTH) return null;
	const segments: string[] = [];
	for (const part of parts) {
		const cleaned = normalizeAssetSegment(part);
		if (cleaned.length === 0) return null;
		segments.push(cleaned);
	}
	return segments.join('/');
}

/** Top-level library folder that collects files uploaded through task threads. */
export const ASSET_UPLOADS_FOLDER = 'uploads';

/**
 * Library folder for files uploaded through a task's thread:
 * `uploads/<task-identifier>` (e.g. `uploads/IN-42`). The task identifier is a
 * stable, link-safe key, so uploads stay grouped under one folder even when the
 * task is renamed; it is normalized as a single segment for safety and falls
 * back to the bare `uploads` root only if nothing survives cleanup.
 */
export function taskUploadsFolder(identifier: string): string {
	const segment = normalizeAssetSegment(identifier);
	return segment.length > 0 ? `${ASSET_UPLOADS_FOLDER}/${segment}` : ASSET_UPLOADS_FOLDER;
}

/**
 * Library folder for files uploaded through the realtime chatbox (CEO chat):
 * `uploads/chat`, a sibling of the per-task `uploads/<task-identifier>`
 * folders. Files land in the HQ project's asset library under this path.
 */
export const CHAT_UPLOADS_FOLDER = `${ASSET_UPLOADS_FOLDER}/chat`;

/** Split 'a/b/c.png' into { folder: 'a/b', basename: 'c.png' }; folder '' at root. */
export function splitAssetPath(path: string): { folder: string; basename: string } {
	const slash = path.lastIndexOf('/');
	if (slash < 0) return { folder: '', basename: path };
	return { folder: path.slice(0, slash), basename: path.slice(slash + 1) };
}

/** The folder portion of an asset path ('' when the asset sits at the root). */
export function assetFolder(path: string): string {
	return splitAssetPath(path).folder;
}

/** The final segment of an asset path (the display filename). */
export function assetBasename(path: string): string {
	return splitAssetPath(path).basename;
}

// Project docs are markdown-only. Other file types live in the assets library.
export function isMarkdownDocSlug(name: string): boolean {
	return /^[a-z0-9][a-z0-9._-]*\.md$/i.test(name);
}

export function extensionOf(filename: string): string | null {
	const dot = filename.lastIndexOf('.');
	if (dot < 0 || dot === filename.length - 1) return null;
	return filename.slice(dot + 1).toLowerCase();
}

export function isAllowedAttachmentExtension(filename: string): boolean {
	const ext = extensionOf(filename);
	return ext !== null && Object.hasOwn(ATTACHMENT_EXTENSIONS, ext);
}

export function isAllowedAttachmentMime(mime: string): boolean {
	return ATTACHMENT_MIME_ALLOWLIST.has(mime);
}

/**
 * Resolve the content type to store for an uploaded asset, or null when the
 * upload must be rejected. Extensions that map to text/plain always store
 * text/plain regardless of what the uploader declared (browsers send
 * `text/javascript` for `.js`, `application/json` for `.json`, `text/csv` for
 * `.csv`, … — storing the inert type is the point, and the serving route's
 * nosniff header prevents re-interpretation). Other extensions keep the
 * original posture: a declared allowlisted type wins, a blank or
 * `application/octet-stream` declaration falls back to the extension's
 * canonical type, and a specific disallowed declared type is rejected (a
 * `.png` claiming `application/x-msdownload` is suspicious).
 */
export function resolveAttachmentContentType(
	filename: string,
	declaredType: string,
): string | null {
	const ext = extensionOf(filename);
	const extMime = ext ? ATTACHMENT_EXTENSIONS[ext as AttachmentExtension] : undefined;
	if (extMime === undefined) return null;
	if (extMime === 'text/plain') return 'text/plain';
	const declared = declaredType === 'application/octet-stream' ? '' : declaredType;
	const contentType = declared || extMime;
	return isAllowedAttachmentMime(contentType) ? contentType : null;
}

export interface CommentAttachment {
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
	url: string;
}

// A project-scoped asset as surfaced in the project Assets library. `url` is a
// freshly-signed, time-limited read URL; `comment_attachment_count` is how many
// task comments reference this asset (used to warn before deletion).
export interface ProjectAsset {
	id: string;
	content_type: string;
	byte_size: number;
	/** Content hash — the review-comment stale token (see ReviewComment). */
	sha256: string;
	original_filename: string;
	created_at: string;
	/** Set when the asset is archived (soft-deleted); null/absent = active. */
	archived_at?: string | null;
	url: string;
	comment_attachment_count: number;
}

export const CredentialKind = {
	ApiKey: 'api_key',
	SshPrivateKey: 'ssh_private_key',
	GithubPat: 'github_pat',
	OauthToken: 'oauth_token',
	WebhookSecret: 'webhook_secret',
	Other: 'other',
} as const;
export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind];

/**
 * Credential kinds whose value is substituted into outbound HTTP (Authorization
 * headers / URLs) by the egress proxy, and therefore MUST declare a non-empty
 * allowed_hosts allowlist so the secret is only ever injected into those hosts.
 * ssh_private_key (used via the ssh-agent, not the proxy), webhook_secret (often
 * a local HMAC secret), and the generic `other` kind are exempt.
 */
export const CREDENTIAL_KINDS_REQUIRING_HOSTS: readonly CredentialKind[] = [
	CredentialKind.ApiKey,
	CredentialKind.OauthToken,
	CredentialKind.GithubPat,
];
export function credentialKindRequiresAllowedHosts(kind: string): boolean {
	return (CREDENTIAL_KINDS_REQUIRING_HOSTS as readonly string[]).includes(kind);
}

export const CredentialInputType = {
	Text: 'text',
	Textarea: 'textarea',
	File: 'file',
} as const;
export type CredentialInputType = (typeof CredentialInputType)[keyof typeof CredentialInputType];

export const ActionCommentKind = {
	SetupRepo: 'setup_repo',
	HireProposal: 'hire_proposal',
	GoalSuggestion: 'goal_suggestion',
} as const;
export type ActionCommentKind = (typeof ActionCommentKind)[keyof typeof ActionCommentKind];

export const ReactionKind = {
	Ack: 'ack',
} as const;
export type ReactionKind = (typeof ReactionKind)[keyof typeof ReactionKind];

export function isReactionKind(value: unknown): value is ReactionKind {
	return typeof value === 'string' && (Object.values(ReactionKind) as string[]).includes(value);
}

export const OAuthRequestReason = {
	DesignatedRepo: 'designated_repo',
	RepoAdd: 'repo_add',
} as const;
export type OAuthRequestReason = (typeof OAuthRequestReason)[keyof typeof OAuthRequestReason];

export interface BlockedTicket {
	task_id: string;
	identifier: string;
	title: string;
	project_slug: string;
	comment_id: string;
	/** Timestamp slug for the comment's deep-link anchor (`#comment-<public_id>`). */
	comment_public_id: string;
	comment_created_at: string;
	agent_name: string | null;
	agent_slug: string | null;
	snippet: string;
}

export interface ScopeStatusResponse {
	sufficient: boolean;
	missing: string[];
	required: string[];
}

export const ToolCallStatus = { Running: 'running', Success: 'success', Error: 'error' } as const;
export type ToolCallStatus = (typeof ToolCallStatus)[keyof typeof ToolCallStatus];

export const SecretCategory = {
	SshKey: 'ssh_key',
	Credential: 'credential',
	ApiToken: 'api_token',
	Certificate: 'certificate',
	Other: 'other',
} as const;
export type SecretCategory = (typeof SecretCategory)[keyof typeof SecretCategory];

export const ApprovalType = {
	Hire: 'hire',
	ProjectCreation: 'project_creation',
	Strategy: 'strategy',
	PlanReview: 'plan_review',
	DeployProduction: 'deploy_production',
	DesignatedRepoRequest: 'designated_repo_request',
	SkillProposal: 'skill_proposal',
	GoalSuggestion: 'goal_suggestion',
} as const;
export type ApprovalType = (typeof ApprovalType)[keyof typeof ApprovalType];

export const ApprovalStatus = {
	Pending: 'pending',
	Approved: 'approved',
	Denied: 'denied',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export interface AdminMentionItem {
	id: string;
	team_id: string;
	team_slug: string;
	task_id: string;
	task_identifier: string;
	task_title: string;
	project_slug: string;
	comment_id: string;
	/** Timestamp slug for the comment's deep-link anchor (`#comment-<public_id>`). */
	comment_public_id: string;
	snippet: string;
	author_member_id: string | null;
	author_display_name: string;
	author_slug: string | null;
	/**
	 * Freshly-signed avatar URL for the author (their `user_icons` image when a
	 * human, its `agent_icons` image when an agent), or null when neither has an
	 * upload. The built-in CEO/Coach default is resolved client-side from
	 * `author_slug`; this only carries the upload.
	 */
	author_icon_url: string | null;
	created_at: string;
	read_at: string | null;
}

export const MembershipRole = { Admin: 'admin', Member: 'member' } as const;
export type MembershipRole = (typeof MembershipRole)[keyof typeof MembershipRole];

export const InviteStatus = {
	Pending: 'pending',
	Accepted: 'accepted',
	Expired: 'expired',
	Revoked: 'revoked',
} as const;
export type InviteStatus = (typeof InviteStatus)[keyof typeof InviteStatus];

export const PlatformType = {
	GitHub: 'github',
	Gmail: 'gmail',
	GitLab: 'gitlab',
	Stripe: 'stripe',
	PostHog: 'posthog',
	Railway: 'railway',
	Vercel: 'vercel',
	DigitalOcean: 'digitalocean',
	X: 'x',
	Anthropic: 'anthropic',
	OpenAI: 'openai',
	Google: 'google',
} as const;
export type PlatformType = (typeof PlatformType)[keyof typeof PlatformType];

export const ConnectionStatus = {
	Active: 'active',
	Expired: 'expired',
	Disconnected: 'disconnected',
} as const;
export type ConnectionStatus = (typeof ConnectionStatus)[keyof typeof ConnectionStatus];

export const WakeupSource = {
	Timer: 'timer',
	Assignment: 'assignment',
	OnDemand: 'on_demand',
	Mention: 'mention',
	Automation: 'automation',
	CredentialProvided: 'credential_provided',
	AssetDeletionResolved: 'asset_deletion_resolved',
	Comment: 'comment',
	Reply: 'reply',
	Heartbeat: 'heartbeat',
} as const;
export type WakeupSource = (typeof WakeupSource)[keyof typeof WakeupSource];

export const WakeupStatus = {
	Queued: 'queued',
	Claimed: 'claimed',
	Completed: 'completed',
	Failed: 'failed',
	Skipped: 'skipped',
	Coalesced: 'coalesced',
	Deferred: 'deferred',
	Cancelled: 'cancelled',
} as const;
export type WakeupStatus = (typeof WakeupStatus)[keyof typeof WakeupStatus];

export const WakeupSkipReason = {
	TaskBusy: 'task_busy',
	ProjectAtCapacity: 'project_at_capacity',
	AgentRunning: 'agent_running',
	OverBudget: 'over_budget',
	ContainerDown: 'container_down',
} as const;
export type WakeupSkipReason = (typeof WakeupSkipReason)[keyof typeof WakeupSkipReason];

// Rolling spend windows for agent/project budgets. Each is enforced independently;
// a 0 limit means unlimited for that window. Spend is summed from cost_entries.
export const BudgetPeriod = {
	Daily: 'daily',
	Weekly: 'weekly',
	Monthly: 'monthly',
} as const;
export type BudgetPeriod = (typeof BudgetPeriod)[keyof typeof BudgetPeriod];

export const HeartbeatRunStatus = {
	Queued: 'queued',
	Running: 'running',
	Succeeded: 'succeeded',
	Failed: 'failed',
	Cancelled: 'cancelled',
	TimedOut: 'timed_out',
} as const;
export type HeartbeatRunStatus = (typeof HeartbeatRunStatus)[keyof typeof HeartbeatRunStatus];

/** Classifies a heartbeat run. 'task' is the normal task-scoped run; 'progress_update' is a
 * Captain run with no task that estimates progress across the project's due goals. */
export const HeartbeatRunKind = {
	Task: 'task',
	ProgressUpdate: 'progress_update',
} as const;
export type HeartbeatRunKind = (typeof HeartbeatRunKind)[keyof typeof HeartbeatRunKind];

// --- Goals ---

/** How often the Captain re-checks a goal's progress during its heartbeat. */
export const GoalCheckFrequency = {
	Daily: 'daily',
	Weekly: 'weekly',
	Monthly: 'monthly',
} as const;
export type GoalCheckFrequency = (typeof GoalCheckFrequency)[keyof typeof GoalCheckFrequency];

export const GOAL_CHECK_FREQUENCY_LABELS: Record<GoalCheckFrequency, string> = {
	[GoalCheckFrequency.Daily]: 'Daily',
	[GoalCheckFrequency.Weekly]: 'Weekly',
	[GoalCheckFrequency.Monthly]: 'Monthly',
};

/** The Captain's at-a-glance read on a goal. 'pending' = not yet assessed (a brand-new
 * goal the Captain hasn't checked). The Captain sets the other three on each check. */
export const GoalHealth = {
	Pending: 'pending',
	OnTrack: 'on_track',
	AtRisk: 'at_risk',
	OffTrack: 'off_track',
} as const;
export type GoalHealth = (typeof GoalHealth)[keyof typeof GoalHealth];

export const GOAL_HEALTH_LABELS: Record<GoalHealth, string> = {
	[GoalHealth.Pending]: 'Not assessed',
	[GoalHealth.OnTrack]: 'On track',
	[GoalHealth.AtRisk]: 'At risk',
	[GoalHealth.OffTrack]: 'Off track',
};

/** The health values the Captain may set via update_goal_progress (excludes 'pending', the
 * pre-assessment default). */
export const CAPTAIN_SETTABLE_GOAL_HEALTH = [
	GoalHealth.OnTrack,
	GoalHealth.AtRisk,
	GoalHealth.OffTrack,
] as const;

export function formatGoalHealth(health: string): string {
	return GOAL_HEALTH_LABELS[health as GoalHealth] ?? health;
}

/**
 * SMART-goal guidance shown on the goal create/edit surfaces so the admin keeps the framework
 * in mind. Single source of truth so every surface renders the same explanation.
 */
export const GOAL_SMART_GUIDANCE: ReadonlyArray<{ letter: string; label: string; hint: string }> = [
	{ letter: 'S', label: 'Specific', hint: 'Target one clear outcome, not a vague theme.' },
	{ letter: 'M', label: 'Measurable', hint: 'Define exactly how you will know it is achieved.' },
	{ letter: 'A', label: 'Achievable', hint: 'Realistic for the team given its resources.' },
	{ letter: 'R', label: 'Relevant', hint: "Matters to the project's mission right now." },
	{
		letter: 'T',
		label: 'Time-bound',
		hint: 'Give it a deadline to work toward — ongoing level-to-hold goals can rely on their check cadence instead.',
	},
];

/**
 * Ongoing-vs-one-off note shown alongside the SMART card: a goal is an outcome the project
 * works toward, re-checked on its cadence; recurring work and one-off deliverables are tasks.
 */
export const GOAL_ONGOING_NOTE =
	'A goal is an outcome the project works toward — the Captain re-checks it on its cadence indefinitely, and it is never "finished" at 100% (a reached milestone stays tracked and held until you archive it). Recurring work and one-off deliverables belong on the board as tasks instead.';

/** One point in a goal's progress history — a snapshot recorded by a progress-update run. */
export interface GoalHistoryPoint {
	/** ISO timestamp of the recording progress-update run. */
	t: string;
	percent: number;
	health: GoalHealth;
}

export interface Goal {
	id: string;
	team_id: string;
	project_id: string;
	title: string;
	/** Precise free-text definition of how we know the goal is achieved (SMART "Measurable"). */
	measurement: string;
	/** Optional free-text guidance on actions/checks the Captain could take toward the goal. */
	actions: string;
	progress_percent: number;
	health: GoalHealth;
	status_blurb: string;
	check_frequency: GoalCheckFrequency;
	target_date: string | null;
	last_checked_at: string | null;
	/** NULL = active; non-null = archived by an admin at this time. */
	archived_at: string | null;
	created_by_member_id: string | null;
	created_at: string;
	updated_at: string;
}

/** The list/detail DTO: a goal plus its project handle and embedded recent history (so the
 * goal panels can draw their line charts without an extra round-trip). */
export interface GoalWithProject extends Goal {
	project_name: string | null;
	project_slug: string | null;
	history: GoalHistoryPoint[];
}

/** A single goal's progress snapshot taken during one progress-update run. */
export interface GoalRunUpdate {
	id: string;
	run_id: string;
	goal_id: string;
	progress_percent: number;
	health: GoalHealth;
	status_blurb: string;
	created_at: string;
}

/** A progress-update run as shown in the Goals page footer, annotated with which goals it touched. */
export interface ProgressUpdateRunSummary {
	id: string;
	status: HeartbeatRunStatus;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	/** The Captain member that ran this progress-update, for linking to its run in the agent's run list. */
	member_id: string;
	agent_title: string;
	agent_slug: string;
	/** Titles of the goals this run updated (empty = ran but changed nothing). */
	updated_goal_titles: string[];
}

/** A task touched by a progress-update run, shown in the goal detail page's per-goal run feed. */
export interface GoalRunTaskRef {
	id: string;
	identifier: string;
	title: string;
	status: TaskStatus;
}

/**
 * One progress-update run that did something for a specific goal, shown at the bottom of the goal
 * detail page: it estimated the goal's progress, created task(s) for it, and/or commented on
 * goal-linked task(s).
 */
export interface GoalRunActivity {
	id: string;
	status: HeartbeatRunStatus;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	/** The Captain member that ran this progress-update, for linking to its run in the agent's run list. */
	member_id: string;
	agent_slug: string;
	/** The progress snapshot this run recorded for the goal, or null if it only created/commented. */
	progress: { progress_percent: number; health: GoalHealth; status_blurb: string } | null;
	/** Tasks this run created that are linked to the goal. */
	created_tasks: GoalRunTaskRef[];
	/** Goal-linked tasks this run commented on (with the number of comments it left). */
	commented_tasks: (GoalRunTaskRef & { comment_count: number })[];
}

/** The Captain-maintained project progress summary shown at the top of the Progress page. */
export interface ProjectProgress {
	summary: string;
	updated_at: string | null;
}

// --- CEO chat ---

/**
 * Surface a CEO chat conversation lives on — its one home. `web` conversations
 * are in-app chatbox threads; external channels (Telegram + Slack now, Discord
 * next, WhatsApp later) map each external DM/topic/channel-thread to its own
 * conversation. There is no mirroring: `channel` + `external_thread_id` on the
 * conversation row ARE the inbound routing key, and every reply is delivered to
 * the surface the triggering message came from. The web view lists all threads.
 */
export const ChatChannel = {
	Web: 'web',
	Telegram: 'telegram',
	WhatsApp: 'whatsapp',
	Slack: 'slack',
	Discord: 'discord',
} as const;
export type ChatChannel = (typeof ChatChannel)[keyof typeof ChatChannel];

/** Runtime guard: is a string one of the known chat channels? */
export function isChatChannel(value: string): value is ChatChannel {
	return (Object.values(ChatChannel) as string[]).includes(value);
}

/**
 * What kind of conversation a CEO chat thread is.
 *
 * - `assistant`: the operator's own line to the CEO — a web chatbox thread, an
 *   app DM, or a designated-supergroup topic. Interactive from the web view;
 *   identity-allowlist gated on external surfaces.
 * - `coworker`: the CEO participating in a team channel/group it was invited to
 *   (a Slack channel, a Telegram group, a Discord channel). Mention-driven,
 *   platform history as ephemeral context, replies only into the platform
 *   thread; visible read-only in the web view.
 */
export const ChatConversationKind = {
	Assistant: 'assistant',
	Coworker: 'coworker',
} as const;
export type ChatConversationKind = (typeof ChatConversationKind)[keyof typeof ChatConversationKind];

/** Runtime guard: is a string one of the known chat conversation kinds? */
export function isChatConversationKind(value: string): value is ChatConversationKind {
	return (Object.values(ChatConversationKind) as string[]).includes(value);
}

export const ChatMessageRole = {
	User: 'user',
	Assistant: 'assistant',
	System: 'system',
} as const;
export type ChatMessageRole = (typeof ChatMessageRole)[keyof typeof ChatMessageRole];

export const ChatMessageStatus = {
	Pending: 'pending',
	Streaming: 'streaming',
	Complete: 'complete',
	Failed: 'failed',
	/** A reply cut short because a newer message interrupted it (partial text kept). */
	Interrupted: 'interrupted',
} as const;
export type ChatMessageStatus = (typeof ChatMessageStatus)[keyof typeof ChatMessageStatus];

/** Lifecycle of the persistent CEO chat session (its warm-resource lease + auth principal). */
export const ChatSessionStatus = {
	Starting: 'starting',
	Running: 'running',
	Crashed: 'crashed',
	Stopped: 'stopped',
} as const;
export type ChatSessionStatus = (typeof ChatSessionStatus)[keyof typeof ChatSessionStatus];

export const PluginStatus = {
	Installed: 'installed',
	Enabled: 'enabled',
	Disabled: 'disabled',
	Error: 'error',
} as const;
export type PluginStatus = (typeof PluginStatus)[keyof typeof PluginStatus];

export const DocumentType = {
	ProjectDoc: 'project_doc',
	TeamPreferences: 'team_preferences',
	AgentSystemPrompt: 'agent_system_prompt',
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

/**
 * List-view filter for archivable resources (project docs and assets).
 * Archiving is the soft-delete: agents archive via MCP, only admins
 * hard-delete. Both library pages default to Active.
 */
export const ArchiveFilter = {
	Active: 'active',
	Archived: 'archived',
	All: 'all',
} as const;
export type ArchiveFilter = (typeof ArchiveFilter)[keyof typeof ArchiveFilter];

export function isArchiveFilter(value: unknown): value is ArchiveFilter {
	return typeof value === 'string' && (Object.values(ArchiveFilter) as string[]).includes(value);
}

/** Whether a row with `archived_at` passes the given archive filter. */
export function matchesArchiveFilter(
	archivedAt: string | null | undefined,
	filter: ArchiveFilter,
): boolean {
	if (filter === ArchiveFilter.All) return true;
	return filter === ArchiveFilter.Archived ? archivedAt != null : archivedAt == null;
}

/**
 * Order for the assets grid. Newest is the default (matches the API's historical
 * `created_at DESC`). The web sorts client-side and the REST route / MCP tool
 * sort in SQL; both mirror `compareAssetsForSort`, the single source of truth.
 */
export const AssetSortOrder = {
	Newest: 'newest',
	Oldest: 'oldest',
	Alphabetical: 'alphabetical',
} as const;
export type AssetSortOrder = (typeof AssetSortOrder)[keyof typeof AssetSortOrder];

export function isAssetSortOrder(value: unknown): value is AssetSortOrder {
	return typeof value === 'string' && (Object.values(AssetSortOrder) as string[]).includes(value);
}

/** The minimal asset shape the sort comparison reads. */
export interface AssetSortFields {
	created_at: string;
	original_filename: string;
}

/**
 * Compare two assets for the given sort order. The SQL `ORDER BY` on the REST
 * route and MCP tool mirrors this exactly:
 * - Newest:       created_at DESC, then original_filename ASC
 * - Oldest:       created_at ASC,  then original_filename ASC
 * - Alphabetical: LOWER(original_filename) ASC, then created_at DESC
 * Every branch has a deterministic tiebreak so the order is stable.
 */
export function compareAssetsForSort(
	a: AssetSortFields,
	b: AssetSortFields,
	order: AssetSortOrder,
): number {
	if (order === AssetSortOrder.Alphabetical) {
		const byName = a.original_filename
			.toLowerCase()
			.localeCompare(b.original_filename.toLowerCase());
		if (byName !== 0) return byName;
		// Newest first as the tiebreak (created_at DESC).
		return b.created_at.localeCompare(a.created_at);
	}
	// ISO-8601 timestamps sort chronologically as plain strings.
	const byDate =
		order === AssetSortOrder.Oldest
			? a.created_at.localeCompare(b.created_at)
			: b.created_at.localeCompare(a.created_at);
	if (byDate !== 0) return byDate;
	return a.original_filename.toLowerCase().localeCompare(b.original_filename.toLowerCase());
}

export const AuditActorType = {
	Admin: 'admin',
	Agent: 'agent',
	System: 'system',
	ApiKey: 'api_key',
} as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

export const RepoHostType = { GitHub: 'github' } as const;
export type RepoHostType = (typeof RepoHostType)[keyof typeof RepoHostType];

/**
 * Lifecycle of a linked repo's checkout setup (container up + in-container
 * clone + first-repo designation), which runs in the background after the
 * POST /repos insert returns. `pending` rows found at startup were interrupted
 * by a restart and are marked `failed`; a `failed` repo is retried by POSTing
 * the same repo again.
 */
export const RepoSetupStatus = {
	Pending: 'pending',
	Ready: 'ready',
	Failed: 'failed',
} as const;
export type RepoSetupStatus = (typeof RepoSetupStatus)[keyof typeof RepoSetupStatus];

export const AuthType = {
	Admin: 'admin',
	ApiKey: 'api_key',
	Agent: 'agent',
} as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

/**
 * An API key is the instance-scoped MCP credential. It is `approved` (active) the
 * moment an admin mints it directly; a key created by an external MCP client's
 * self-registration starts `pending` (inert — grants no access) until a human
 * admin approves it, after which it is admin-equivalent across every project/team.
 */
export const ApiKeyStatus = { Pending: 'pending', Approved: 'approved' } as const;
export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

export const AuditEntityType = {
	Task: 'task',
	Project: 'project',
	Agent: 'agent',
	AgentRun: 'agent_run',
	Team: 'team',
	Secret: 'secret',
	Document: 'document',
	Asset: 'asset',
	Connection: 'connection',
	McpConnection: 'mcp_connection',
	Skill: 'skill',
	ApiKey: 'api_key',
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];

export const ConnectorTransport = { Saas: 'saas', Local: 'local', Api: 'api' } as const;
export type ConnectorTransport = (typeof ConnectorTransport)[keyof typeof ConnectorTransport];

export const McpInstallStatus = {
	Pending: 'pending',
	Installed: 'installed',
	Failed: 'failed',
} as const;
export type McpInstallStatus = (typeof McpInstallStatus)[keyof typeof McpInstallStatus];

/**
 * The level of access an agent asked for when it registered a connector.
 * `Read` makes Hezo disable every write method once the connector's methods are
 * first listed; `Write` is the default and means "no restriction requested".
 * An agent can only ever narrow its own access — this never widens an allowlist
 * an operator has already set.
 */
export const ConnectorAccess = { Read: 'read', Write: 'write' } as const;
export type ConnectorAccess = (typeof ConnectorAccess)[keyof typeof ConnectorAccess];

export const AgentTypeSource = {
	Builtin: 'builtin',
	Custom: 'custom',
	Remote: 'remote',
} as const;
export type AgentTypeSource = (typeof AgentTypeSource)[keyof typeof AgentTypeSource];

export const TeamTemplateSource = {
	Builtin: 'builtin',
	Custom: 'custom',
	Marketplace: 'marketplace',
} as const;
export type TeamTemplateSource = (typeof TeamTemplateSource)[keyof typeof TeamTemplateSource];

export interface SkillTemplateConfig {
	name: string;
	source_url: string;
	description?: string;
}

export interface SkillRecord {
	id: string;
	name: string;
	slug: string;
	description: string;
	content: string;
	source_url: string | null;
	content_hash: string;
	created_by_member_id: string | null;
	/**
	 * Scope: NULL = global ("all projects"); a project id = private to that
	 * project (shadows a global skill of the same slug within that project).
	 */
	project_id: string | null;
	tags: string[];
	is_active: boolean;
	auto_load: boolean;
	created_at: string;
	updated_at: string;
}

/**
 * A skill row as returned by the admin `/api/skills` list and the per-project
 * `/api/projects/:projectId/skills` list — annotated with its owning project
 * (both null for a global skill). `content` is omitted from list endpoints.
 */
export interface SkillListItemRecord extends Omit<SkillRecord, 'content'> {
	project_name?: string | null;
	project_slug?: string | null;
	/** True for a built-in, generated skill (e.g. `connector-recipes`) that is
	 * viewable but not editable — the UI hides edit/delete affordances and the
	 * server rejects mutations. Absent/false for normal stored skills. */
	readonly?: boolean;
}

/**
 * A point-in-time snapshot of a skill's content. Recorded automatically when a
 * skill's content changes; the admin can list these and restore any one. Mirrors
 * the document/agent-prompt revision shape so the same UI renders it.
 */
export interface SkillRevisionRecord {
	id: string;
	revision_number: number;
	content: string;
	change_summary: string;
	author_name: string | null;
	/** 'agent' | 'admin' — drives the human/agent badge. */
	author_type: string;
	created_at: string;
}

/** A search hit from the skills.sh registry (the UI "search and add" panel). */
export interface RegistrySkillSearchResult {
	/** Registry id, "owner/repo/skill". */
	id: string;
	name: string;
	/** "owner/repo" source. */
	source: string;
	slug: string;
	installs: number;
	/** Human-facing skills.sh page URL. */
	url: string;
}

export const AuditAction = {
	Created: 'created',
	Updated: 'updated',
	Deleted: 'deleted',
	RunStarted: 'run_started',
	RunCompleted: 'run_completed',
	Requested: 'requested',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const TERMINAL_TASK_STATUSES = [TaskStatus.Done, TaskStatus.Cancelled] as const;

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
	[TaskPriority.Urgent]: 0,
	[TaskPriority.High]: 1,
	[TaskPriority.Medium]: 2,
	[TaskPriority.Low]: 3,
};

// --- AI Provider Configuration ---

export const AiProvider = {
	Anthropic: 'anthropic',
	OpenAI: 'openai',
	Google: 'google',
	DeepSeek: 'deepseek',
	ZAi: 'z_ai',
	OpenRouter: 'openrouter',
	Kimi: 'kimi',
	XAi: 'x_ai',
	Ollama: 'ollama',
	LmStudio: 'lmstudio',
} as const;
export type AiProvider = (typeof AiProvider)[keyof typeof AiProvider];

export const AiAuthMethod = {
	ApiKey: 'api_key',
	Subscription: 'subscription',
} as const;
export type AiAuthMethod = (typeof AiAuthMethod)[keyof typeof AiAuthMethod];

export const AiProviderStatus = {
	Verified: 'verified',
	Invalid: 'invalid',
	Revoked: 'revoked',
} as const;
export type AiProviderStatus = (typeof AiProviderStatus)[keyof typeof AiProviderStatus];

/**
 * Per-provider configuration that varies even when multiple providers share a
 * runtime. Each provider declares the CLI runtime it's driven through, any
 * static env entries (base URL, model defaults, …), and the env var that
 * carries the credential value for each supported auth method. Runtime-only
 * knobs (CLI binary, MCP injection, headless flags, effort mapping) live in
 * the `RUNTIME_*` maps below and are shared across every provider on that
 * runtime.
 */
export interface ProviderRuntimeAdapter {
	runtime: AgentRuntime;
	staticEnv?: Readonly<Record<string, string>>;
	credentialEnvByAuthMethod: Partial<Record<AiAuthMethod, string>>;
}

/**
 * Claude Code emits background traffic (Statsig feature-flag polling, OTel,
 * auto-update checks, Sentry) to api.anthropic.com regardless of
 * ANTHROPIC_BASE_URL. None of it serves Hezo's headless flow — for
 * non-Anthropic providers it's noise that hammers the egress proxy at a
 * host nobody is paying for, and for the Anthropic provider itself it
 * still bypasses NO_PROXY in several Claude Code subsystems (undici fetch,
 * Sentry transport) and lands in the MITM proxy. Stamp these flags into
 * env for every Claude Code runtime.
 *
 * Alongside the telemetry/noise-suppression `DISABLE_*` flags, this bag also
 * carries a headless background-wait override: `claude -p` caps how long it
 * waits for still-running background tasks and then terminates them, which
 * kills Hezo's legitimately long background work. See
 * `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` below.
 */
export const CLAUDE_CODE_QUIET_ENV = {
	DISABLE_TELEMETRY: '1',
	DISABLE_ERROR_REPORTING: '1',
	DISABLE_AUTOUPDATER: '1',
	DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
	DISABLE_BUG_COMMAND: '1',
	// Headless `claude -p` caps waiting for still-running background tasks at 600s
	// and then kills them ("Background tasks still running after 600s; terminating").
	// Hezo runs legitimately long background work (Workflow fan-out agents, long
	// `run_in_background` jobs); `0` removes the ceiling so the run waits for its own
	// background tasks instead of terminating them early. The wait is then bounded
	// only by the run's overall container/heartbeat lifecycle, not an arbitrary cap.
	CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
} as const;

/**
 * The Gemini CLI refuses to run in an "untrusted" folder and silently downgrades
 * `--yolo` to manual tool approval, which hangs a headless run; Hezo agents run
 * headless in `/workspace`. Trusting the workspace is the documented headless
 * setting (https://geminicli.com/docs/cli/trusted-folders). Applied to every
 * Gemini-runtime provider, mirroring `CLAUDE_CODE_QUIET_ENV` for Claude Code.
 */
export const GEMINI_RUNTIME_ENV = {
	GEMINI_CLI_TRUST_WORKSPACE: 'true',
} as const;

export const PROVIDER_RUNTIME_ADAPTERS: Record<AiProvider, ProviderRuntimeAdapter> = {
	[AiProvider.Anthropic]: {
		runtime: AgentRuntime.ClaudeCode,
		// Subscription (Claude Pro/Max) is delivered as a long-lived OAuth token from
		// `claude setup-token`, injected via CLAUDE_CODE_OAUTH_TOKEN — not a
		// credentials-file mount (Claude Code rotates single-use refresh tokens and
		// recreates ~/.claude/.credentials.json, which breaks on a per-run mount).
		credentialEnvByAuthMethod: {
			[AiAuthMethod.ApiKey]: 'ANTHROPIC_API_KEY',
			[AiAuthMethod.Subscription]: 'CLAUDE_CODE_OAUTH_TOKEN',
		},
	},
	[AiProvider.OpenAI]: {
		runtime: AgentRuntime.Codex,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'OPENAI_API_KEY' },
	},
	[AiProvider.Google]: {
		runtime: AgentRuntime.Gemini,
		// The Gemini CLI authenticates the Gemini API from GEMINI_API_KEY; it does
		// NOT treat a bare GOOGLE_API_KEY as an auth method (that needs
		// GOOGLE_GENAI_USE_VERTEXAI), and errors "set an Auth method … or specify
		// GEMINI_API_KEY". The in-container Stop-hook judge reads either name.
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'GEMINI_API_KEY' },
	},
	[AiProvider.DeepSeek]: {
		runtime: AgentRuntime.ClaudeCode,
		staticEnv: {
			ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
			// Base ids only — Claude Code appends `[1m]` for 1M-context models itself.
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
			ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
			CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
		},
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_AUTH_TOKEN' },
	},
	[AiProvider.ZAi]: {
		runtime: AgentRuntime.ClaudeCode,
		staticEnv: {
			ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'GLM-4.7',
			ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-4.7',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM-4.5-Air',
			CLAUDE_CODE_SUBAGENT_MODEL: 'GLM-4.5-Air',
		},
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_AUTH_TOKEN' },
	},
	// OpenCode reads its model-provider key straight from env. OpenRouter is the
	// first provider wired to the OpenCode runtime; additional OpenCode providers
	// are just another entry here plus an `opencode.json` provider block.
	[AiProvider.OpenRouter]: {
		runtime: AgentRuntime.OpenCode,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'OPENROUTER_API_KEY' },
	},
	// Kimi (Moonshot) runs through Claude Code against Moonshot's
	// Anthropic-compatible endpoint — the same pattern as DeepSeek/Z.ai.
	// ENABLE_TOOL_SEARCH and CLAUDE_CODE_AUTO_COMPACT_WINDOW are Moonshot's
	// documented Claude Code settings
	// (https://platform.kimi.ai/docs/guide/agent-support).
	[AiProvider.Kimi]: {
		runtime: AgentRuntime.ClaudeCode,
		staticEnv: {
			ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
			ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.7-code',
			ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.7-code',
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
			CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k2.7-code',
			ENABLE_TOOL_SEARCH: 'false',
			CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
		},
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_AUTH_TOKEN' },
	},
	// xAI Grok Build runs on its own first-party `grok` CLI (its own runtime),
	// authenticated by XAI_API_KEY sent direct to api.x.ai (the sanctioned
	// model-provider credential — no MITM). No subscription auth; api-key only.
	// The grok CLI reads its config from $GROK_HOME (see SUBSCRIPTION_LAYOUTS),
	// so no staticEnv base-url override is needed. Like OpenCode, Grok has no
	// completeness Stop-hook judge (its Stop hook is passive — see the grok MCP
	// injector), so it runs fail-open.
	[AiProvider.XAi]: {
		runtime: AgentRuntime.Grok,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'XAI_API_KEY' },
	},
	// Local, self-hosted runners. Both serve Anthropic's Messages API natively
	// (Ollama `/v1/messages`; LM Studio the same since 0.4.1), so they run on the
	// Claude Code runtime exactly like DeepSeek/Z.ai/Kimi — with one structural
	// difference: the endpoint is the operator's own machine, so it CANNOT live in
	// `staticEnv`. The base URL is stored per-config and injected at run time from
	// the credential (see `buildProviderEnv`), which is why there is no
	// `ANTHROPIC_BASE_URL` here. Model defaults are likewise omitted: whatever the
	// operator has pulled locally is the model, selected per agent.
	[AiProvider.Ollama]: {
		runtime: AgentRuntime.ClaudeCode,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_AUTH_TOKEN' },
	},
	[AiProvider.LmStudio]: {
		runtime: AgentRuntime.ClaudeCode,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_AUTH_TOKEN' },
	},
};

/** Default upstream API hostnames per provider (for egress NO_PROXY). */
const PROVIDER_UPSTREAM_HOSTS: Record<AiProvider, readonly string[]> = {
	[AiProvider.Anthropic]: ['api.anthropic.com'],
	[AiProvider.OpenAI]: ['api.openai.com'],
	[AiProvider.Google]: ['generativelanguage.googleapis.com'],
	[AiProvider.DeepSeek]: ['api.deepseek.com'],
	[AiProvider.ZAi]: ['api.z.ai'],
	[AiProvider.OpenRouter]: ['openrouter.ai'],
	[AiProvider.Kimi]: ['api.moonshot.ai'],
	[AiProvider.XAi]: ['api.x.ai'],
	// Local runners have no fixed upstream — the real host comes from the config's
	// stored base URL, passed to `providerDirectUpstreamHosts` at run time. These
	// are only the fallback for a config that somehow carries no URL.
	[AiProvider.Ollama]: ['localhost'],
	[AiProvider.LmStudio]: ['localhost'],
};

/**
 * Hostnames that should bypass the egress MITM proxy for a given provider.
 * LLM credentials are injected via container env (not `__HEZO_SECRET_*`
 * placeholders); MITM breaks some Anthropic-compatible APIs, so provider
 * traffic goes direct while git/MCP placeholders still use the proxy.
 *
 * `configuredBaseUrl` is the operator-supplied endpoint carried on the
 * credential, used by the local providers (Ollama / LM Studio) whose host is
 * per-install and therefore absent from `staticEnv`. It takes precedence over
 * both the static override and the default table; an unparseable value falls
 * through to them rather than throwing.
 */
export function providerDirectUpstreamHosts(
	provider: AiProvider,
	configuredBaseUrl?: string | null,
): readonly string[] {
	const baseUrl =
		configuredBaseUrl || PROVIDER_RUNTIME_ADAPTERS[provider].staticEnv?.ANTHROPIC_BASE_URL;
	if (baseUrl) {
		try {
			return [new URL(baseUrl).hostname];
		} catch {
			// fall through
		}
	}
	return PROVIDER_UPSTREAM_HOSTS[provider];
}

/**
 * Normalize a model id before passing it to Claude Code CLI. DeepSeek runs
 * append `[1m]` themselves; including it in env or `--model` yields
 * `deepseek-v4-pro[1m][1m]` and provider 400s.
 */
export function claudeCodeModelArg(provider: AiProvider, model: string): string {
	if (provider === AiProvider.DeepSeek) {
		return model.replace(/\[1m\]/gi, '');
	}
	return model;
}

/**
 * True for the providers that route Claude Code at a THIRD-PARTY
 * Anthropic-compatible endpoint (DeepSeek, Z.ai, Kimi) rather than Anthropic's
 * own API — identified by a `staticEnv.ANTHROPIC_BASE_URL` override.
 *
 * For these, the run's selected model is the single model that endpoint serves,
 * so the runtime's *derived* models — the Stop-hook completeness judge and the
 * Claude Code subagent default — should track the selected model instead of a
 * hardcoded constant. The constant goes stale the moment the provider ships a
 * new flagship (e.g. Kimi `kimi-k2.7-code` → `k3`) or retires the pinned id: the
 * judge call then 404s and the hook silently fails open, and subagents point at
 * a model the endpoint no longer serves. Tracking the selected model keeps both
 * alive with no code change — which is the whole reason the model list is
 * fetched live from the provider (see the ai-providers models route).
 *
 * Anthropic (first-party, no custom base URL) is deliberately excluded: its
 * judge is a stable, cheaper Sonnet that must NOT scale with the main model's
 * cost (an Opus run should not judge with Opus), and Claude Code already owns a
 * sensible native subagent default there.
 */
export function claudeCodeProviderUsesCustomEndpoint(provider: AiProvider): boolean {
	const adapter = PROVIDER_RUNTIME_ADAPTERS[provider];
	if (adapter.runtime !== AgentRuntime.ClaudeCode) return false;
	// Local providers reach a custom endpoint too, but carry it on the credential
	// rather than in `staticEnv`, so the base-URL probe alone would miss them. The
	// cost rationale for excluding Anthropic above does not apply here: local
	// inference is free, so tracking the run's model costs nothing, and the pinned
	// alternative would be a model the operator may not even have pulled.
	if (isLocalAiProvider(provider)) return true;
	return Boolean(adapter.staticEnv?.ANTHROPIC_BASE_URL);
}

/**
 * True for providers served by a runner on hardware the operator controls
 * (Ollama, LM Studio) rather than a vendor's hosted API. These are configured
 * with a base URL instead of a fixed endpoint, need no real credential, and
 * cost nothing per token.
 */
export function isLocalAiProvider(provider: AiProvider): boolean {
	return Boolean(AI_PROVIDER_INFO[provider]?.local);
}

/**
 * OpenCode addresses every model as `<providerKey>/<model>` (e.g.
 * `openrouter/anthropic/claude-sonnet-4.5`). Maps a Hezo AI provider to the
 * OpenCode provider key its models live under, so the runner can prefix a bare
 * model id before passing it to `opencode run --model`.
 */
export const OPENCODE_PROVIDER_KEY: Partial<Record<AiProvider, string>> = {
	[AiProvider.OpenRouter]: 'openrouter',
};

/**
 * Normalize a model id for `opencode run --model`. Prefixes the OpenCode
 * provider key when the stored id isn't already qualified; leaves already
 * `providerKey/…` ids untouched (the provider catalog already returns them
 * unqualified, but a user may have typed the full form).
 */
export function opencodeModelArg(provider: AiProvider, model: string): string {
	const key = OPENCODE_PROVIDER_KEY[provider];
	if (!key) return model;
	return model.startsWith(`${key}/`) ? model : `${key}/${model}`;
}

export const PROVIDER_TO_RUNTIME: Record<AiProvider, AgentRuntime> = Object.freeze(
	(Object.keys(PROVIDER_RUNTIME_ADAPTERS) as AiProvider[]).reduce(
		(acc, p) => {
			acc[p] = PROVIDER_RUNTIME_ADAPTERS[p].runtime;
			return acc;
		},
		{} as Record<AiProvider, AgentRuntime>,
	),
);

export const PROVIDERS_BY_RUNTIME: Record<AgentRuntime, readonly AiProvider[]> = Object.freeze(
	(Object.keys(PROVIDER_RUNTIME_ADAPTERS) as AiProvider[]).reduce(
		(acc, p) => {
			const r = PROVIDER_RUNTIME_ADAPTERS[p].runtime;
			const list = acc[r] ?? [];
			list.push(p);
			acc[r] = list;
			return acc;
		},
		{} as Record<AgentRuntime, AiProvider[]>,
	),
);

export const RUNTIME_COMMANDS: Record<AgentRuntime, string> = {
	[AgentRuntime.ClaudeCode]: 'claude',
	[AgentRuntime.Codex]: 'codex',
	[AgentRuntime.Gemini]: 'gemini',
	[AgentRuntime.OpenCode]: 'opencode',
	[AgentRuntime.Grok]: 'grok',
};

/**
 * How each CLI receives the task prompt. Most runtimes read it from stdin (the
 * runner redirects `< $HEZO_PROMPT_FILE`); OpenCode (`opencode run <message>`)
 * takes it as a trailing argument instead, so the exec wrapper appends
 * `"$(cat $HEZO_PROMPT_FILE)"` for it. The mode is threaded to the container
 * via `HEZO_PROMPT_MODE`.
 */
export const RUNTIME_PROMPT_DELIVERY: Record<AgentRuntime, 'stdin' | 'arg'> = {
	[AgentRuntime.ClaudeCode]: 'stdin',
	[AgentRuntime.Codex]: 'stdin',
	[AgentRuntime.Gemini]: 'stdin',
	[AgentRuntime.OpenCode]: 'arg',
	// `grok -p <PROMPT>` (aka --single) takes the prompt as the value of the
	// trailing `-p` flag, so the bridge appends `"$(cat $HEZO_PROMPT_FILE)"`.
	[AgentRuntime.Grok]: 'arg',
};

/**
 * Flags each CLI needs to run fully non-interactively. Agent runs happen
 * inside locked-down Docker containers driven by `docker exec`, so any prompt
 * for user approval would hang the run indefinitely.
 */
export const RUNTIME_AUTO_APPROVE_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: ['--dangerously-skip-permissions'],
	[AgentRuntime.Codex]: ['--dangerously-bypass-approvals-and-sandbox'],
	[AgentRuntime.Gemini]: ['--yolo'],
	[AgentRuntime.OpenCode]: ['--dangerously-skip-permissions'],
	// Grok's Claude-Code-style permission modes; bypassPermissions skips every
	// approval prompt so a headless `docker exec` run never hangs on one.
	[AgentRuntime.Grok]: ['--permission-mode', 'bypassPermissions'],
};

/**
 * Tools removed from a runtime's available set. Claude Code's built-in WebFetch
 * runs a preflight domain-safety check against an upstream that is unreachable
 * from inside a headless container, so it fails for every URL; agents fetch
 * pages with curl/wget instead. The runtime's native web-search tool is left
 * intact. Other runtimes fetch through their own provider-side tooling, so they
 * disallow nothing.
 */
export const RUNTIME_DISALLOWED_TOOLS_ARGS: Record<AgentRuntime, readonly string[]> = {
	// ExitPlanMode is disallowed: under headless `-p` its approval prompt can't be
	// answered, so a model that drifts into plan mode parks there and exits 0 with
	// only a plan written — a false success. Removing the tool forces the agent to
	// act on the work directly.
	[AgentRuntime.ClaudeCode]: ['--disallowedTools', 'WebFetch', 'ExitPlanMode'],
	[AgentRuntime.Codex]: [],
	[AgentRuntime.Gemini]: [],
	[AgentRuntime.OpenCode]: [],
	[AgentRuntime.Grok]: [],
};

/**
 * Whether a runtime's config can hide the MCP tools a connector's method
 * allowlist withholds, so the agent never sees a tool it may not call.
 *
 * This is only the *hiding* leg and it is deliberately not load-bearing: the
 * CLIs are installed unpinned, so a key that works today can be renamed
 * upstream tomorrow. The egress proxy independently rejects a `tools/call`
 * naming a disabled method, which is what actually enforces the allowlist — a
 * `false` here costs an agent a wasted call and a clear error, never access.
 *
 * - **Gemini** — `mcpServers.<name>.includeTools`, a per-server allowlist.
 * - **OpenCode** — the top-level `tools` map, deny-the-namespace then re-allow.
 * - **Claude Code** — `permissions.deny` in the settings file, addressing tools
 *   as `mcp__<server>__<tool>`.
 * - **Codex / Grok** — no per-server tool filter is documented for either CLI.
 *   Emitting a guessed TOML key would risk the CLI rejecting the whole config
 *   and breaking every run on that runtime, which is a far worse failure than
 *   showing an agent a tool the proxy will refuse. Revisit if upstream adds one.
 */
export const RUNTIME_SUPPORTS_MCP_TOOL_FILTER: Record<AgentRuntime, boolean> = {
	[AgentRuntime.ClaudeCode]: true,
	[AgentRuntime.Codex]: false,
	[AgentRuntime.Gemini]: true,
	[AgentRuntime.OpenCode]: true,
	[AgentRuntime.Grok]: false,
};

/**
 * Flags that make each CLI emit structured per-turn events to stdout while
 * the run is in flight, so the run log shows tool calls, thinking, and
 * partial assistant text live instead of silence until the final result.
 * Every supported runtime exposes a newline-delimited JSON (JSONL) stream
 * whose terminal event carries token usage; `agent-stream-parser.ts` renders
 * those events and captures the usage. Codex accepts `--experimental-json` as
 * an alias for `--json`; Gemini's `stream-json` shipped in CLI v0.11.0.
 */
export const RUNTIME_STREAM_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: ['--output-format', 'stream-json', '--verbose'],
	[AgentRuntime.Codex]: ['--json'],
	[AgentRuntime.Gemini]: ['--output-format', 'stream-json'],
	// OpenCode `run --format json` emits raw JSON events whose terminal event
	// carries token usage.
	[AgentRuntime.OpenCode]: ['--format', 'json'],
	// Grok's `streaming-json` emits thought/text/end events. Unlike the others
	// its stream carries NO token usage — cost is recovered post-run from the
	// `--debug-file` tracing spans (added per-run in the runner). See
	// `extractGrokUsageFromDebugLog` in agent-stream-parser.ts.
	[AgentRuntime.Grok]: ['--output-format', 'streaming-json'],
};

/**
 * Args inserted immediately after the runtime binary name. Some CLIs (Codex)
 * gate non-interactive runs behind a subcommand that must precede global
 * flags; others have nothing to add here.
 */
export const RUNTIME_HEADLESS_PREFIX_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: [],
	[AgentRuntime.Codex]: ['exec'],
	[AgentRuntime.Gemini]: [],
	// `opencode run …` gates non-interactive execution behind the `run` subcommand.
	[AgentRuntime.OpenCode]: ['run'],
	// `grok` runs headless directly (the `-p` flag, added as a suffix arg).
	[AgentRuntime.Grok]: [],
};

/**
 * Trailing args that put each CLI into headless/print mode where the prompt
 * arrives via stdin. Claude needs `-p` (print mode); Codex needs the `-`
 * positional to read stdin as the prompt; Gemini auto-detects non-TTY stdin
 * and needs no flag.
 */
export const RUNTIME_HEADLESS_SUFFIX_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: ['-p'],
	[AgentRuntime.Codex]: ['-'],
	[AgentRuntime.Gemini]: [],
	// OpenCode takes the prompt as a positional `message` (appended in arg mode).
	[AgentRuntime.OpenCode]: [],
	// Grok takes the prompt as the value of `-p` (single-turn/print mode); the
	// bridge appends `"$(cat $HEZO_PROMPT_FILE)"` right after it (arg delivery).
	[AgentRuntime.Grok]: ['-p'],
};

export interface AiProviderVerifyEndpoint {
	url: string | ((apiKey: string) => string);
	headers: Record<string, string> | ((apiKey: string) => Record<string, string>);
}

/**
 * Marks a provider as a locally-hosted runner and carries the two things that
 * differ from a vendor API: where it listens by default, and the throwaway token
 * to store when the operator supplies none (`encrypted_credential` is NOT NULL,
 * and these runners either ignore the token entirely or only check it when the
 * operator has explicitly turned auth on).
 */
export interface AiProviderLocalInfo {
	defaultBaseUrl: string;
	authTokenSentinel: string;
}

export interface AiProviderInfo {
	name: string;
	runtimeLabel: string;
	supportsSubscription?: boolean;
	keyPrefix?: string;
	keyPlaceholder: string;
	/**
	 * Present only for locally-hosted providers. When set, the operator supplies
	 * a base URL and `verifyEndpoint` is unused - verification and the model list
	 * are built from that URL instead (see the ai-providers routes).
	 */
	local?: AiProviderLocalInfo;
	verifyEndpoint: AiProviderVerifyEndpoint;
}

export const AI_PROVIDER_INFO: Record<AiProvider, AiProviderInfo> = {
	[AiProvider.Anthropic]: {
		name: 'Anthropic',
		runtimeLabel: 'Claude Code',
		supportsSubscription: true,
		keyPrefix: 'sk-ant-',
		keyPlaceholder: 'sk-ant-...',
		verifyEndpoint: {
			url: 'https://api.anthropic.com/v1/models',
			headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
		},
	},
	[AiProvider.OpenAI]: {
		name: 'OpenAI',
		runtimeLabel: 'Codex',
		supportsSubscription: true,
		keyPrefix: 'sk-',
		keyPlaceholder: 'sk-...',
		verifyEndpoint: {
			url: 'https://api.openai.com/v1/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	[AiProvider.Google]: {
		name: 'Google',
		runtimeLabel: 'Gemini',
		supportsSubscription: true,
		keyPlaceholder: 'AIza...',
		verifyEndpoint: {
			url: (apiKey) => `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
			headers: {},
		},
	},
	[AiProvider.DeepSeek]: {
		name: 'DeepSeek',
		runtimeLabel: 'Claude Code',
		keyPlaceholder: 'sk-...',
		verifyEndpoint: {
			url: 'https://api.deepseek.com/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	[AiProvider.ZAi]: {
		name: 'z.ai',
		runtimeLabel: 'Claude Code',
		keyPlaceholder: 'z.ai api key',
		verifyEndpoint: {
			url: 'https://api.z.ai/api/paas/v4/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	[AiProvider.OpenRouter]: {
		name: 'OpenRouter',
		runtimeLabel: 'OpenCode',
		keyPrefix: 'sk-or-',
		keyPlaceholder: 'sk-or-...',
		// `/api/v1/models` is the OpenRouter catalog (drives the model dropdown).
		// It's public, so this doubles as a reachability check rather than a
		// strict key validation — a bad key surfaces on the first run.
		verifyEndpoint: {
			url: 'https://openrouter.ai/api/v1/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	[AiProvider.Kimi]: {
		name: 'Kimi',
		runtimeLabel: 'Claude Code',
		keyPlaceholder: 'sk-...',
		// Moonshot's OpenAI-compatible catalog. Drives both key verification and
		// the default-model dropdown; returns the standard `data[]` shape.
		verifyEndpoint: {
			url: 'https://api.moonshot.ai/v1/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	[AiProvider.XAi]: {
		name: 'xAI',
		runtimeLabel: 'Grok Build',
		keyPrefix: 'xai-',
		keyPlaceholder: 'xai-...',
		// xAI's OpenAI-compatible catalog. Drives key verification and the
		// default-model dropdown (grok-4.5, grok-build-0.1, …); standard `data[]`.
		verifyEndpoint: {
			url: 'https://api.x.ai/v1/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	// Local runners. `verifyEndpoint` is a formality for these two - the routes
	// branch on `local` first and build `<baseUrl>/v1/models` from the operator's
	// configured URL - but the field is required by the interface, so it points at
	// the default port and stays correct for an out-of-the-box install.
	[AiProvider.Ollama]: {
		name: 'Ollama',
		runtimeLabel: 'Claude Code',
		keyPlaceholder: 'not required',
		local: { defaultBaseUrl: 'http://localhost:11434', authTokenSentinel: 'ollama' },
		verifyEndpoint: {
			url: 'http://localhost:11434/v1/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
	[AiProvider.LmStudio]: {
		name: 'LM Studio',
		runtimeLabel: 'Claude Code',
		keyPlaceholder: 'not required',
		local: { defaultBaseUrl: 'http://localhost:1234', authTokenSentinel: 'lmstudio' },
		verifyEndpoint: {
			url: 'http://localhost:1234/v1/models',
			headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
		},
	},
};

export const ALL_AI_PROVIDERS: ReadonlyArray<AiProvider> = Object.values(AiProvider);

export interface AiProviderModel {
	id: string;
	label: string;
}

/**
 * Normalise the response from a provider's `/v1/models` (or equivalent)
 * endpoint into a uniform list. Each provider returns its catalog in a slightly
 * different shape and surfaces models unrelated to chat (embeddings, moderation,
 * TTS, image generation). This filters to the models an agent CLI can actually
 * be pointed at.
 */
export function parseProviderModels(provider: AiProvider, json: unknown): AiProviderModel[] {
	if (!json || typeof json !== 'object') return [];
	const body = json as Record<string, unknown>;

	if (provider === AiProvider.Google) {
		const models = Array.isArray(body.models) ? (body.models as Record<string, unknown>[]) : [];
		return models
			.filter((m) => {
				const methods = m.supportedGenerationMethods;
				if (!Array.isArray(methods)) return true;
				return methods.includes('generateContent');
			})
			.map((m) => {
				const raw = typeof m.name === 'string' ? m.name : '';
				const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
				const label = typeof m.displayName === 'string' && m.displayName ? m.displayName : id;
				return { id, label };
			})
			.filter((m) => m.id);
	}

	const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
	return data
		.map((m) => {
			const id = typeof m.id === 'string' ? m.id : '';
			// OpenRouter labels models under `name`; OpenAI-style APIs use `display_name`.
			const displayName =
				(typeof m.display_name === 'string' && m.display_name) ||
				(typeof m.name === 'string' && m.name) ||
				'';
			return { id, label: displayName || id };
		})
		.filter((m) => m.id && isChatModelId(provider, m.id));
}

function isChatModelId(provider: AiProvider, id: string): boolean {
	const lower = id.toLowerCase();
	if (provider === AiProvider.OpenAI) {
		if (/(embedding|whisper|tts|audio|dall-e|image|moderation|omni-moderation)/.test(lower)) {
			return false;
		}
	}
	return true;
}
