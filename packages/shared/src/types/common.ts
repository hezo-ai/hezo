export const MemberType = { Agent: 'agent', User: 'user' } as const;
export type MemberType = (typeof MemberType)[keyof typeof MemberType];

export const AgentRuntime = {
	ClaudeCode: 'claude_code',
	Codex: 'codex',
	Gemini: 'gemini',
} as const;
export type AgentRuntime = (typeof AgentRuntime)[keyof typeof AgentRuntime];

export const AgentStatus = {
	Active: 'active',
	Idle: 'idle',
	Paused: 'paused',
	Terminated: 'terminated',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const ContainerStatus = {
	Creating: 'creating',
	Running: 'running',
	Stopped: 'stopped',
	Error: 'error',
} as const;
export type ContainerStatus = (typeof ContainerStatus)[keyof typeof ContainerStatus];

export const IssueStatus = {
	Backlog: 'backlog',
	Open: 'open',
	InProgress: 'in_progress',
	Review: 'review',
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
