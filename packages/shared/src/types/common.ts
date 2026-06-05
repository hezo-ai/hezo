export const MemberType = { Agent: 'agent', User: 'user' } as const;
export type MemberType = (typeof MemberType)[keyof typeof MemberType];

export const AgentRuntime = {
	ClaudeCode: 'claude_code',
	Codex: 'codex',
	Gemini: 'gemini',
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
	Paused: 'paused',
} as const;
export type AgentRuntimeStatus = (typeof AgentRuntimeStatus)[keyof typeof AgentRuntimeStatus];

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

export const TaskStatus = {
	Backlog: 'backlog',
	InProgress: 'in_progress',
	Review: 'review',
	Blocked: 'blocked',
	Done: 'done',
	Closed: 'closed',
	Cancelled: 'cancelled',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
	[TaskStatus.Backlog]: 'Backlog',
	[TaskStatus.InProgress]: 'In Progress',
	[TaskStatus.Review]: 'Review',
	[TaskStatus.Blocked]: 'Blocked',
	[TaskStatus.Done]: 'Done',
	[TaskStatus.Closed]: 'Closed',
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
	Options: 'options',
	Preview: 'preview',
	Trace: 'trace',
	System: 'system',
	Run: 'run',
	Action: 'action',
	CredentialRequest: 'credential_request',
	ConnectRequired: 'connect_required',
} as const;
export type CommentContentType = (typeof CommentContentType)[keyof typeof CommentContentType];

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 3600;

export const ATTACHMENT_EXTENSIONS = {
	txt: 'text/plain',
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

export function assetContentDisposition(contentType: string): 'inline' | 'attachment' {
	return ASSET_INLINE_UNSAFE_MIME.has(contentType) ? 'attachment' : 'inline';
}

// Content types that may carry active script yet are meant to render inline (an
// interactive HTML mockup a human opens in a new tab). Serving them on our own
// origin would let agent-authored script read the app's credentials, so they are
// pinned to an opaque origin via a `sandbox` Content-Security-Policy: scripts run,
// but they cannot reach same-origin cookies/storage.
const ASSET_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals';
const ASSET_SANDBOX_SERVE_MIME: ReadonlySet<string> = new Set(['text/html']);

export function assetServeCsp(contentType: string): string | null {
	return ASSET_SANDBOX_SERVE_MIME.has(contentType) ? ASSET_SANDBOX_CSP : null;
}

// File types an agent may author directly into the assets library (text-based,
// reviewable). Binary assets (images, PDF, media) stay human-uploaded.
export const AGENT_AUTHORABLE_ASSET_MIME: ReadonlySet<string> = new Set([
	'text/html',
	'image/svg+xml',
	'text/plain',
]);

export function isAgentAuthorableAssetMime(mime: string): boolean {
	return AGENT_AUTHORABLE_ASSET_MIME.has(mime);
}

// Normalize an uploaded filename into a link-safe identity. This is the name an
// asset is referenced by (`assets/<name>.<ext>`) so it must match the mention
// parser's asset rule: start with an alphanumeric, then `[A-Za-z0-9._-]`.
export function normalizeAssetFilename(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? name;
	const cleaned = base
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[._-]+/, '')
		.replace(/-(\.[^.]*)$/, '$1');
	return cleaned.length > 0 ? cleaned : 'file';
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
	original_filename: string;
	created_at: string;
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

export const CredentialInputType = {
	Text: 'text',
	Textarea: 'textarea',
	File: 'file',
} as const;
export type CredentialInputType = (typeof CredentialInputType)[keyof typeof CredentialInputType];

export const ActionCommentKind = {
	SetupRepo: 'setup_repo',
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

export const GrantScope = { Single: 'single', Project: 'project', Team: 'team' } as const;
export type GrantScope = (typeof GrantScope)[keyof typeof GrantScope];

export const ApprovalType = {
	SecretAccess: 'secret_access',
	Hire: 'hire',
	TeamTemplate: 'team_template',
	ProjectCreation: 'project_creation',
	Strategy: 'strategy',
	PlanReview: 'plan_review',
	DeployProduction: 'deploy_production',
	DesignatedRepoRequest: 'designated_repo_request',
	SkillProposal: 'skill_proposal',
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
	comment_id: string;
	snippet: string;
	author_member_id: string | null;
	author_display_name: string;
	author_slug: string | null;
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
	OptionChosen: 'option_chosen',
	CredentialProvided: 'credential_provided',
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
} as const;
export type WakeupSkipReason = (typeof WakeupSkipReason)[keyof typeof WakeupSkipReason];

export const HeartbeatRunStatus = {
	Queued: 'queued',
	Running: 'running',
	Succeeded: 'succeeded',
	Failed: 'failed',
	Cancelled: 'cancelled',
	TimedOut: 'timed_out',
} as const;
export type HeartbeatRunStatus = (typeof HeartbeatRunStatus)[keyof typeof HeartbeatRunStatus];

export const OnboardingStageKey = {
	Intake: 'intake',
	Done: 'done',
} as const;
export type OnboardingStageKey = (typeof OnboardingStageKey)[keyof typeof OnboardingStageKey];

export const OnboardingStageStatus = {
	Complete: 'complete',
	Current: 'current',
	Pending: 'pending',
} as const;
export type OnboardingStageStatus =
	(typeof OnboardingStageStatus)[keyof typeof OnboardingStageStatus];

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
	McpSkill: 'mcp_skill',
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

export const AuditActorType = { Admin: 'admin', Agent: 'agent', System: 'system' } as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

export const RepoHostType = { GitHub: 'github' } as const;
export type RepoHostType = (typeof RepoHostType)[keyof typeof RepoHostType];

export const AuthType = { Admin: 'admin', ApiKey: 'api_key', Agent: 'agent' } as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

export const AuditEntityType = {
	Task: 'task',
	Project: 'project',
	Agent: 'agent',
	Team: 'team',
	Secret: 'secret',
	Document: 'document',
	EgressRequest: 'egress_request',
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];

export const McpConnectionKind = { Saas: 'saas', Local: 'local' } as const;
export type McpConnectionKind = (typeof McpConnectionKind)[keyof typeof McpConnectionKind];

export const McpInstallStatus = {
	Pending: 'pending',
	Installed: 'installed',
	Failed: 'failed',
} as const;
export type McpInstallStatus = (typeof McpInstallStatus)[keyof typeof McpInstallStatus];

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
	team_id: string;
	name: string;
	slug: string;
	description: string;
	content: string;
	source_url: string | null;
	content_hash: string;
	created_by_member_id: string | null;
	tags: string[];
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export const AuditAction = {
	Created: 'created',
	Updated: 'updated',
	Deleted: 'deleted',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const TERMINAL_TASK_STATUSES = [
	TaskStatus.Done,
	TaskStatus.Closed,
	TaskStatus.Cancelled,
] as const;

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
} as const;
export type AiProvider = (typeof AiProvider)[keyof typeof AiProvider];

export const AiAuthMethod = {
	ApiKey: 'api_key',
	Subscription: 'subscription',
} as const;
export type AiAuthMethod = (typeof AiAuthMethod)[keyof typeof AiAuthMethod];

export const AiProviderStatus = {
	Active: 'active',
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
 */
export const CLAUDE_CODE_QUIET_ENV = {
	DISABLE_TELEMETRY: '1',
	DISABLE_ERROR_REPORTING: '1',
	DISABLE_AUTOUPDATER: '1',
	DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
	DISABLE_BUG_COMMAND: '1',
} as const;

export const PROVIDER_RUNTIME_ADAPTERS: Record<AiProvider, ProviderRuntimeAdapter> = {
	[AiProvider.Anthropic]: {
		runtime: AgentRuntime.ClaudeCode,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'ANTHROPIC_API_KEY' },
	},
	[AiProvider.OpenAI]: {
		runtime: AgentRuntime.Codex,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'OPENAI_API_KEY' },
	},
	[AiProvider.Google]: {
		runtime: AgentRuntime.Gemini,
		credentialEnvByAuthMethod: { [AiAuthMethod.ApiKey]: 'GOOGLE_API_KEY' },
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
};

/** Default upstream API hostnames per provider (for egress NO_PROXY). */
const PROVIDER_UPSTREAM_HOSTS: Record<AiProvider, readonly string[]> = {
	[AiProvider.Anthropic]: ['api.anthropic.com'],
	[AiProvider.OpenAI]: ['api.openai.com'],
	[AiProvider.Google]: ['generativelanguage.googleapis.com'],
	[AiProvider.DeepSeek]: ['api.deepseek.com'],
	[AiProvider.ZAi]: ['api.z.ai'],
};

/**
 * Hostnames that should bypass the egress MITM proxy for a given provider.
 * LLM credentials are injected via container env (not `__HEZO_SECRET_*`
 * placeholders); MITM breaks some Anthropic-compatible APIs, so provider
 * traffic goes direct while git/MCP placeholders still use the proxy.
 */
export function providerDirectUpstreamHosts(provider: AiProvider): readonly string[] {
	const baseUrl = PROVIDER_RUNTIME_ADAPTERS[provider].staticEnv?.ANTHROPIC_BASE_URL;
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
	[AgentRuntime.ClaudeCode]: ['--disallowedTools', 'WebFetch'],
	[AgentRuntime.Codex]: [],
	[AgentRuntime.Gemini]: [],
};

/**
 * Flags that make each CLI emit structured per-turn events to stdout while
 * the run is in flight, so the run log shows tool calls, thinking, and
 * partial assistant text live instead of silence until the final result.
 * Runtimes without a documented stream mode default to [] and stream their
 * native text output.
 */
export const RUNTIME_STREAM_ARGS: Record<AgentRuntime, readonly string[]> = {
	[AgentRuntime.ClaudeCode]: ['--output-format', 'stream-json', '--verbose'],
	[AgentRuntime.Codex]: [],
	[AgentRuntime.Gemini]: [],
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
};

export interface AiProviderVerifyEndpoint {
	url: string | ((apiKey: string) => string);
	headers: Record<string, string> | ((apiKey: string) => Record<string, string>);
}

export interface AiProviderInfo {
	name: string;
	runtimeLabel: string;
	supportsSubscription?: boolean;
	keyPrefix?: string;
	keyPlaceholder: string;
	verifyEndpoint: AiProviderVerifyEndpoint;
}

export const AI_PROVIDER_INFO: Record<AiProvider, AiProviderInfo> = {
	[AiProvider.Anthropic]: {
		name: 'Anthropic',
		runtimeLabel: 'Claude Code',
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
			const displayName = typeof m.display_name === 'string' ? m.display_name : '';
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
