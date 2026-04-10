export const MemberType = { Agent: 'agent', User: 'user' } as const;
export type MemberType = (typeof MemberType)[keyof typeof MemberType];

export const AgentRuntime = {
	ClaudeCode: 'claude_code',
	Codex: 'codex',
	Gemini: 'gemini',
	Kimi: 'kimi',
} as const;
export type AgentRuntime = (typeof AgentRuntime)[keyof typeof AgentRuntime];

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
	Open: 'open',
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
	Execution: 'execution',
} as const;
export type CommentContentType = (typeof CommentContentType)[keyof typeof CommentContentType];

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
	SystemPromptUpdate: 'system_prompt_update',
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
	ChatMessage: 'chat_message',
	Comment: 'comment',
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

export const ProjectDocType = {
	TechSpec: 'tech_spec',
	ImplementationPlan: 'implementation_plan',
	Research: 'research',
	UiDesignDecisions: 'ui_design_decisions',
	MarketingPlan: 'marketing_plan',
	Other: 'other',
} as const;
export type ProjectDocType = (typeof ProjectDocType)[keyof typeof ProjectDocType];

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
	KbDoc: 'kb_doc',
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

export const ExecutionLockType = {
	Read: 'read',
	Write: 'write',
} as const;
export type ExecutionLockType = (typeof ExecutionLockType)[keyof typeof ExecutionLockType];

export const READER_AGENT_SLUGS: ReadonlySet<string> = new Set([
	'coach',
	'qa-engineer',
	'security-engineer',
]);

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
	Moonshot: 'moonshot',
} as const;
export type AiProvider = (typeof AiProvider)[keyof typeof AiProvider];

export const AiAuthMethod = {
	ApiKey: 'api_key',
	OAuthToken: 'oauth_token',
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
	[AgentRuntime.Kimi]: AiProvider.Moonshot,
};

export const PROVIDER_TO_ENV_VAR: Record<AiProvider, Record<string, string>> = {
	[AiProvider.Anthropic]: {
		[AiAuthMethod.ApiKey]: 'ANTHROPIC_API_KEY',
		[AiAuthMethod.OAuthToken]: 'CLAUDE_CODE_OAUTH_TOKEN',
	},
	[AiProvider.OpenAI]: {
		[AiAuthMethod.ApiKey]: 'OPENAI_API_KEY',
		[AiAuthMethod.OAuthToken]: 'CODEX_OAUTH_TOKEN',
	},
	[AiProvider.Google]: {
		[AiAuthMethod.ApiKey]: 'GOOGLE_API_KEY',
		[AiAuthMethod.OAuthToken]: 'GEMINI_OAUTH_TOKEN',
	},
	[AiProvider.Moonshot]: {
		[AiAuthMethod.ApiKey]: 'MOONSHOT_API_KEY',
	},
};

export const RUNTIME_COMMANDS: Record<AgentRuntime, string> = {
	[AgentRuntime.ClaudeCode]: 'claude',
	[AgentRuntime.Codex]: 'codex',
	[AgentRuntime.Gemini]: 'gemini',
	[AgentRuntime.Kimi]: 'kimi',
};

export const AI_PROVIDER_INFO: Record<
	AiProvider,
	{
		name: string;
		runtimeLabel: string;
		supportsOAuth: boolean;
		keyPrefix?: string;
		keyPlaceholder: string;
	}
> = {
	[AiProvider.Anthropic]: {
		name: 'Anthropic',
		runtimeLabel: 'Claude Code',
		supportsOAuth: true,
		keyPrefix: 'sk-ant-',
		keyPlaceholder: 'sk-ant-...',
	},
	[AiProvider.OpenAI]: {
		name: 'OpenAI',
		runtimeLabel: 'Codex',
		supportsOAuth: true,
		keyPrefix: 'sk-',
		keyPlaceholder: 'sk-...',
	},
	[AiProvider.Google]: {
		name: 'Google',
		runtimeLabel: 'Gemini',
		supportsOAuth: true,
		keyPlaceholder: 'AIza...',
	},
	[AiProvider.Moonshot]: {
		name: 'Moonshot',
		runtimeLabel: 'Kimi',
		supportsOAuth: false,
		keyPlaceholder: 'sk-...',
	},
};
