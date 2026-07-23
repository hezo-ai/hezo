export const DEFAULT_PORT = 3100;
export const DEFAULT_WEB_PORT = 5173;
export const DEFAULT_DATA_DIR = '~/.hezo';
export const CANARY_PLAINTEXT = 'CANARY';
export const CAPTAIN_AGENT_SLUG = 'captain';
/** Instance-level Coach role: one per Hezo instance, reviews completed work across every project. */
export const COACH_AGENT_SLUG = 'coach';
/** Instance-level CEO role: one per Hezo instance, sits above every team Captain. */
export const CEO_AGENT_SLUG = 'ceo';
/** Roles seeded into every project-team. Coach and CEO are instance-level, not per-team. */
export const BUILTIN_AGENT_SLUGS = [CAPTAIN_AGENT_SLUG] as const;
/** Instance-level singletons living in the HQ team, never duplicated per project-team. */
export const INSTANCE_AGENT_SLUGS = [CEO_AGENT_SLUG, COACH_AGENT_SLUG] as const;

export const ADMIN_MENTION_SLUG = 'admin';
export const RESERVED_AGENT_SLUGS = [ADMIN_MENTION_SLUG] as const;
export function isReservedAgentSlug(slug: string): boolean {
	return (RESERVED_AGENT_SLUGS as readonly string[]).includes(slug);
}

/**
 * Roles whose reporting line is structurally fixed and must never be user-editable:
 * the Captain always reports to the CEO; the CEO and Coach report to the admin (no
 * agent). Enforced across every write path (REST PATCH, MCP `set_agent_reports_to`)
 * and disabled in the settings UI.
 */
export const FIXED_REPORTS_TO_SLUGS = [
	CAPTAIN_AGENT_SLUG,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
] as const;
export function hasFixedReportsTo(slug: string): boolean {
	return (FIXED_REPORTS_TO_SLUGS as readonly string[]).includes(slug);
}
/**
 * The single instance-level coordination project, living in the HQ (default)
 * team. There is exactly one across the instance — it hosts the CEO + Coach and
 * the pre-creation project-intake conversations. Normal project-teams have no
 * internal project of their own.
 */
export const HQ_PROJECT_SLUG = 'hq';
export const HQ_PROJECT_NAME = 'HQ';
export const HQ_PROJECT_TASK_PREFIX = 'HQ';

export const DEFAULT_TEAM_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_TEAM_SLUG = 'default';
export const DEFAULT_TEAM_NAME = 'Team';
export const DEFAULT_TEAM_TEMPLATE_NAME = 'Blank';

/**
 * High-water mark, in bytes, for a chatbox's active (non-compacted) message
 * window. When the window's combined message content exceeds this, the chat
 * agent compacts the whole window into its long-term memory and all but the
 * latest few messages are evicted, resetting the window to a short tail.
 * Operator-adjustable in global settings; clamped to [MIN, MAX].
 */
export const DEFAULT_MAX_CHAT_HISTORY_SIZE = 40 * 1024;
export const MAX_CHAT_HISTORY_SIZE_MIN = 8 * 1024;
export const MAX_CHAT_HISTORY_SIZE_MAX = 256 * 1024;

/**
 * The "latest few" messages kept in the active window after a compaction flush.
 * Internal constant (not an operator setting): everything older than this tail
 * is summarized into long-term memory and dropped from the chatbox.
 */
export const CHAT_WINDOW_RETAIN_MESSAGES = 6;

/**
 * Agent run-log compaction. The retention window (in days): runs older than this
 * have their verbose `log_text` trimmed to the meaningful tail. Operator-chosen
 * per compaction pass from the DB panel; clamped to [MIN, MAX].
 */
export const DEFAULT_LOG_COMPACTION_RETENTION_DAYS = 30;
export const LOG_COMPACTION_RETENTION_MIN_DAYS = 1;
export const LOG_COMPACTION_RETENTION_MAX_DAYS = 365;

/**
 * Bytes of each old run's log kept when it is compacted — the trailing slice
 * that holds the agent's end-of-run summary and the `[done] … tokens=… cost=…`
 * line. Everything before it is discarded. Internal (not operator-tunable via
 * the UI); overridable at deploy time with `HEZO_LOG_COMPACTION_PRESERVED_BYTES`.
 */
export const LOG_COMPACTION_PRESERVED_TAIL_BYTES = 12 * 1024;

/**
 * Default heartbeat interval for newly created agents and agent types, in
 * minutes (12 hours). Idle agents wake on this cadence to look for work; the
 * value is editable per agent and overridable per team-template role. The DB
 * column default (`member_agents`/`agent_types.heartbeat_interval_min`) is a
 * non-load-bearing fallback — every insert path supplies this value
 * explicitly — so this constant is the single source of truth for the default.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MIN = 720;

export const PROJECT_INTAKE_LABEL = 'project-intake';

/**
 * Canonical public documentation site entry point. The agent-facing manifest
 * (`/SKILL.md`), `/llms.txt`, and the CEO prompt's docs pointer all reference
 * this live URL rather than embedding the docs. Matches the link in README.md.
 */
export const HEZO_DOCS_URL = 'https://hezo.ai/docs/introduction';

export const wsRoom = {
	team: (id: string) => `team:${id}`,
	agent: (id: string) => `agent:${id}`,
	/**
	 * Global CEO chat signal room. Every chat surface subscribes here for
	 * conversation-list level activity (a new thread, cross-thread badges).
	 */
	chat: () => 'chat:global',
	/**
	 * Per-conversation CEO chat room. Message start/delta/complete for a single
	 * thread stream here, so an open thread only receives its own deltas.
	 */
	chatConversation: (conversationId: string) => `chat:${conversationId}`,
	/**
	 * The single global base-image build room. Base images (e.g.
	 * `hezo/agent-base:latest`) are shared across all projects, so their build
	 * progress is broadcast here once and every project page filters by image.
	 */
	imageBuilds: () => 'image-builds',
	/**
	 * The single global project-index room. A project is created in a brand-new
	 * team whose `team:<id>` room no client has joined yet (and whose row isn't in
	 * the cached index to resolve a slug from), so a project-INSERT on the team
	 * room can't reach the rail live. The "the index changed" signal is broadcast
	 * here instead; every shell subscribes so the project rail stays current the
	 * moment any project is created — by the dialog, the CEO, or another session.
	 */
	projects: () => 'projects:global',
} as const;

/**
 * The repository's own name — the segment after the owner in an `owner/name`
 * identifier. Serves as the repo's display label and as its directory name
 * under the project workspace and per-task worktrees. Must match the SQL
 * expression `split_part(repo_identifier, '/', 2)` used by the per-project
 * uniqueness index on repos.
 */
export function repoNameFromIdentifier(repoIdentifier: string): string {
	const slash = repoIdentifier.indexOf('/');
	return slash === -1 ? repoIdentifier : repoIdentifier.slice(slash + 1);
}

/**
 * Conventional-commit type → changelog heading, in render order. Single source
 * of truth shared by the release script and its tests. Commit types not listed
 * here (and non-conventional commits) fall into the "Other" section.
 */
export const CHANGELOG_SECTIONS = [
	['feat', 'Features'],
	['fix', 'Bug Fixes'],
	['perf', 'Performance'],
	['refactor', 'Refactors'],
	['docs', 'Documentation'],
	['build', 'Build System'],
	['test', 'Tests'],
	['chore', 'Chores'],
] as const;

export const CHANGELOG_OTHER_HEADING = 'Other';
export const CHANGELOG_BREAKING_HEADING = 'Breaking Changes';
