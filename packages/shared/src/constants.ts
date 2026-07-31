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
 * Instance-wide default memory cap per project container, in GB. Dual role:
 * the Docker cgroup memory limit applied to every container that doesn't carry
 * a per-project override, and the divisor in the automatic max-active-container
 * default ((RAM + swap) / cap). Stored in system_meta; absent key = default.
 */
export const DEFAULT_RAM_CAP_PER_CONTAINER_GB = 2;
export const RAM_CAP_PER_CONTAINER_GB_MIN = 1;
export const RAM_CAP_PER_CONTAINER_GB_MAX = 512;

/**
 * Host memory, in GiB, that the automatic max-active-containers default never
 * hands to containers. The OS, Hezo's own Bun process (API, MCP endpoint, egress
 * proxy, Docker control plane) and — on the default embedded backend — Postgres
 * all live *outside* every container and still need memory; sizing the limit off
 * the full RAM + swap total treated that overhead as free and oversubscribed
 * small hosts. A floor, not a share: it does not scale with host size.
 *
 * It also absorbs the per-container `MEMORY_HARD_CAP_HEADROOM_BYTES` slack that
 * the whole-GiB arithmetic does not model exactly.
 */
export const HOST_RESERVED_MEMORY_GB = 1;

/**
 * Host memory available to containers: total virtual memory (RAM + swap),
 * rounded to whole GiB, less {@link HOST_RESERVED_MEMORY_GB}. Split out from
 * {@link computeDefaultMaxContainerMemoryGb} so the web settings page can render
 * the same usable figure instead of re-deriving the rounding.
 *
 * **Swap counts at full weight**, deliberately: an agent container spends most of
 * its life idle between execs, so its cold pages really can live on disk, and a
 * host with swap configured genuinely fits more containers than its RAM alone.
 * The budget is total virtual memory, not RAM. (A managed sandbox backend does no
 * memory arithmetic at all - its cap is a spend guard.)
 */
export function usableMemoryGibForContainers(
	totalRamBytes: number,
	totalSwapBytes: number,
): number {
	const gib = 1024 ** 3;
	const totalGib = Math.round((totalRamBytes + totalSwapBytes) / gib);
	return Math.max(0, totalGib - HOST_RESERVED_MEMORY_GB);
}

/**
 * Total memory, in GB, that all running containers may consume at once.
 *
 * **The cap is a memory budget, not a container count.** A count only bounds
 * memory while every container is the same size, and `projects.memory_limit_gib`
 * exists precisely so one project's containers can be bigger. Under a count, a
 * project overriding to 4 GB silently doubles its share: an instance sized for
 * three 2 GB containers would happily run three 4 GB ones and oversubscribe the
 * host - or, on a managed backend, quietly double the bill for the same number.
 * Summing what each container actually asked for makes the cap mean one thing
 * regardless of overrides.
 *
 * The trade-off, which is real: a large container waits for enough budget rather
 * than for any free slot, so it can be overtaken by smaller runs. That is why
 * {@link projectMemoryFitsBudget} refuses a per-project cap larger than the whole
 * budget - a request that can never fit is a configuration error the operator
 * should see at once, not a run that queues forever with nothing to show why.
 */
export const MAX_CONTAINER_MEMORY_GB_MIN = 1;
export const MAX_CONTAINER_MEMORY_GB_MAX = 4096;

/** Last-resort budget when host memory is unreadable: the old 3 x 2 GB shape. */
export const DEFAULT_MAX_CONTAINER_MEMORY_GB = 6;

/**
 * The automatic memory-budget default: everything host memory allows, less the
 * system reserve and one container's worth held back for the CEO chat.
 *
 * Chat is exempt from the budget (a queued task run is invisible; a queued chat
 * turn is a person watching a spinner), and reserving for it up front rather
 * than subtracting when a session opens keeps task-run capacity a *stable*
 * number - opening the chat never silently slows the fleet.
 */
export function computeDefaultMaxContainerMemoryGb(
	totalRamBytes: number,
	totalSwapBytes: number,
	ramCapGb: number,
): number {
	const cap = Math.max(1, ramCapGb);
	const usableGib = Math.max(0, usableMemoryGibForContainers(totalRamBytes, totalSwapBytes) - cap);
	return Math.min(
		MAX_CONTAINER_MEMORY_GB_MAX,
		Math.max(MAX_CONTAINER_MEMORY_GB_MIN, Math.floor(usableGib)),
	);
}

/**
 * Whether a per-container memory cap can ever be satisfied by the budget.
 *
 * Enforced where the cap is set - the instance default and the per-project
 * override - rather than at acquire time, because at acquire time the only
 * honest response would be to queue a run that can never start.
 */
export function projectMemoryFitsBudget(capGb: number, budgetGb: number): boolean {
	return capGb <= budgetGb;
}

/**
 * Minutes a project's containers keep running after their last activity (agent
 * runs, assistant chat) before the idle pass retires the pool - suspending one
 * and destroying the rest. Containers come back on demand.
 *
 * **A constant, not an operator setting.** Its only real job is coalescing a
 * burst: covering the gap between one run finishing and the next starting in the
 * same project, so the next run finds a warm container rather than resuming or
 * creating one. That gap is a comment insert, a wakeup fire, the 1 Hz dispatch
 * cron and a container acquire - seconds to about a minute. Two minutes is the
 * smallest value that reliably covers that chain; one can suspend a container
 * mid-wakeup-chain, so the next run pays a resume and the instance pays the
 * suspend work twice for nothing. Longer buys very little, because resuming a
 * suspended container costs about a second anyway.
 *
 * An operator has no way to reason about this better than the system can, which
 * is exactly the kind of knob worth deleting - and the old `0 = never stop`
 * escape hatch was the only thing keeping a dev server alive between runs, which
 * is a job an agent-run container was never the right home for.
 */
export const CONTAINER_IDLE_TIMEOUT_MIN = 2;

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
