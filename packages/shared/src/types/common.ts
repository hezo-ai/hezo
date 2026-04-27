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

export const IssueStatus = {
	Backlog: 'backlog',
	InProgress: 'in_progress',
	Review: 'review',
	Approved: 'approved',
	Blocked: 'blocked',
	Done: 'done',
	Closed: 'closed',
	Cancelled: 'cancelled',
} as const;
export type IssueStatus = (typeof IssueStatus)[keyof typeof IssueStatus];

export const IssuePriority = {
	Urgent: 'urgent',
	High: 'high',
	Medium: 'medium',
	Low: 'low',
} as const;
export type IssuePriority = (typeof IssuePriority)[keyof typeof IssuePriority];

export const CommentContentType = {
	Text: 'text',
	Options: 'options',
	Preview: 'preview',
	Trace: 'trace',
	System: 'system',
	Run: 'run',
	Action: 'action',
} as const;
export type CommentContentType = (typeof CommentContentType)[keyof typeof CommentContentType];

export const ActionCommentKind = {
	SetupRepo: 'setup_repo',
} as const;
export type ActionCommentKind = (typeof ActionCommentKind)[keyof typeof ActionCommentKind];

export const OAuthRequestReason = {
	DesignatedRepo: 'designated_repo',
	RepoAdd: 'repo_add',
} as const;
export type OAuthRequestReason = (typeof OAuthRequestReason)[keyof typeof OAuthRequestReason];

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

export const GrantScope = { Single: 'single', Project: 'project', Company: 'company' } as const;
export type GrantScope = (typeof GrantScope)[keyof typeof GrantScope];

export const ApprovalType = {
	SecretAccess: 'secret_access',
	Hire: 'hire',
	Strategy: 'strategy',
	KbUpdate: 'kb_update',
	PlanReview: 'plan_review',
	DeployProduction: 'deploy_production',
	OauthRequest: 'oauth_request',
	SkillProposal: 'skill_proposal',
} as const;
export type ApprovalType = (typeof ApprovalType)[keyof typeof ApprovalType];

export const ApprovalStatus = {
	Pending: 'pending',
	Approved: 'approved',
	Denied: 'denied',
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const MembershipRole = { Board: 'board', Member: 'member' } as const;
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
	Comment: 'comment',
	Reply: 'reply',
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

export const HeartbeatRunStatus = {
	Queued: 'queued',
	Running: 'running',
	Succeeded: 'succeeded',
	Failed: 'failed',
	Cancelled: 'cancelled',
	TimedOut: 'timed_out',
} as const;
export type HeartbeatRunStatus = (typeof HeartbeatRunStatus)[keyof typeof HeartbeatRunStatus];

export const PluginStatus = {
	Installed: 'installed',
	Enabled: 'enabled',
	Disabled: 'disabled',
	Error: 'error',
} as const;
export type PluginStatus = (typeof PluginStatus)[keyof typeof PluginStatus];

export const DocumentType = {
	ProjectDoc: 'project_doc',
	KbDoc: 'kb_doc',
	CompanyPreferences: 'company_preferences',
	AgentSystemPrompt: 'agent_system_prompt',
} as const;
export type DocumentType = (typeof DocumentType)[keyof typeof DocumentType];

export const AuditActorType = { Board: 'board', Agent: 'agent', System: 'system' } as const;
export type AuditActorType = (typeof AuditActorType)[keyof typeof AuditActorType];

export const RepoHostType = { GitHub: 'github' } as const;
export type RepoHostType = (typeof RepoHostType)[keyof typeof RepoHostType];

export const AuthType = { Board: 'board', ApiKey: 'api_key', Agent: 'agent' } as const;
export type AuthType = (typeof AuthType)[keyof typeof AuthType];

export const AuditEntityType = {
	Issue: 'issue',
	Project: 'project',
	Agent: 'agent',
	Company: 'company',
	Secret: 'secret',
	Document: 'document',
} as const;
export type AuditEntityType = (typeof AuditEntityType)[keyof typeof AuditEntityType];

export const AgentTypeSource = {
	Builtin: 'builtin',
	Custom: 'custom',
	Remote: 'remote',
} as const;
export type AgentTypeSource = (typeof AgentTypeSource)[keyof typeof AgentTypeSource];

export const CompanyTypeSource = {
	Builtin: 'builtin',
	Custom: 'custom',
	Marketplace: 'marketplace',
} as const;
export type CompanyTypeSource = (typeof CompanyTypeSource)[keyof typeof CompanyTypeSource];

export const GoalStatus = {
	Active: 'active',
	Achieved: 'achieved',
	Archived: 'archived',
} as const;
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const TERMINAL_GOAL_STATUSES = [GoalStatus.Achieved, GoalStatus.Archived] as const;

export interface Goal {
	id: string;
	company_id: string;
	project_id: string | null;
	title: string;
	description: string;
	status: GoalStatus;
	created_by_member_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface GoalWithProject extends Goal {
	project_name: string | null;
	project_slug: string | null;
}

export interface SkillTemplateConfig {
	name: string;
	source_url: string;
	description?: string;
}

export interface SkillRecord {
	id: string;
	company_id: string;
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

export const TERMINAL_ISSUE_STATUSES = [
	IssueStatus.Done,
	IssueStatus.Closed,
	IssueStatus.Cancelled,
] as const;

export const PRIORITY_ORDER: Record<IssuePriority, number> = {
	[IssuePriority.Urgent]: 0,
	[IssuePriority.High]: 1,
	[IssuePriority.Medium]: 2,
	[IssuePriority.Low]: 3,
};

// --- AI Provider Configuration ---

export const AiProvider = {
	Anthropic: 'anthropic',
	OpenAI: 'openai',
	Google: 'google',
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

export const RUNTIME_TO_PROVIDER: Record<AgentRuntime, AiProvider> = {
	[AgentRuntime.ClaudeCode]: AiProvider.Anthropic,
	[AgentRuntime.Codex]: AiProvider.OpenAI,
	[AgentRuntime.Gemini]: AiProvider.Google,
};

export const PROVIDER_TO_RUNTIME: Record<AiProvider, AgentRuntime> = {
	[AiProvider.Anthropic]: AgentRuntime.ClaudeCode,
	[AiProvider.OpenAI]: AgentRuntime.Codex,
	[AiProvider.Google]: AgentRuntime.Gemini,
};

export const PROVIDER_TO_ENV_VAR: Record<AiProvider, Record<string, string>> = {
	[AiProvider.Anthropic]: {
		[AiAuthMethod.ApiKey]: 'ANTHROPIC_API_KEY',
	},
	[AiProvider.OpenAI]: {
		[AiAuthMethod.ApiKey]: 'OPENAI_API_KEY',
	},
	[AiProvider.Google]: {
		[AiAuthMethod.ApiKey]: 'GOOGLE_API_KEY',
	},
};

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
