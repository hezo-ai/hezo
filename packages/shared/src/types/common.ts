export const MemberType = { Agent: 'agent', User: 'user' } as const;
export type MemberType = (typeof MemberType)[keyof typeof MemberType];

export const AgentRuntime = {
	ClaudeCode: 'claude_code',
	Codex: 'codex',
	// Google's Antigravity CLI (`agy`), the successor to the Gemini CLI, which
	// Google retired for consumer accounts on 2026-06-18. Unlike the `kimi` label
	// reuse below, `antigravity` is a genuinely new DB `agent_runtime` value and
	// needs an ALTER TYPE (see the migration that adds it). The old `gemini` label
	// stays in the DB enum (Postgres can't drop it) but no runtime maps to it any
	// more; stored `gemini` rows resolve to the provider default via
	// `effectiveRuntime`, and gemini-pinned tasks are nulled by that migration.
	Antigravity: 'antigravity',
	OpenCode: 'opencode',
	Grok: 'grok',
	// Moonshot's first-party Kimi Code CLI (`kimi`). The `kimi` label predates
	// this entry: it was the original standalone Kimi runtime, retired by
	// migration 010 when Kimi moved onto Claude Code. Reusing the label means the
	// DB `agent_runtime` enum needs no ALTER TYPE, and no rows select it (010
	// nulled every `tasks.runtime_type = 'kimi'` pin). Note this runtime is
	// *additional* to — not a replacement for — Kimi on Claude Code: the `kimi`
	// provider offers both, defaulting to `claude` against Moonshot's
	// Anthropic-compatible gateway.
	Kimi: 'kimi',
} as const;
export type AgentRuntime = (typeof AgentRuntime)[keyof typeof AgentRuntime];

const AGENT_RUNTIME_VALUES: readonly string[] = Object.values(AgentRuntime);

/**
 * Narrow an untrusted value (a request body field, a DB enum column read back)
 * to a runtime this binary knows. A stored runtime can outlive the label — the
 * `agent_runtime` enum is append-only in Postgres — so reads go through this
 * rather than a cast.
 */
export function isAgentRuntime(value: unknown): value is AgentRuntime {
	return typeof value === 'string' && AGENT_RUNTIME_VALUES.includes(value);
}

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

/**
 * Which feature set an agent's generated avatar draws from. Not an identity
 * claim about the agent - purely which pixel-art hair, face and build the
 * generator composes. `Neutral` means "not stated", and the generator resolves
 * it from the avatar seed so the face is still stable.
 *
 * Marketplace roles ship an explicit value; a name-derived guess
 * (`inferGender`) is only used for a bespoke hire nobody authored.
 */
export const AgentGender = {
	Female: 'f',
	Male: 'm',
	Neutral: 'n',
} as const;
export type AgentGender = (typeof AgentGender)[keyof typeof AgentGender];

export function isAgentGender(value: unknown): value is AgentGender {
	return value === 'f' || value === 'm' || value === 'n';
}

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
// Append, never reorder: this order renders directly into the generated
// `docs/reference/mcp-api.md` enum table for `full_text_search`.
export const SEARCH_SCOPES = [
	'all',
	'tasks',
	'skills',
	'project_docs',
	'comments',
	'assets',
] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_RESULT_TYPES = ['task', 'skill', 'project_doc', 'comment', 'asset'] as const;
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
	/** Asset library path (`original_filename`, folders included) for the asset viewer route (assets). */
	assetFilename?: string;
	/** Asset MIME, so the palette draws the same per-type glyph as the assets grid (assets). */
	assetContentType?: string;
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

/**
 * Ceiling on any `/api` request body - a backstop against an unbounded body, not
 * a per-route policy. It MUST stay comfortably above every per-route cap:
 *
 * - A route that validates size itself (comment attachments) answers a too-large
 *   file with its own specific `400`. If the global limit trips first the caller
 *   gets an opaque `413` instead, and the route's rule stops being reachable.
 * - The caps above measure the *file*; the request carries it in a multipart
 *   envelope with a boundary and part headers, so a legitimately-sized upload is
 *   always somewhat larger on the wire. A global limit set to exactly
 *   `ATTACHMENT_MAX_BYTES` therefore rejects a *valid* maximum-size attachment.
 *
 * A test asserts this stays greater than every per-route cap.
 */
export const API_BODY_MAX_BYTES = 32 * 1024 * 1024;

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
	// Archive containers: a bundle of files handed to (or produced by) a team as
	// one attachment. `.tar.gz` resolves through its `gz` extension and keeps its
	// full double-extension name.
	zip: 'application/zip',
	tar: 'application/x-tar',
	gz: 'application/gzip',
	tgz: 'application/gzip',
	'7z': 'application/x-7z-compressed',
	rar: 'application/vnd.rar',
} as const;
export type AttachmentExtension = keyof typeof ATTACHMENT_EXTENSIONS;

export const ATTACHMENT_MIME_ALLOWLIST: ReadonlySet<string> = new Set(
	Object.values(ATTACHMENT_EXTENSIONS),
);

// Archive container types. Opaque to Hezo: nothing is ever extracted server-side,
// so an archive is stored and served as bytes. Agents download one by signed URL
// and unpack it inside their own container (`unzip`, `tar` and `7z` are pre-baked
// in the agent image). Drives three decisions: the stored content type ignores what the
// uploader declared (see `resolveAttachmentContentType`), the serve route never
// sends one inline (see `assetContentDisposition`), and the web renders an
// archive glyph for it.
export const ASSET_ARCHIVE_MIME: ReadonlySet<string> = new Set([
	'application/zip',
	'application/x-tar',
	'application/gzip',
	'application/x-7z-compressed',
	'application/vnd.rar',
]);

export function isArchiveAssetMime(mime: string): boolean {
	return ASSET_ARCHIVE_MIME.has(mime);
}

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
	// Two distinct reasons never to render inline, each with its own table: a type
	// that can carry active script (above), and an archive, which is an opaque
	// container with nothing to display in a tab.
	if (ASSET_INLINE_UNSAFE_MIME.has(contentType)) return 'attachment';
	if (isArchiveAssetMime(contentType)) return 'attachment';
	return 'inline';
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
 * Content types whose stored value is always the extension's canonical type,
 * ignoring what the uploader declared:
 *
 * - `text/plain` — storing the inert type is the point. Browsers send
 *   `text/javascript` for `.js`, `application/json` for `.json`, `text/csv` for
 *   `.csv`, … and the serving route's nosniff header prevents re-interpretation.
 * - Archives — browsers disagree wildly on the declared type for one format. A
 *   `.zip` arrives as `application/zip` (Firefox, Safari),
 *   `application/x-zip-compressed` (Windows Chrome and Edge), `multipart/x-zip`,
 *   or `application/octet-stream` depending on OS and browser, so the extension
 *   is the only reliable signal. Deferring to it also *narrows* what can be
 *   stored: an archive extension can only ever carry its own canonical type.
 */
const ATTACHMENT_EXTENSION_AUTHORITATIVE_MIME: ReadonlySet<string> = new Set([
	'text/plain',
	...ASSET_ARCHIVE_MIME,
]);

/**
 * Resolve the content type to store for an uploaded asset, or null when the
 * upload must be rejected. Extensions whose canonical type is authoritative
 * (see above) always store that type. Other extensions keep the original
 * posture: a declared allowlisted type wins, a blank or
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
	if (ATTACHMENT_EXTENSION_AUTHORITATIVE_MIME.has(extMime)) return extMime;
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

/**
 * One row of the admin's inbox, anchored to the comment that needs them. Most
 * are literal `@admin` mentions; `fireAdminMention` also raises one for an
 * actionable comment carrying no `@admin` text, so read `content_type` to know
 * which kind of ask this is rather than assuming a mention.
 */
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
	/** The anchored comment's kind - what the admin is being asked for. */
	content_type: CommentContentType;
	/** Secret name on a `credential_request` row, null on every other kind. */
	credential_name: string | null;
	snippet: string;
	author_member_id: string | null;
	author_display_name: string;
	author_slug: string | null;
	/**
	 * Freshly-signed avatar URL for a human author's `user_icons` image, or null.
	 * An agent author has none - its face is generated client-side from
	 * `author_avatar_spec`, and the built-in CEO/Coach portraits resolve from
	 * `author_slug`.
	 */
	author_icon_url: string | null;
	/** The agent author's avatar spec (see `pixel-avatar.ts`), absent for a human. */
	author_avatar_spec?: unknown;
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

/**
 * Wakeup states the dispatcher may still act on. `deferred` counts as active:
 * a wakeup blocked on an open dependency is re-queued when the blocker clears.
 */
export const ACTIVE_WAKEUP_STATUSES: readonly WakeupStatus[] = [
	WakeupStatus.Queued,
	WakeupStatus.Claimed,
	WakeupStatus.Deferred,
];

/**
 * Wakeup states nothing will look at again. Listed explicitly rather than
 * derived as "everything not active" so a newly added status is not silently
 * classified as disposable - these are the rows the maintenance sweep deletes,
 * and the failure mode of guessing wrong is deleting work that was still
 * pending. A test asserts the two lists partition the enum exactly, so adding a
 * status fails the build until someone decides which side it belongs on.
 */
export const TERMINAL_WAKEUP_STATUSES: readonly WakeupStatus[] = [
	WakeupStatus.Completed,
	WakeupStatus.Failed,
	WakeupStatus.Skipped,
	WakeupStatus.Coalesced,
	WakeupStatus.Cancelled,
];

export const WakeupSkipReason = {
	TaskBusy: 'task_busy',
	InstanceAtCapacity: 'instance_at_capacity',
	AgentRunning: 'agent_running',
	OverBudget: 'over_budget',
	/**
	 * The agent's last run on this task ended in `report_no_work` and nothing has
	 * landed on the task since, so re-dispatching would bill an identical no-op.
	 * Lifts on its own once the agent's heartbeat interval elapses, or immediately
	 * on new input. See `services/no-work-backoff.ts`.
	 */
	NoWorkCooldown: 'no_work_cooldown',
	/**
	 * Another run still held the rotating provider credential when this one gave
	 * up waiting. Distinct from `InstanceAtCapacity` because the two waits clear
	 * on different clocks: capacity frees when the idle pass reclaims a container,
	 * this frees only when a whole other run finishes.
	 */
	CredentialBusy: 'credential_busy',
	/**
	 * A queued run's host-side driver vanished before the agent launched, so the
	 * work was handed back. Not a capacity wait: nothing is being waited on, and
	 * the dispatcher should pick this up on its next tick.
	 */
	RunNeverStarted: 'run_never_started',
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

/**
 * Bucket size for the Activity page's per-agent hours series. The value is
 * passed straight to Postgres `date_trunc`, so the strings must stay valid
 * field names there.
 */
export const HoursBucket = {
	Day: 'day',
	Week: 'week',
	Month: 'month',
} as const;
export type HoursBucket = (typeof HoursBucket)[keyof typeof HoursBucket];

/**
 * How many buckets of each size the hours series returns. The response is an
 * aggregate rather than a list - its row count is buckets x roster size, both
 * bounded - so these caps are what keep it bounded rather than a cursor.
 */
export const HOURS_BUCKET_SPAN: Record<HoursBucket, number> = {
	day: 30,
	week: 12,
	month: 12,
};

export function isHoursBucket(value: string): value is HoursBucket {
	return value === HoursBucket.Day || value === HoursBucket.Week || value === HoursBucket.Month;
}

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
 * Sort weight for a capped goal list: worst health first. A surface showing only some of a
 * project's goals should spend those slots on the ones needing a decision, so 'off_track' leads
 * and 'on_track' trails. 'pending' sits between at-risk and on-track: unassessed is not a
 * problem, but it is less settled than a goal the Captain has confirmed is fine.
 *
 * Full goal lists stay in their own stable order - this ranks only what a cap has to choose.
 */
export const GOAL_HEALTH_TRIAGE_RANK: Record<GoalHealth, number> = {
	[GoalHealth.OffTrack]: 0,
	[GoalHealth.AtRisk]: 1,
	[GoalHealth.Pending]: 2,
	[GoalHealth.OnTrack]: 3,
};

/** Worst-health-first ordering for a capped goal list. Ties keep the input order. */
export function sortGoalsByTriage<T extends { health: GoalHealth }>(goals: readonly T[]): T[] {
	return [...goals].sort(
		(a, b) => (GOAL_HEALTH_TRIAGE_RANK[a.health] ?? 4) - (GOAL_HEALTH_TRIAGE_RANK[b.health] ?? 4),
	);
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

/**
 * The Captain-maintained project progress shown at the top of the project dashboard: one
 * high-level narrative, rewritten whole on each progress-update run.
 */
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

/**
 * What a `system`-role chat message records. System rows are meta markers rather
 * than conversation turns, and the chatbox renders each kind differently, so the
 * kind is a property of the message: reading it off the conversation (as the
 * converted-task marker once did) misrenders every other kind in a thread that
 * was later converted.
 */
export const ChatSystemMessageKind = {
	/** The thread was converted into a task; the marker links it. */
	ConvertedTask: 'converted_task',
	/**
	 * A comment the CEO posted on a project task named a teammate without an
	 * active `@`-mention and left the task open, so nobody was notified. Written
	 * by the chat's no-wake exit check.
	 */
	HandoffNotDelivered: 'handoff_not_delivered',
	/**
	 * A hosted connector refused a request a turn of the session made, or could
	 * not be sent its credential. Two rows per refusal: what the turn saw, then
	 * what Hezo's own re-check of the connector found.
	 */
	ConnectorRefused: 'connector_refused',
	/**
	 * The turn is parked until another execution finishes with the provider
	 * credential it needs, on a subscription that runs one agent at a time. The
	 * content names that execution and links to it when it is a task run.
	 */
	CredentialWait: 'credential_wait',
} as const;
export type ChatSystemMessageKind =
	(typeof ChatSystemMessageKind)[keyof typeof ChatSystemMessageKind];

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
	/**
	 * The container stopped without losing its filesystem, and the session is
	 * waiting to resume into it. Live, not terminal: the row still owns its
	 * container and still blocks a second session.
	 *
	 * A chat session holds no long-lived process - each turn is its own exec and
	 * continuity comes from `chat_conversations`/`chat_messages` - so nothing the
	 * session needs is lost. What does not survive is the host-side half: the ssh
	 * socket and egress proxy allocations, whose ports change, which is why resume
	 * re-runs that half rather than being a no-op.
	 */
	Suspended: 'suspended',
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
 * The run statuses that count as an error - a run that ended badly rather than
 * one still going or one that finished. Read by the run-history filter's SQL and
 * by the web, so it lives here rather than being spelled out on either side.
 */
export const ERRORED_RUN_STATUSES = [
	HeartbeatRunStatus.Failed,
	HeartbeatRunStatus.TimedOut,
] as const;

/** Whether a run ended in an error state. */
export function isErroredRunStatus(status: HeartbeatRunStatus): boolean {
	return (ERRORED_RUN_STATUSES as readonly HeartbeatRunStatus[]).includes(status);
}

/**
 * List-view filter for an agent's run history.
 *
 * `All` is the default: a reader looking for what went wrong should not have to
 * discover a control first, and the back link from a run detail page has to land
 * somewhere that can show the run it came from whatever its outcome. The other
 * two narrow to a single outcome each, so every option is exactly what its label
 * says - `Succeeded` is the `succeeded` status alone, not "everything that did
 * not error", which would put a cancelled run under a tab called Succeeded.
 */
export const RunOutcomeFilter = {
	/** Default: every run, whatever its status. */
	All: 'all',
	/** Only runs that finished cleanly. */
	Succeeded: 'succeeded',
	/** Only the errored runs. */
	Errored: 'errored',
} as const;
export type RunOutcomeFilter = (typeof RunOutcomeFilter)[keyof typeof RunOutcomeFilter];

export function isRunOutcomeFilter(value: unknown): value is RunOutcomeFilter {
	return typeof value === 'string' && (Object.values(RunOutcomeFilter) as string[]).includes(value);
}

/** Whether a run with the given status passes the given run-outcome filter. */
export function matchesRunOutcomeFilter(
	status: HeartbeatRunStatus,
	filter: RunOutcomeFilter,
): boolean {
	if (filter === RunOutcomeFilter.Errored) return isErroredRunStatus(status);
	if (filter === RunOutcomeFilter.Succeeded) return status === HeartbeatRunStatus.Succeeded;
	return true;
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

/**
 * Why Hezo's last probe of a hosted MCP server failed. Mirrors the
 * `connector_probe_error` PG enum.
 *
 * A closed set on purpose: the value reaches operators and agents, while the
 * underlying transport message quotes the upstream body, and an upstream that
 * echoes its request headers back would put a live credential in a column. The
 * full detail stays in the server log.
 */
export const ConnectorProbeError = {
	/** The server demanded a credential the probe could not supply. */
	AuthRequired: 'auth_required',
	/** The server refused, timed out, or spoke something other than MCP. */
	Unreachable: 'unreachable',
} as const;
export type ConnectorProbeError = (typeof ConnectorProbeError)[keyof typeof ConnectorProbeError];

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
	// One Moonshot provider, two CLIs. It used to be two providers (`kimi` on
	// Claude Code, `kimi_code` on Moonshot's own CLI) only because a runtime was
	// pinned to its provider; now that a credential carries its own runtime the
	// pair is one entry offering both. Migration 054 re-points existing
	// `kimi_code` rows onto `kimi` with `runtime = 'kimi'`, so they keep running
	// on the same CLI. The `'kimi_code'` label stays in the DB enum (Postgres
	// cannot drop one) but is unreachable.
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
 * The env one provider needs to run on ONE particular CLI: any static entries
 * (base URL, model defaults, …) plus the env var that carries the credential
 * value for each supported auth method. Agents that read a different var won't
 * see the credential.
 *
 * A provider that can be driven by more than one CLI needs one of these per
 * CLI, because the same credential lands in a different variable and alongside
 * different static entries depending on which binary reads it — a Moonshot key
 * is `ANTHROPIC_AUTH_TOKEN` next to an `ANTHROPIC_BASE_URL` for Claude Code,
 * and `KIMI_MODEL_API_KEY` next to the `KIMI_MODEL_*` family for Kimi Code.
 */
export interface ProviderRuntimeBinding {
	staticEnv?: Readonly<Record<string, string>>;
	credentialEnvByAuthMethod: Partial<Record<AiAuthMethod, string>>;
}

/**
 * Per-provider configuration that varies even when multiple providers share a
 * runtime. Each provider declares the CLI runtime it's driven through by
 * default, that runtime's binding (inline, as the adapter's own fields), and
 * optionally the other CLIs it can be driven by. Runtime-only knobs (CLI
 * binary, MCP injection, headless flags, effort mapping) live in the
 * `RUNTIME_*` maps below and are shared across every provider on that runtime.
 *
 * The provider-to-runtime relationship is one-to-MANY: an operator picks the
 * CLI per credential (`ai_provider_configs.runtime`, null = this default), so
 * nothing here may assume a provider implies a single runtime. Resolve a
 * provider's env through {@link providerRuntimeBinding}, never by reading the
 * adapter's own `staticEnv`/`credentialEnvByAuthMethod` directly — those are
 * the DEFAULT runtime's binding and are wrong for any other choice.
 */
export interface ProviderRuntimeAdapter extends ProviderRuntimeBinding {
	/** The CLI this provider runs on when the operator hasn't picked another. */
	runtime: AgentRuntime;
	/**
	 * Other CLIs that can drive this provider, each carrying the env deltas that
	 * CLI needs instead of the adapter's own. Absent means the provider runs on
	 * exactly one CLI and the picker is hidden for it.
	 */
	alternateRuntimes?: Partial<Record<AgentRuntime, ProviderRuntimeBinding>>;
}

/**
 * Moonshot's default coding model, shared by both ways of running Kimi: Claude
 * Code against the Anthropic-compatible gateway, and Moonshot's own CLI. Both
 * bindings below carry it, and either Moonshot provider can be configured onto
 * either binding. It is only a *default* — an agent or task may select any model
 * the provider catalog returns, which is why both bindings let the run's
 * selected model override it.
 *
 * Keep a `model_pricing` row for whatever this points at: runs are priced solely
 * from that table, so an unpriced model records $0.
 */
export const KIMI_DEFAULT_MODEL = 'kimi-k3';

/**
 * Context window per Moonshot model, for the one place a window has to be
 * declared rather than discovered.
 *
 * Kimi Code learns a model's metadata from the provider catalog, but the
 * `KIMI_MODEL_*` family registers an *in-memory* provider it can look nothing up
 * for - so it refuses to start unless the window is stated. Declaring one too
 * large is the harmful direction (the CLI compacts too late and the endpoint
 * rejects the request), so an unlisted model takes the smallest window Moonshot
 * currently ships rather than the largest.
 */
const KIMI_CONTEXT_FALLBACK = 262_144;
const KIMI_MODEL_CONTEXT_SIZES: Record<string, number> = {
	'kimi-k3': 1_048_576,
};

/** The context window to declare for a Moonshot model. See the table above. */
export function kimiModelContextSize(model: string | null | undefined): number {
	return KIMI_MODEL_CONTEXT_SIZES[model?.trim() ?? ''] ?? KIMI_CONTEXT_FALLBACK;
}

/**
 * Moonshot reached through Claude Code, against the Anthropic-compatible
 * gateway — the same pattern as DeepSeek/Z.ai. `ENABLE_TOOL_SEARCH` and
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` are Moonshot's documented Claude Code
 * settings (https://platform.kimi.ai/docs/guide/agent-support).
 *
 * `kimi`'s default binding; `MOONSHOT_KIMI_CODE_BINDING` below is its alternate.
 * The point of the pair is that the same key reaches the same upstream either
 * way, so the two must stay in step.
 */
const MOONSHOT_CLAUDE_CODE_BINDING: ProviderRuntimeBinding = {
	staticEnv: {
		ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
		ANTHROPIC_DEFAULT_OPUS_MODEL: KIMI_DEFAULT_MODEL,
		ANTHROPIC_DEFAULT_SONNET_MODEL: KIMI_DEFAULT_MODEL,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: KIMI_DEFAULT_MODEL,
		CLAUDE_CODE_SUBAGENT_MODEL: KIMI_DEFAULT_MODEL,
		ENABLE_TOOL_SEARCH: 'false',
		CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
	},
	credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_AUTH_TOKEN' },
};

/**
 * Moonshot reached through Moonshot's own first-party CLI (`kimi`), at `/v1`
 * (OpenAI-shaped) rather than at `/anthropic`. `kimi`'s alternate binding.
 *
 * Credential delivery is the unusual part. Kimi Code deliberately does NOT read
 * provider API keys from the shell environment; they are expected to live in
 * `config.toml` under `[providers.<name>]`. The one documented exception is the
 * `KIMI_MODEL_*` family, which IS shell-read and registers a temporary
 * in-memory provider for the launch. Hezo uses that family so the key stays in
 * env only — writing it into a config file the agent can read would breach the
 * plaintext-secret rule (only the run CLI's own model-provider credential may
 * be in-run, and only via env).
 *
 * `KIMI_MODEL_NAME` is what ACTIVATES the family, so it must always be set;
 * `buildProviderEnv` overrides it with the run's selected model when there is
 * one. `KIMI_MODEL_CAPABILITIES` must include `image_in` or the CLI's
 * `downgradeUnsupportedMedia` step silently replaces every image part with
 * "[image omitted: current model has no image input]" — which would break
 * `read_project_asset`, the only path by which an agent ever sees an image.
 * Capabilities resolve as a union of declared + auto-detected, so declaring can
 * only add.
 */
const MOONSHOT_KIMI_CODE_BINDING: ProviderRuntimeBinding = {
	staticEnv: {
		KIMI_MODEL_PROVIDER_TYPE: 'kimi',
		KIMI_MODEL_BASE_URL: 'https://api.moonshot.ai/v1',
		KIMI_MODEL_NAME: KIMI_DEFAULT_MODEL,
		// An in-memory provider has no catalog to read a window from, and the CLI
		// refuses to run without one. Overridden per run from the selected model.
		KIMI_MODEL_MAX_CONTEXT_SIZE: String(kimiModelContextSize(KIMI_DEFAULT_MODEL)),
		KIMI_MODEL_CAPABILITIES: 'image_in,thinking',
		KIMI_DISABLE_TELEMETRY: '1',
		KIMI_CODE_NO_AUTO_UPDATE: '1',
	},
	credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'KIMI_MODEL_API_KEY' },
};

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
		runtime: AgentRuntime.Antigravity,
		// The Antigravity CLI (`agy`) authenticates the Gemini API from GEMINI_API_KEY
		// when `~/.gemini/antigravity-cli/settings.json` carries `modelProvider:gemini`
		// (both written by its adapter). API-key only in Hezo for now: Antigravity has
		// a consumer subscription (Login with Google), but its keyring-only OAuth needs
		// an interactive login Hezo cannot yet deliver into a per-run container.
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
	// One Moonshot provider reachable by two CLIs against the same upstream with
	// the same key: Claude Code at `/anthropic` (the default) and Moonshot's own
	// `kimi` at `/v1`. Neither supersedes the other, and an operator switches a
	// credential between them without re-adding it.
	//
	// Selection precedence: the credential's own runtime, else this default; pick
	// per agent (`model_override_provider`) or per task (`tasks.runtime_type`).
	[AiProvider.Kimi]: {
		runtime: AgentRuntime.ClaudeCode,
		...MOONSHOT_CLAUDE_CODE_BINDING,
		alternateRuntimes: { [AgentRuntime.Kimi]: MOONSHOT_KIMI_CODE_BINDING },
	},
	// xAI Grok Build runs on its own first-party `grok` CLI (its own runtime),
	// authenticated by XAI_API_KEY sent direct to api.x.ai (the sanctioned
	// model-provider credential — no MITM). No subscription auth; api-key only.
	// The grok CLI reads its config from $GROK_HOME (see RUNTIME_HOME_LAYOUTS),
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
	// One host either way: `/anthropic` under Claude Code, `/v1` under Kimi Code.
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
	runtime?: AgentRuntime | null,
): readonly string[] {
	// Read the base URL off the RESOLVED runtime's binding: the two CLIs a
	// Moonshot credential can run on name it differently (`ANTHROPIC_BASE_URL` vs
	// `KIMI_MODEL_BASE_URL`), so checking only the Anthropic spelling would miss
	// it entirely for a credential switched to the native CLI.
	const binding = providerRuntimeBinding(provider, runtime ?? PROVIDER_TO_RUNTIME[provider]);
	const staticEnv = binding?.staticEnv ?? PROVIDER_RUNTIME_ADAPTERS[provider]?.staticEnv;
	const baseUrl =
		configuredBaseUrl || staticEnv?.ANTHROPIC_BASE_URL || staticEnv?.KIMI_MODEL_BASE_URL;
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
 * Per-provider fixups applied to a model id before it reaches the Claude Code
 * CLI. A provider absent here needs none, which is the common case.
 */
const CLAUDE_CODE_MODEL_FIXUPS: Partial<Record<AiProvider, (model: string) => string>> = {
	// DeepSeek runs append `[1m]` themselves, so carrying it in env or `--model`
	// yields `deepseek-v4-pro[1m][1m]` and the provider 400s.
	[AiProvider.DeepSeek]: (model) => model.replace(/\[1m\]/gi, ''),
};

/** Normalize a model id before passing it to the Claude Code CLI. */
export function claudeCodeModelArg(provider: AiProvider, model: string): string {
	return CLAUDE_CODE_MODEL_FIXUPS[provider]?.(model) ?? model;
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
export function claudeCodeProviderUsesCustomEndpoint(
	provider: AiProvider,
	runtime?: AgentRuntime | null,
): boolean {
	// The question is about the runtime the run actually uses, not the provider's
	// default: a Moonshot credential switched onto Claude Code reaches a
	// third-party Anthropic-compatible endpoint exactly like `kimi` does, and its
	// judge/subagent models must track the run model the same way.
	const resolved = runtime ?? PROVIDER_RUNTIME_ADAPTERS[provider]?.runtime;
	if (resolved !== AgentRuntime.ClaudeCode) return false;
	// Local providers reach a custom endpoint too, but carry it on the credential
	// rather than in `staticEnv`, so the base-URL probe alone would miss them. The
	// cost rationale for excluding Anthropic above does not apply here: local
	// inference is free, so tracking the run's model costs nothing, and the pinned
	// alternative would be a model the operator may not even have pulled.
	if (isLocalAiProvider(provider)) return true;
	return Boolean(providerRuntimeBinding(provider, resolved)?.staticEnv?.ANTHROPIC_BASE_URL);
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

/**
 * The key a model is addressed by inside an `opencode.json` `provider.<key>.models`
 * map - the same id `opencodeModelArg` qualifies, with the provider prefix taken
 * back off. The two directions live together because they are one fact read twice:
 * `--model` wants `openrouter/deepseek/deepseek-v4-pro`, the config map wants
 * `deepseek/deepseek-v4-pro`, and a config keyed on the qualified form silently
 * configures nothing.
 */
export function opencodeModelKey(provider: AiProvider, model: string): string {
	const key = OPENCODE_PROVIDER_KEY[provider];
	if (!key) return model;
	return model.startsWith(`${key}/`) ? model.slice(key.length + 1) : model;
}

/**
 * Every CLI a provider can be driven by, DEFAULT FIRST. The order is the
 * contract the picker renders in, so the first entry is always the one
 * preselected for a credential that stores no explicit choice.
 */
export function providerRuntimes(provider: AiProvider): readonly AgentRuntime[] {
	const adapter = PROVIDER_RUNTIME_ADAPTERS[provider];
	if (!adapter) return [];
	const alternates = Object.keys(adapter.alternateRuntimes ?? {}) as AgentRuntime[];
	return [adapter.runtime, ...alternates.filter((r) => r !== adapter.runtime)];
}

/** Whether this provider can run on this CLI at all. Guards the stored choice. */
export function providerSupportsRuntime(provider: AiProvider, runtime: AgentRuntime): boolean {
	return providerRuntimes(provider).includes(runtime);
}

/**
 * The CLI a stored credential runs on: its own explicit choice, else the
 * provider's default. This is the ONE place that reading resolves, so the
 * server's env composition and the UI's chip can never disagree about which
 * runtime a credential is on.
 *
 * A stored runtime the provider no longer supports (the roster changed under an
 * existing row) falls back to the default rather than producing a pairing with
 * no env binding — an unrunnable credential should degrade to the working
 * default, not fail the run.
 */
export function effectiveRuntime(
	provider: AiProvider,
	storedRuntime: AgentRuntime | null | undefined,
): AgentRuntime | null {
	if (storedRuntime && providerSupportsRuntime(provider, storedRuntime)) return storedRuntime;
	return PROVIDER_TO_RUNTIME[provider] ?? null;
}

/**
 * The env binding for running `provider` on `runtime`. Pass the RESOLVED
 * runtime (the credential's own choice, else the provider default) — reading
 * the adapter's own fields instead silently returns the default runtime's env,
 * which for a switched credential means the key lands in the wrong variable and
 * the CLI reports no credentials at all.
 *
 * Returns null for a pairing the provider doesn't support, so a stale stored
 * runtime surfaces as an explicit failure rather than a half-built env bag.
 */
/**
 * Runtimes whose CLI Hezo can drive through an interactive sign-in.
 *
 * Lives here rather than beside the drivers themselves because both sides need
 * it: the server to refuse a flow it cannot run, and the web to decide whether
 * to offer a **Sign in** button at all. Two copies would drift into a button
 * that starts something the server declines.
 *
 * The drivers hold the *how* - argv, output parsers, what the operator returns.
 * This is only the *which*, and `subscription-login-drivers.test.ts` asserts the
 * two agree, so adding a driver without listing it here fails the suite.
 *
 * Gemini is absent deliberately: its CLI exposes no auth flag and picks its
 * sign-in from a full-screen menu only arrow keys reach, so there is nothing to
 * drive. Google subscriptions stay on manual paste.
 */
export const RUNTIMES_WITH_GUIDED_SIGN_IN: readonly AgentRuntime[] = [
	AgentRuntime.Codex,
	AgentRuntime.ClaudeCode,
];

/**
 * Whether a provider's sign-in can be driven, for the runtime this credential
 * would actually run on.
 *
 * Resolved through {@link effectiveRuntime}, so a config pinned to an alternate
 * CLI is judged on that CLI rather than the provider's default - a Moonshot key
 * on Claude Code and one on Kimi Code do not have the same answer.
 */
export function providerHasGuidedSignIn(
	provider: AiProvider,
	storedRuntime: AgentRuntime | null | undefined,
): boolean {
	const runtime = effectiveRuntime(provider, storedRuntime);
	return runtime !== null && RUNTIMES_WITH_GUIDED_SIGN_IN.includes(runtime);
}

/**
 * Runtimes whose CLI rewrites its own credential file in place during a run.
 *
 * The value the CLI leaves on disk after it exits is the current one, so it is
 * read back and persisted, or the stored credential falls a rotation behind and
 * the next run fails to refresh. A property of the **CLI**, judged on the
 * resolved runtime. Codex's ChatGPT auth rotates its refresh token this way.
 *
 * This is a DIFFERENT question from whether runs must serialise
 * ({@link credentialSerializesRuns}). Codex rewrites its file (true here) yet its
 * runs are safe in parallel (measured: the refresh token tolerates concurrent
 * reuse within a wide window), so the read-back is made concurrency-safe with a
 * compare-and-set rather than by taking a whole-run lock. Keep them separate: a
 * future CLI could rewrite its file without needing to serialise, or vice versa.
 *
 * Lives here rather than beside the server's runtime-home table because the web
 * reads it too, so a single source can't drift from what the runner does.
 */
export const RUNTIMES_THAT_REWRITE_CREDENTIAL_FILE: readonly AgentRuntime[] = [AgentRuntime.Codex];

/** Whether this runtime's CLI rewrites its credential file mid-run (read it back). */
export function credentialFileRewrittenByCli(runtime: AgentRuntime | null | undefined): boolean {
	return runtime != null && RUNTIMES_THAT_REWRITE_CREDENTIAL_FILE.includes(runtime);
}

/**
 * A rule selecting credentials whose runs must queue one at a time. An omitted
 * field is a wildcard; a rule matches when every field it sets matches the
 * credential's provider, resolved runtime and auth method.
 */
export interface CredentialSerializationRule {
	provider?: AiProvider;
	runtime?: AgentRuntime;
	authMethod?: AiAuthMethod;
}

/**
 * Credentials whose runs serialise. DELIBERATELY EMPTY - no credential currently
 * needs it.
 *
 * Codex was measured to tolerate concurrent runs (its refresh token stays usable
 * across a wide reuse window), so it does not opt in; its mid-run file rewrite is
 * handled by the concurrency-safe read-back ({@link credentialFileRewrittenByCli})
 * instead. The whole serialisation mechanism - the per-credential lock, the
 * bounded wait, the queued-run reason, the chat "credential wait" notice, the
 * provider-form warning - stays wired behind this table so a future CLI that
 * genuinely cannot run twice at once opts in with one rule, e.g.
 * `{ runtime: AgentRuntime.Codex, authMethod: AiAuthMethod.Subscription }`.
 */
let credentialSerializationRules: readonly CredentialSerializationRule[] = [];

/**
 * Install serialisation rules. TEST-ONLY - exercises the dormant mechanism by
 * making a chosen credential serialise. Restore to `[]` in an `afterEach`.
 */
export function setCredentialSerializationRulesForTest(
	rules: readonly CredentialSerializationRule[],
): void {
	credentialSerializationRules = rules;
}

/**
 * Whether runs on this credential have to queue behind one another. Judged on
 * the resolved runtime (the CLI, not the provider default) and the auth method,
 * against {@link credentialSerializationRules} - empty today, so always false.
 */
export function credentialSerializesRuns(
	provider: AiProvider,
	storedRuntime: AgentRuntime | null | undefined,
	authMethod: AiAuthMethod,
): boolean {
	const runtime = effectiveRuntime(provider, storedRuntime);
	return credentialSerializationRules.some(
		(rule) =>
			(rule.provider === undefined || rule.provider === provider) &&
			(rule.authMethod === undefined || rule.authMethod === authMethod) &&
			(rule.runtime === undefined || rule.runtime === runtime),
	);
}

export function providerRuntimeBinding(
	provider: AiProvider,
	runtime: AgentRuntime,
): ProviderRuntimeBinding | null {
	const adapter = PROVIDER_RUNTIME_ADAPTERS[provider];
	if (!adapter) return null;
	if (runtime === adapter.runtime) {
		return {
			staticEnv: adapter.staticEnv,
			credentialEnvByAuthMethod: adapter.credentialEnvByAuthMethod,
		};
	}
	return adapter.alternateRuntimes?.[runtime] ?? null;
}

/**
 * Each provider's DEFAULT runtime — what a credential runs on when it stores no
 * explicit choice. Not "the runtime for this provider": a provider may support
 * several (see {@link providerRuntimes}), so this must never be used to decide
 * how an actual run is configured. Resolve that from the credential row.
 */
export const PROVIDER_TO_RUNTIME: Record<AiProvider, AgentRuntime> = Object.freeze(
	(Object.keys(PROVIDER_RUNTIME_ADAPTERS) as AiProvider[]).reduce(
		(acc, p) => {
			acc[p] = PROVIDER_RUNTIME_ADAPTERS[p].runtime;
			return acc;
		},
		{} as Record<AiProvider, AgentRuntime>,
	),
);

/**
 * Every provider that can run on a given CLI, including via a non-default
 * choice. This is what a task-level `runtime_type` pin searches, so a Moonshot
 * credential is a candidate for both `claude_code` and `kimi` regardless of
 * which of the two providers it was added under.
 */
export const PROVIDERS_BY_RUNTIME: Record<AgentRuntime, readonly AiProvider[]> = Object.freeze(
	(Object.keys(PROVIDER_RUNTIME_ADAPTERS) as AiProvider[]).reduce(
		(acc, p) => {
			for (const r of providerRuntimes(p)) {
				const list = acc[r] ?? [];
				if (!list.includes(p)) list.push(p);
				acc[r] = list;
			}
			return acc;
		},
		{} as Record<AgentRuntime, AiProvider[]>,
	),
);

export const RUNTIME_COMMANDS: Record<AgentRuntime, string> = {
	[AgentRuntime.ClaudeCode]: 'claude',
	[AgentRuntime.Codex]: 'codex',
	[AgentRuntime.Antigravity]: 'agy',
	[AgentRuntime.OpenCode]: 'opencode',
	[AgentRuntime.Grok]: 'grok',
	[AgentRuntime.Kimi]: 'kimi',
};

/**
 * How each CLI is named to an operator. These are product names, so they are
 * NOT translated — the same rule that keeps Captain, CEO and Hezo itself in
 * English across every catalog. Rendered by the credential form's CLI picker
 * and the provider list's CLI chip.
 */
export const AGENT_RUNTIME_LABELS: Record<AgentRuntime, string> = {
	[AgentRuntime.ClaudeCode]: 'Claude Code',
	[AgentRuntime.Codex]: 'Codex',
	[AgentRuntime.Antigravity]: 'Antigravity',
	[AgentRuntime.OpenCode]: 'OpenCode',
	[AgentRuntime.Grok]: 'Grok',
	[AgentRuntime.Kimi]: 'Kimi Code',
};

/**
 * Linux caps a SINGLE argv element at MAX_ARG_STRLEN - 32 pages, 128 KiB -
 * independent of the far larger total ARG_MAX. Exceeding it fails execve with
 * E2BIG ("Argument list too long") before the CLI's main() ever runs.
 *
 * Hezo's prompts clear it routinely: SHARED_INSTRUCTIONS alone is ~111 KB before
 * the role doc, the repo/team/state blocks and the task body. So `'arg'` delivery
 * only works for a runtime whose system half travels out of band
 * (RUNTIME_SYSTEM_PROMPT_FILE), and `assertPromptDeliverable` in the runner
 * refuses the run rather than letting the exec die with a one-line shell error.
 */
export const MAX_SINGLE_ARG_BYTES = 128 * 1024;

export type PromptDelivery = 'stdin' | 'arg' | 'file';

/**
 * How each CLI receives the task prompt, threaded to the container as
 * `HEZO_PROMPT_MODE` and acted on by the exec wrapper (`PROMPT_DELIVERY_SH` and
 * its twin in `docker/scripts/hezo-run-with-bridge`):
 *
 * - `stdin` - the prompt file IS the CLI's stdin (`< $HEZO_PROMPT_FILE`).
 * - `arg`   - the prompt's TEXT becomes a trailing argv element. Bounded by
 *             MAX_SINGLE_ARG_BYTES, so only viable when the bulk of the prompt
 *             travels elsewhere.
 * - `file`  - the CLI opens the file itself; the flag and its path are already
 *             in the server-built argv, so the wrapper appends nothing.
 */
export const RUNTIME_PROMPT_DELIVERY: Record<AgentRuntime, PromptDelivery> = {
	[AgentRuntime.ClaudeCode]: 'stdin',
	[AgentRuntime.Codex]: 'stdin',
	// `agy --input-format text` (in the stream args) reads the prompt from stdin,
	// so the prompt is piped like Codex's, with no size-capped argv element.
	[AgentRuntime.Antigravity]: 'stdin',
	// `opencode run` reads stdin to EOF whenever it is not a TTY and uses it as
	// the message when no positional is given (`resolveRunInput` in the CLI's
	// `cmd/run.ts`), so it needs no flag at all - and unlike the positional form
	// it is not bounded by MAX_ARG_STRLEN.
	[AgentRuntime.OpenCode]: 'stdin',
	// `grok --prompt-file <PATH>` reads the prompt from disk and triggers headless
	// mode on its own; `-p`/`--single` is the same flag under two names, so it is
	// replaced rather than kept alongside. Grok's headless mode deliberately does
	// not read piped stdin, so `stdin` is not an option here.
	[AgentRuntime.Grok]: 'file',
	// `kimi -p <PROMPT>` (--prompt) is a required Commander option-argument: Kimi
	// Code has no prompt-file flag, no stdin-as-prompt mode and no `-` sentinel.
	// It stays on `arg` and keeps its system half in $KIMI_CODE_HOME/AGENTS.md
	// (RUNTIME_SYSTEM_PROMPT_FILE) so the argv element stays small.
	[AgentRuntime.Kimi]: 'arg',
};

/**
 * Basename, inside the runtime's per-run home, of a file the CLI auto-loads as
 * instructions - the escape hatch for a runtime that can only take the prompt as
 * an argv element. When non-null the run's resolved system prompt is written
 * there by that runtime's MCP injector instead of being prepended to the task
 * prompt, and only the task body travels by RUNTIME_PROMPT_DELIVERY.
 *
 * Kimi Code concatenates `$KIMI_CODE_HOME/AGENTS.md` into its system prompt with
 * no size cap (over 32 KB it warns and carries on). Nothing else needs this: the
 * other runtimes carry the whole prompt through stdin or a prompt file.
 */
export const RUNTIME_SYSTEM_PROMPT_FILE: Record<AgentRuntime, string | null> = {
	[AgentRuntime.ClaudeCode]: null,
	[AgentRuntime.Codex]: null,
	[AgentRuntime.Antigravity]: null,
	[AgentRuntime.OpenCode]: null,
	[AgentRuntime.Grok]: null,
	[AgentRuntime.Kimi]: 'AGENTS.md',
};

/**
 * How each CLI is told which model to use.
 *
 * Nearly all take `--model <id>`. Kimi Code does not: its `--model` resolves the
 * id against a `[models."<id>"]` table in `config.toml`, and Hezo registers its
 * model through the shell-read `KIMI_MODEL_*` family instead - an in-memory
 * provider that table knows nothing about. Passing the flag there fails the run
 * outright with `config.invalid: Model "…" is not configured in config.toml`,
 * so the id has to travel on `KIMI_MODEL_NAME` alone (`buildProviderEnv` puts
 * the run's selected model there).
 *
 * Writing the model into `config.toml` instead is not an option: the same file
 * would then need the provider's key, and only env delivery keeps that out of a
 * file the agent can read.
 */
export const RUNTIME_MODEL_DELIVERY: Record<AgentRuntime, 'flag' | 'env'> = {
	[AgentRuntime.ClaudeCode]: 'flag',
	[AgentRuntime.Codex]: 'flag',
	[AgentRuntime.Antigravity]: 'flag',
	[AgentRuntime.OpenCode]: 'flag',
	[AgentRuntime.Grok]: 'flag',
	[AgentRuntime.Kimi]: 'env',
};

/**
 * Flags each CLI needs to run fully non-interactively. Agent runs happen
 * inside locked-down Docker containers driven by `docker exec`, so any prompt
 * for user approval would hang the run indefinitely.
 */
export const RUNTIME_AUTO_APPROVE_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: ['--dangerously-skip-permissions'],
	[AgentRuntime.Codex]: ['--dangerously-bypass-approvals-and-sandbox'],
	[AgentRuntime.Antigravity]: ['--dangerously-skip-permissions'],
	// OpenCode's own auto-approve flag, and NOT `--dangerously-skip-permissions`:
	// that is Claude Code's spelling. OpenCode accepts unknown flags without
	// complaint, so a wrong one here never applies and never announces itself -
	// verify this name against `opencode run --help` rather than assuming a run
	// that starts cleanly is approving anything.
	[AgentRuntime.OpenCode]: ['--auto'],
	// Grok's Claude-Code-style permission modes; bypassPermissions skips every
	// approval prompt so a headless `docker exec` run never hangs on one.
	[AgentRuntime.Grok]: ['--permission-mode', 'bypassPermissions'],
	// Kimi Code needs nothing here, and must not be given anything: `--prompt`
	// is mutually exclusive with `--yolo`/`--auto`/`--plan`, so passing one would
	// make the CLI reject the invocation outright. `-p` already applies the `auto`
	// permission policy to tool calls on its own. If a future version still gates
	// some call under `auto`, the escape hatches are the undocumented
	// `--yes`/`--auto-approve` flags or `[permission.rules]` in the injected
	// config.toml — not a flag that conflicts with `--prompt`.
	[AgentRuntime.Kimi]: [],
};

/**
 * Tools removed from a runtime's available set. Claude Code's built-in WebFetch
 * runs a preflight domain-safety check against an upstream that is unreachable
 * from inside a headless container, so it fails for every URL; agents fetch
 * pages with curl instead. The runtime's native web-search tool is left
 * intact. Other runtimes fetch through their own provider-side tooling, so they
 * disallow nothing.
 */
export const RUNTIME_DISALLOWED_TOOLS_ARGS: Record<AgentRuntime, readonly string[]> = {
	// ExitPlanMode is disallowed: under headless `-p` its approval prompt can't be
	// answered, so a model that drifts into plan mode parks there and exits 0 with
	// only a plan written — a false success. Removing the tool forces the agent to
	// act on the work directly.
	//
	// The three below are removed because Hezo owns what they do, and each of them
	// silently does nothing useful here rather than failing:
	//
	// - **EnterWorktree** switches the session's working directory into
	//   `.claude/worktrees/<name>/`. Hezo prepares the worktree a run works in and
	//   watches *that* for changes (`anyWorktreeChanged`, and the push path after
	//   it), so an agent that moves itself writes where nothing is looking - the
	//   work is invisible and the run grades as having produced nothing.
	// - **CronCreate / CronDelete / CronList** schedule inside the session, and the
	//   container is destroyed when the run ends. Anything scheduled past that
	//   point is silently lost, and Hezo's own heartbeats and wakeups are the real
	//   scheduler.
	// - **ScheduleWakeup** only means anything in `/loop` dynamic mode, which a
	//   one-shot `-p` run is not.
	//
	// Deliberately NOT removed, though a failed run made all three look guilty:
	// the `Task*` family is the agent's own in-session checklist (what replaced
	// TodoWrite) and persists nothing; `Skill` loads `.claude/skills/` from the
	// project's own repo, which is a real capability; and `WebSearch` is proxied
	// server-side so container egress does not affect it. They only misled an
	// agent that had lost its Hezo tools entirely - a transport failure, fixed
	// where transport failures belong.
	[AgentRuntime.ClaudeCode]: [
		'--disallowedTools',
		'WebFetch',
		'ExitPlanMode',
		'EnterWorktree',
		'CronCreate',
		'CronDelete',
		'CronList',
		'ScheduleWakeup',
	],
	[AgentRuntime.Codex]: [],
	[AgentRuntime.Antigravity]: [],
	[AgentRuntime.OpenCode]: [],
	[AgentRuntime.Grok]: [],
	[AgentRuntime.Kimi]: [],
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
 * - **Kimi Code** — per-server `enabledTools` / `disabledTools` keys in
 *   `mcp.json`, which map one-to-one onto the descriptor's own fields.
 * - **Codex / Grok** — no per-server tool filter is documented for either CLI.
 *   Emitting a guessed TOML key would risk the CLI rejecting the whole config
 *   and breaking every run on that runtime, which is a far worse failure than
 *   showing an agent a tool the proxy will refuse. Revisit if upstream adds one.
 */
export const RUNTIME_SUPPORTS_MCP_TOOL_FILTER: Record<AgentRuntime, boolean> = {
	[AgentRuntime.ClaudeCode]: true,
	[AgentRuntime.Codex]: false,
	// agy's mcp_config.json documents no per-server tool allowlist, so Hezo does
	// not rely on one - its MCP server exposes exactly the tools it means to.
	[AgentRuntime.Antigravity]: false,
	[AgentRuntime.OpenCode]: true,
	[AgentRuntime.Grok]: false,
	[AgentRuntime.Kimi]: true,
};

/**
 * The fully-qualified name a connector's tool is addressed by, and the ceiling
 * that name has to fit inside.
 *
 * Anthropic's API and the OpenAI-compatible endpoints both cap a tool name at 64
 * characters. The namespace spends `mcp__`, the connector's own name and `__`
 * before the upstream tool name even begins, so a verbose connector name paired
 * with a verbose tool name can cross it - and at that point the provider, not
 * Hezo, decides what becomes of the tool. Renaming the connector shortens every
 * one of its tools at once, which is why the warning names the connector.
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

export function qualifiedMcpToolName(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`;
}

/**
 * The readable half of a tool name a runtime reported, for showing a human what
 * an agent is doing right now: `mcp__hezo__list_tasks` reads as `list_tasks`,
 * while a native tool (`Bash`, `Edit`) is already its own label and passes
 * through. Presentation only - never use it to identify a tool, since two
 * connectors can expose the same upstream name.
 */
export function displayToolName(tool: string): string {
	const parts = tool.split('__');
	// `mcp__<server>__<tool>`; a connector tool name may itself contain `__`.
	if (parts.length >= 3 && parts[0] === 'mcp') return parts.slice(2).join('__');
	return tool;
}

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
	// `--input-format text` makes agy read the prompt from stdin (stdin delivery);
	// `--output-format stream-json` emits the `{event:...}` frames the parser reads.
	[AgentRuntime.Antigravity]: ['--output-format', 'stream-json', '--input-format', 'text'],
	// OpenCode `run --format json` emits raw JSON events whose terminal event
	// carries token usage. `--thinking` puts the model's reasoning parts on that
	// stream too, so the run log shows them (the parser renders them as
	// `[thinking]`); without it a run reasons invisibly. The CLI is installed
	// unpinned in the agent image, so an upstream rename of this flag would fail
	// every OpenCode run on an unknown argument - check it first if OpenCode runs
	// start dying at exec.
	//
	// `--print-logs` puts the CLI's own diagnostics on stderr, which the runner
	// already relays verbatim, while stdout stays pure JSON. At ERROR level it is
	// near-silent on a healthy run and carries the provider and model behind a
	// failure - context the JSON error event omits, and which the event's own
	// message is sometimes too generic to replace.
	[AgentRuntime.OpenCode]: [
		'--format',
		'json',
		'--thinking',
		'--print-logs',
		'--log-level',
		'ERROR',
	],
	// Grok's `streaming-json` emits thought/text/end events. Unlike the others
	// its stream carries NO token usage — cost is recovered post-run from the
	// `--debug-file` tracing spans (added per-run in the runner). See
	// `extractGrokUsageFromDebugLog` in agent-stream-parser.ts.
	[AgentRuntime.Grok]: ['--output-format', 'streaming-json'],
	// Kimi Code's `stream-json` emits one JSON object per line discriminated by
	// `role` (assistant / tool / meta); it is accepted only alongside `--prompt`.
	// Like Grok — and unlike everything else — its stream carries NO token usage,
	// so cost is recovered post-run from the per-run session log. See
	// `extractKimiUsageFromSessionLog` in agent-stream-parser.ts.
	[AgentRuntime.Kimi]: ['--output-format', 'stream-json'],
};

/**
 * Args inserted immediately after the runtime binary name. Some CLIs (Codex)
 * gate non-interactive runs behind a subcommand that must precede global
 * flags; others have nothing to add here.
 */
export const RUNTIME_HEADLESS_PREFIX_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: [],
	[AgentRuntime.Codex]: ['exec'],
	[AgentRuntime.Antigravity]: [],
	// `opencode run …` gates non-interactive execution behind the `run` subcommand.
	[AgentRuntime.OpenCode]: ['run'],
	// `grok` runs headless directly (the `--prompt-file` flag, added as a suffix arg).
	[AgentRuntime.Grok]: [],
	// `kimi` likewise runs headless directly via the trailing `-p` flag.
	[AgentRuntime.Kimi]: [],
};

/**
 * Trailing args that put each CLI into headless/print mode, immediately before
 * whatever RUNTIME_PROMPT_DELIVERY appends. Claude needs `-p` (print mode);
 * Codex needs the `-` positional to read stdin as the prompt; Gemini and
 * OpenCode auto-detect non-TTY stdin and need no flag.
 *
 * A `'file'`-delivery runtime's flag lives here and its VALUE is appended by
 * `buildRuntimeInvocation`, so argv leaves the server complete.
 */
export const RUNTIME_HEADLESS_SUFFIX_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: ['-p'],
	[AgentRuntime.Codex]: ['-'],
	[AgentRuntime.Antigravity]: [],
	// OpenCode's `run` takes the prompt on stdin when the positional `message` is
	// omitted, so nothing goes here.
	[AgentRuntime.OpenCode]: [],
	// Grok reads the prompt from the path following `--prompt-file`, which
	// triggers headless mode on its own.
	[AgentRuntime.Grok]: ['--prompt-file'],
	// Kimi Code runs one prompt headlessly via `-p`/`--prompt` and streams to
	// stdout, with the prompt text appended as the flag's value.
	[AgentRuntime.Kimi]: ['-p'],
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
		runtimeLabel: 'Antigravity',
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
/**
 * Providers whose model-list response is not the OpenAI-style `{ data: [...] }`
 * shape. A provider absent here is parsed by the default reader below.
 */
const PROVIDER_MODEL_READERS: Partial<
	Record<AiProvider, (body: Record<string, unknown>) => AiProviderModel[]>
> = {
	// Google returns `{ models: [{ name: "models/<id>", displayName, … }] }` and
	// lists far more than chat models, so the generation methods are the filter.
	[AiProvider.Google]: (body) => {
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
	},
};

/**
 * Ids a provider lists that no agent CLI can be pointed at. Keyed per provider
 * because only the provider knows what its own non-chat models look like.
 */
const PROVIDER_NON_CHAT_MODEL_RE: Partial<Record<AiProvider, RegExp>> = {
	[AiProvider.OpenAI]: /(embedding|whisper|tts|audio|dall-e|image|moderation|omni-moderation)/,
};

export function parseProviderModels(provider: AiProvider, json: unknown): AiProviderModel[] {
	if (!json || typeof json !== 'object') return [];
	const body = json as Record<string, unknown>;

	const reader = PROVIDER_MODEL_READERS[provider];
	if (reader) return reader(body);

	const nonChat = PROVIDER_NON_CHAT_MODEL_RE[provider];
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
		.filter((m) => m.id && !nonChat?.test(m.id.toLowerCase()));
}

/**
 * Locale settings — the instance-wide display preferences chosen during
 * onboarding (before the master key exists) and editable afterwards from global
 * settings. Three independent axes, deliberately not collapsed into one BCP-47
 * tag: an operator can read German while preferring ISO dates, and the currency
 * convention is a separate question again.
 *
 * The formatting that consumes these lives in `../i18n/format.js`.
 */

export const Language = {
	En: 'en',
	De: 'de',
	Fr: 'fr',
	Es: 'es',
	It: 'it',
	PtBr: 'pt-BR',
	Nl: 'nl',
	Pl: 'pl',
	Sv: 'sv',
	ZhHans: 'zh-Hans',
	Ja: 'ja',
	Ko: 'ko',
} as const;
export type Language = (typeof Language)[keyof typeof Language];

/** Every supported language, in the order the picker lists them. */
export const LANGUAGES: readonly Language[] = Object.values(Language);

/**
 * Endonyms: each language is named the way its own speakers write it, because a
 * reader who can't yet read the UI still has to find their own language in the
 * list. "Deutsch", never "German".
 */
export const LANGUAGE_LABELS: Record<Language, string> = {
	[Language.En]: 'English',
	[Language.De]: 'Deutsch',
	[Language.Fr]: 'Français',
	[Language.Es]: 'Español',
	[Language.It]: 'Italiano',
	[Language.PtBr]: 'Português (Brasil)',
	[Language.Nl]: 'Nederlands',
	[Language.Pl]: 'Polski',
	[Language.Sv]: 'Svenska',
	[Language.ZhHans]: '简体中文',
	[Language.Ja]: '日本語',
	[Language.Ko]: '한국어',
};

/** Field order for a rendered date. Month names still follow the language. */
export const DateFormat = {
	/** 29/07/2026 */
	Dmy: 'dmy',
	/** 07/29/2026 */
	Mdy: 'mdy',
	/** 2026-07-29 */
	Ymd: 'ymd',
	/** 29 Jul 2026 */
	DMonY: 'd-mon-y',
} as const;
export type DateFormat = (typeof DateFormat)[keyof typeof DateFormat];

export const DATE_FORMATS: readonly DateFormat[] = Object.values(DateFormat);

/**
 * How a money amount is punctuated. Presentation only — Hezo costs are always
 * USD (providers bill in USD and budgets are stored as USD cents), so this
 * never converts a currency, it only picks separators and symbol placement.
 */
export const NumberFormat = {
	/** $1,234.56 */
	DotComma: 'dot-comma',
	/** 1.234,56 $ */
	CommaDot: 'comma-dot',
	/** 1 234,56 $ */
	SpaceComma: 'space-comma',
} as const;
export type NumberFormat = (typeof NumberFormat)[keyof typeof NumberFormat];

export const NUMBER_FORMATS: readonly NumberFormat[] = Object.values(NumberFormat);

/** Snake_case to match the REST/`system_meta` surface these travel over. */
export interface LocaleSettings {
	language: Language;
	date_format: DateFormat;
	number_format: NumberFormat;
}

export const DEFAULT_LOCALE_SETTINGS: LocaleSettings = {
	language: Language.En,
	date_format: DateFormat.Mdy,
	number_format: NumberFormat.DotComma,
};

/**
 * Where agent containers run.
 *
 * Shared because both halves need the same answer: the server selects the
 * backend and reports it, and the web app tells the operator which one is in use
 * and which limits therefore apply. It lived as a hand-written `'docker' |
 * 'daytona'` union in each package, which is two places to update for every new
 * provider.
 */
export const SandboxBackend = {
	/** The operator's own Docker daemon. Containers share the host's memory and disk. */
	Docker: 'docker',
	/** Daytona managed sandboxes. Containers run on the provider's machines. */
	Daytona: 'daytona',
} as const;
export type SandboxBackend = (typeof SandboxBackend)[keyof typeof SandboxBackend];

export const SANDBOX_BACKENDS: readonly SandboxBackend[] = Object.values(SandboxBackend);

export function isSandboxBackend(value: string): value is SandboxBackend {
	return (SANDBOX_BACKENDS as readonly string[]).includes(value);
}

/**
 * The stand-in id for a container that is being provisioned but has no engine id
 * yet.
 *
 * Everything about a container is keyed on the id the engine returns, and there
 * is a real window before that: workspace preparation, resolving the base image,
 * and - on a managed backend - the sandbox build itself, which is the longest
 * part of a cold start. The project is already `creating` and the UI already
 * says so, but the Containers page had nothing to list, so following "View
 * container" from that notice landed on an empty page.
 *
 * A placeholder row closes that. It is deliberately **not** an engine id and
 * nothing may treat it as one - {@link isProvisioningPlaceholder} is how both
 * sides tell them apart, so the removal route refuses it and the UI does not
 * offer Remove for a container that does not exist yet.
 */
export function provisioningContainerKey(projectId: string): string {
	return `provisioning:${projectId}`;
}

export function isProvisioningPlaceholder(containerId: string): boolean {
	return containerId.startsWith('provisioning:');
}

/**
 * Whether a backend runs containers on this machine or on a third party's.
 *
 * This is the only thing about a backend that code outside its own adapter is
 * allowed to know - everything else a provider does differently is that
 * adapter's business. It matches how the docs are split (`docs/containers/
 * local-docker.md` vs `docs/containers/remote/`), so the two cannot drift.
 *
 * A table rather than a predicate over a provider name, so adding a backend is a
 * **compile error** until it declares which kind it is. The alternative -
 * `=== SandboxBackend.Daytona` at each site - states a fact about one service
 * where a property of the whole class is meant, and a new provider then silently
 * inherits whichever branch the comparison happened to fall through to.
 */
export const SANDBOX_BACKEND_KIND: Record<SandboxBackend, 'local' | 'remote'> = {
	[SandboxBackend.Docker]: 'local',
	[SandboxBackend.Daytona]: 'remote',
};

/**
 * Does this backend need an API key before it can be selected?
 *
 * True for every remote backend and false for the local daemon: a third-party
 * container service is reached over the internet behind an account, so an API
 * key is what makes it usable at all, while a local daemon is a socket on the
 * host. That is a property of the class, not of any one provider - which is why
 * this asks the kind rather than naming a service.
 */
export function sandboxBackendNeedsApiKey(backend: SandboxBackend): boolean {
	return SANDBOX_BACKEND_KIND[backend] === 'remote';
}
