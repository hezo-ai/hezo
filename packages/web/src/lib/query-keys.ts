/**
 * Single source of truth for TanStack Query keys.
 *
 * Every hook and the realtime invalidation map (`use-websocket`'s
 * `TABLE_TO_QUERY_KEY`) build their keys here, so the two can no longer drift.
 * Project-scoped keys are keyed by the **route-param project slug** (never a
 * resolved UUID) — see the "Slugs vs UUIDs" rule in CLAUDE.md — which is what
 * makes WebSocket-driven `invalidateQueries` match the queries the hooks read.
 *
 * Builders mirror the array shapes exactly; changing a key here changes it
 * everywhere. Prefix relationships matter: invalidating `projects.tasks(slug)`
 * (`['projects', slug, 'tasks']`) also invalidates every `task(...)` /
 * `taskComments(...)` key beneath it, by design.
 */

/** Opaque filter/param object embedded in a key (tasks filters, cost params, …). */
type KeyParam = unknown;

export const queryKeys = {
	// ---- instance / global ----
	me: () => ['me'],
	status: () => ['status'],
	updateCheck: () => ['update-check'],
	updateStatus: () => ['update-status'],
	teamTemplates: () => ['team-templates'],
	aiProviderModels: (configId: string) => ['ai-providers', configId, 'models'],
	instanceAuditLog: (filters: KeyParam) => ['instance', 'audit-log', filters],
	instanceSettings: () => ['instance', 'settings'],
	/** Instance-wide mention resolution (global CEO chat), keyed by sorted candidates. */
	instanceMentionsResolve: (key: KeyParam) => ['instance', 'mentions', 'resolve', key],
	/** The single global CEO chat conversation (history + streamed messages). */
	ceoConversation: () => ['ceo', 'conversation'],
	/** Global full-text search (Cmd/Ctrl+K palette), keyed by query + scope. */
	search: (q: string, scope: string) => ['search', q, scope],

	teams: {
		mcpConnections: (teamId: string) => ['teams', teamId, 'mcp-connections'],
		oauthConnections: (teamId: string) => ['teams', teamId, 'oauth-connections'],
	},

	projectIntakes: () => ['project-intakes'],

	approvals: {
		root: () => ['approvals'],
		all: (projectKey: string, opts: KeyParam) => ['approvals', 'all', projectKey, opts],
	},

	inboxMentions: {
		root: () => ['inbox-mentions'],
		all: (projectKey: string, opts: KeyParam) => ['inbox-mentions', projectKey, opts],
	},

	// ---- project-scoped (keyed by project slug) ----
	projects: {
		all: () => ['projects'],
		detail: (slug: string) => ['projects', slug],

		// tasks
		tasks: (slug: string) => ['projects', slug, 'tasks'],
		tasksFiltered: (slug: string, filters: KeyParam) => ['projects', slug, 'tasks', filters],
		tasksInfinite: (slug: string, filters: KeyParam) => [
			'projects',
			slug,
			'tasks',
			'infinite',
			filters,
		],
		tasksProgressSummary: (slug: string) => ['projects', slug, 'tasks', 'progress-summary'],
		tasksResolve: (slug: string, key: string[]) => ['projects', slug, 'tasks', 'resolve', key],
		task: (slug: string, taskId: string) => ['projects', slug, 'tasks', taskId],
		taskComments: (slug: string, taskId: string) => ['projects', slug, 'tasks', taskId, 'comments'],
		taskAncestors: (slug: string, taskId: string | undefined) => [
			'projects',
			slug,
			'tasks',
			taskId,
			'ancestors',
		],
		taskDependencies: (slug: string, taskId: string) => [
			'projects',
			slug,
			'tasks',
			taskId,
			'dependencies',
		],
		taskLock: (slug: string, taskId: string) => ['projects', slug, 'tasks', taskId, 'lock'],
		taskQueuedWakeups: (slug: string, taskId: string) => [
			'projects',
			slug,
			'tasks',
			taskId,
			'queued-wakeups',
		],

		// goals
		goals: (slug: string) => ['projects', slug, 'goals'],
		goalsFiltered: (slug: string, filters: KeyParam) => ['projects', slug, 'goals', filters],
		goal: (slug: string, goalId: string) => ['projects', slug, 'goals', goalId],
		goalHistory: (slug: string, goalId: string) => ['projects', slug, 'goals', goalId, 'history'],
		goalRuns: (slug: string) => ['projects', slug, 'goals', 'runs'],
		goalQueuedRun: (slug: string) => ['projects', slug, 'goals', 'queued-run'],
		goalRunsForGoal: (slug: string, goalId: string) => ['projects', slug, 'goals', goalId, 'runs'],
		progress: (slug: string) => ['projects', slug, 'progress'],

		// agents
		agents: (slug: string) => ['projects', slug, 'agents'],
		agentsFiltered: (slug: string, filters: KeyParam) => ['projects', slug, 'agents', filters],
		agent: (slug: string, agentId: string) => ['projects', slug, 'agents', agentId],
		agentHeartbeatRuns: (slug: string, agentId: string) => [
			'projects',
			slug,
			'agents',
			agentId,
			'heartbeat-runs',
		],
		agentHeartbeatRun: (slug: string, agentId: string, runId: string) => [
			'projects',
			slug,
			'agents',
			agentId,
			'heartbeat-runs',
			runId,
		],
		agentSystemPrompt: (slug: string, agentId: string) => [
			'projects',
			slug,
			'agents',
			agentId,
			'system-prompt',
		],
		agentSystemPromptPreview: (slug: string, agentId: string) => [
			'projects',
			slug,
			'agents',
			agentId,
			'system-prompt',
			'preview',
		],
		agentSystemPromptRevisions: (slug: string, agentId: string) => [
			'projects',
			slug,
			'agents',
			agentId,
			'system-prompt',
			'revisions',
		],
		agentChatMemory: (slug: string, agentId: string) => [
			'projects',
			slug,
			'agents',
			agentId,
			'chat-memory',
		],
		agentsMd: (slug: string) => ['projects', slug, 'agents-md'],
		orgChart: (slug: string) => ['projects', slug, 'org-chart'],

		// approvals
		approvals: (slug: string) => ['projects', slug, 'approvals'],
		approvalsFiltered: (slug: string, opts: KeyParam) => ['projects', slug, 'approvals', opts],
		approvalBlockedTickets: (
			slug: string | null | undefined,
			approvalId: string | null | undefined,
		) => ['projects', slug, 'approvals', approvalId, 'blocked-tickets'],

		// inbox
		inboxCount: (slug: string) => ['projects', slug, 'inbox-count'],
		inboxMentions: (slug: string) => ['projects', slug, 'inbox-mentions'],

		// docs / preferences / skills
		docs: (slug: string) => ['projects', slug, 'docs'],
		doc: (slug: string, filename: string | null) => ['projects', slug, 'docs', filename],
		docRevisions: (slug: string, filename: string | null) => [
			'projects',
			slug,
			'docs',
			filename,
			'revisions',
		],
		docReviewComments: (slug: string, filename: string | null) => [
			'projects',
			slug,
			'docs',
			filename,
			'review-comments',
		],
		docsResolve: (slug: string, key: KeyParam) => ['projects', slug, 'docs', 'resolve', key],
		preferences: (slug: string) => ['projects', slug, 'preferences'],
		preferencesRevisions: (slug: string) => ['projects', slug, 'preferences', 'revisions'],
		skills: (slug: string) => ['projects', slug, 'skills'],
		skill: (slug: string, skillSlug: string | null) => ['projects', slug, 'skills', skillSlug],

		// connections / credentials / repos
		secrets: (slug: string) => ['projects', slug, 'secrets'],
		credentials: (slug: string) => ['projects', slug, 'credentials'],
		repos: (slug: string) => ['projects', slug, 'repos'],
		mcpConnections: (slug: string) => ['projects', slug, 'mcp-connections'],
		mcpConnectionsFiltered: (slug: string, filterProjectId: string | null) => [
			'projects',
			slug,
			'mcp-connections',
			filterProjectId,
		],
		mcpConnectionDetail: (slug: string, connectorId: string | null) => [
			'projects',
			slug,
			'mcp-connections',
			'detail',
			connectorId,
		],
		oauthConnections: (slug: string) => ['projects', slug, 'oauth-connections'],
		oauthConnectionOrgs: (slug: string, oauthConnectionId: string | null | undefined) => [
			'projects',
			slug,
			'oauth-connections',
			oauthConnectionId,
			'orgs',
		],
		oauthConnectionScopeStatus: (slug: string, connectionId: string | null | undefined) => [
			'projects',
			slug,
			'oauth-connections',
			connectionId,
			'scope-status',
		],

		// team / misc
		team: (slug: string) => ['projects', slug, 'team'],
		assets: (slug: string) => ['projects', slug, 'assets'],
		costs: (slug: string, params: KeyParam) => ['projects', slug, 'costs', params],
		budgetStatus: (slug: string) => ['projects', slug, 'budget-status'],
		auditLog: (slug: string, filters: KeyParam) => ['projects', slug, 'audit-log', filters],
		githubOrgs: (slug: string) => ['projects', slug, 'github', 'orgs'],
		githubRepos: (slug: string, owner: string | null, query: string) => [
			'projects',
			slug,
			'github',
			'repos',
			owner,
			query,
		],
		mentionsSearch: (slug: string, q: string, projectSlug: string | null) => [
			'projects',
			slug,
			'mentions',
			'search',
			q,
			projectSlug,
		],
	},
} as const;
