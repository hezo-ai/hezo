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
	/** Human users (today just the admin) for the global Settings → Users page. */
	users: () => ['users'],
	status: () => ['status'],
	updateCheck: () => ['update-check'],
	updateStatus: () => ['update-status'],
	teamTemplates: () => ['team-templates'],
	marketplaceTeams: () => ['marketplace', 'teams'],
	marketplaceTeam: (slug: string) => ['marketplace', 'teams', slug],
	aiProviderModels: (configId: string) => ['ai-providers', configId, 'models'],
	instanceAuditLog: (filters: KeyParam) => ['instance', 'audit-log', filters],
	instanceSettings: () => ['instance', 'settings'],
	/** Storage backend metadata (server-side redacted) for the General settings page. */
	databaseInfo: () => ['instance', 'database'],
	/**
	 * On-disk size of the embedded DB's pre-migration snapshots
	 * (`pgdata.superseded.*`). Under the `databaseInfo` prefix so its invalidation
	 * cascades here too.
	 */
	supersededData: () => ['instance', 'database', 'superseded'],
	/**
	 * Live DB-usage figures + run-log compaction status for the chosen retention
	 * window. Under the `databaseInfo` prefix so invalidating it cascades here.
	 */
	runLogUsage: (olderThanDays: number) => ['instance', 'database', 'run-log-usage', olderThanDays],
	/** Asset storage backend metadata (server-side redacted) for the General settings page. */
	assetStorageInfo: () => ['instance', 'asset-storage'],
	/** Sandbox backend metadata (server-side redacted) for the Storage settings page. */
	sandboxBackendInfo: () => ['instance', 'sandbox-backend'],
	/**
	 * Every container the instance is running, and one of them.
	 *
	 * Instance-scoped rather than under a project: a container belongs to a
	 * project but the list crosses all of them, and keying it per project is what
	 * made the old UI able to describe only one container at a time.
	 */
	containers: () => ['instance', 'containers'],
	container: (containerId: string) => ['instance', 'containers', containerId],
	/** Instance-wide mention resolution (global CEO chat), keyed by sorted candidates. */
	instanceMentionsResolve: (key: KeyParam) => ['instance', 'mentions', 'resolve', key],
	/**
	 * A CEO chat conversation thread (history + streamed messages), keyed by
	 * conversation id. `'default'` is the default web thread (server-resolved).
	 */
	chatConversation: (conversationId: string = 'default') => [
		'chat',
		'conversation',
		conversationId,
	],
	/** The list of CEO chat conversation threads (the switcher). */
	chatConversations: () => ['chat', 'conversations'],
	/** Global full-text search (Cmd/Ctrl+K palette), keyed by query + scope. */
	search: (q: string, scope: string) => ['search', q, scope],
	/** Bundled OAuth-provider descriptors for the generic OAuth-broker form. */
	oauthProviders: () => ['connectors', 'oauth-providers'],
	/** Method catalog + allowlist read through the admin (global) connectors
	 * surface, which is unscoped — distinct from the per-project key. */
	adminConnectorMethods: (connectorId: string | null) => ['connectors', 'methods', connectorId],

	teams: {
		connectors: (teamId: string) => ['teams', teamId, 'connectors'],
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
		// Archived-projects list (global settings). Length-3 key never collides
		// with a detail (`['projects', slug]`) or tasks key, and stays under the
		// `['projects']` prefix so `all()` invalidation refetches it too.
		archived: () => ['projects', 'archived', 'list'],

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
		tasksResolve: (slug: string, key: string[]) => ['projects', slug, 'tasks', 'resolve', key],
		task: (slug: string, taskId: string) => ['projects', slug, 'tasks', taskId],
		taskComments: (slug: string, taskId: string) => ['projects', slug, 'tasks', taskId, 'comments'],
		// Lazy comments feed: the skeleton list (metadata + reactions, no heavy
		// bodies) and the per-comment body loaded on scroll-dwell. Both sit under
		// the `taskComments` prefix so the existing WS invalidation (which targets
		// the `tasks(slug)` prefix) still cascades to them.
		taskCommentSkeletons: (slug: string, taskId: string) => [
			'projects',
			slug,
			'tasks',
			taskId,
			'comments',
			'skeleton',
		],
		commentBody: (slug: string, taskId: string, commentId: string) => [
			'projects',
			slug,
			'tasks',
			taskId,
			'comments',
			commentId,
			'body',
		],
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
		goalSuggestions: (slug: string) => ['projects', slug, 'goals', 'suggestions'],
		// Infinite-scroll variants of the runs feeds, under their base prefixes so
		// existing invalidations still cascade.
		goalRunsInfinite: (slug: string, filters: KeyParam) => [
			'projects',
			slug,
			'goals',
			'runs',
			'infinite',
			filters,
		],
		goalQueuedRun: (slug: string) => ['projects', slug, 'goals', 'queued-run'],
		goalRunsForGoal: (slug: string, goalId: string) => ['projects', slug, 'goals', goalId, 'runs'],
		goalRunsForGoalInfinite: (slug: string, goalId: string, filters: KeyParam) => [
			'projects',
			slug,
			'goals',
			goalId,
			'runs',
			'infinite',
			filters,
		],
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
		agentHeartbeatRunsInfinite: (slug: string, agentId: string, filters: KeyParam) => [
			'projects',
			slug,
			'agents',
			agentId,
			'heartbeat-runs',
			'infinite',
			filters,
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
		needsYou: (slug: string) => ['projects', slug, 'needs-you'],
		inboxMentions: (slug: string) => ['projects', slug, 'inbox-mentions'],

		// docs / custom prompt / skills
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
		customPrompt: (slug: string) => ['projects', slug, 'custom-prompt'],
		customPromptRevisions: (slug: string) => ['projects', slug, 'custom-prompt', 'revisions'],
		skills: (slug: string) => ['projects', slug, 'skills'],
		// Infinite-scroll variant. Sits under the `skills` prefix so mutation/WS
		// invalidation of `skills(slug)` still refetches it (mirrors tasksInfinite).
		skillsInfinite: (slug: string, filters: KeyParam) => [
			'projects',
			slug,
			'skills',
			'infinite',
			filters,
		],
		skill: (slug: string, skillSlug: string | null) => ['projects', slug, 'skills', skillSlug],

		// connections / credentials / repos
		secrets: (slug: string) => ['projects', slug, 'secrets'],
		credentials: (slug: string) => ['projects', slug, 'credentials'],
		repos: (slug: string) => ['projects', slug, 'repos'],
		gitState: (slug: string, repoId: string) => ['projects', slug, 'repos', repoId, 'git-state'],
		connectors: (slug: string) => ['projects', slug, 'connectors'],
		connectorsFiltered: (slug: string, filterProjectId: string | null) => [
			'projects',
			slug,
			'connectors',
			filterProjectId,
		],
		connectorsInfinite: (slug: string, filters: KeyParam) => [
			'projects',
			slug,
			'connectors',
			'infinite',
			filters,
		],
		connectorDetail: (slug: string, connectorId: string | null) => [
			'projects',
			slug,
			'connectors',
			'detail',
			connectorId,
		],
		// Nested under the project's `connectors` key so any connector mutation's
		// invalidation (revoke, reconnect, api-key) refreshes the health banner too.
		connectorHealth: (slug: string) => ['projects', slug, 'connectors', 'health'],
		connectorMethods: (slug: string, connectorId: string | null) => [
			'projects',
			slug,
			'connectors',
			'methods',
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
		// Keyed by the asset's file path (the `?file` route value), not its UUID —
		// `assets(slug)` is the prefix, so assets-family WS invalidations reach it.
		assetReviewComments: (slug: string, file: string | null) => [
			'projects',
			slug,
			'assets',
			file,
			'review-comments',
		],
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
