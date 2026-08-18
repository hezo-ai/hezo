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
 * Roles addressed only by their role, never by a human name: the Captain and the
 * HQ singletons. There is one of each and the role *is* who they are.
 *
 * A policy check rather than a schema constraint - `member_agents.human_name`
 * exists for every agent, so naming these later is a one-line change here. The
 * server enforces it on every write path; the settings form hides the field.
 */
export function isNameOnlyRole(slug: string): boolean {
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
 * The budget is total virtual memory, not RAM.
 *
 * Only meaningful for a backend that runs containers on this host - see
 * {@link computeDefaultMaxContainerMemoryGb}, which is where that check lives.
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

/**
 * Memory a container engine's containers draw from, as reported by the engine.
 *
 * `null` where a container's memory is not this host's to spend - the engine
 * runs them elsewhere - which is the only distinction the capacity model needs
 * to make, and the reason it needs no idea which provider is in use.
 */
export interface ContainerHostMemory {
	totalRamBytes: number;
	totalSwapBytes: number;
}

/**
 * The budget when there is no host memory to derive one from: a managed backend,
 * or a host whose memory is unreadable. The old 3 x 2 GB shape.
 *
 * Deliberately modest rather than generous. On a managed backend this figure is
 * a **spend guard**, and the cost of setting it too low is a queued run the
 * operator can see and raise; the cost of setting it too high is a bill they
 * find out about later.
 */
export const DEFAULT_MAX_CONTAINER_MEMORY_GB = 6;

/**
 * The automatic memory-budget default, in GB.
 *
 * **Only an engine that runs containers on this host derives from host memory**,
 * which is why the input is the engine's own answer rather than a probe. A
 * managed backend's containers run on the provider's machines, so the operator's
 * RAM says nothing about how many fit: deriving from it would size the fleet by
 * the wrong computer, and wrongly in both directions - a 2 GB VPS driving a
 * managed backend would compute a budget that fits no container at all, while a
 * 128 GB workstation would authorise 127 GB of somebody else's hardware.
 * {@link DEFAULT_MAX_CONTAINER_MEMORY_GB} stands in there, and the operator
 * raises it deliberately.
 *
 * On a host engine it is everything host memory allows, less the system reserve
 * ({@link HOST_RESERVED_MEMORY_GB}, via {@link usableMemoryGibForContainers})
 * and one container's worth held back for the CEO chat.
 *
 * Chat is exempt from the budget on **every** backend (a queued task run is
 * invisible; a queued chat turn is a person watching a spinner), so the chat
 * container is excluded from what the budget counts as used. Reserving for it up
 * front rather than subtracting when a session opens keeps task-run capacity a
 * *stable* number - opening the chat never silently slows the fleet. The
 * managed-backend default already has that reservation priced in, which is why
 * it is not subtracted again here.
 */
export function computeDefaultMaxContainerMemoryGb(
	hostMemory: ContainerHostMemory | null,
	ramCapGb: number,
): number {
	if (!hostMemory) return DEFAULT_MAX_CONTAINER_MEMORY_GB;
	const cap = Math.max(1, ramCapGb);
	const usableGib = Math.max(
		0,
		usableMemoryGibForContainers(hostMemory.totalRamBytes, hostMemory.totalSwapBytes) - cap,
	);
	// **Floored at one container's cap, not at MAX_CONTAINER_MEMORY_GB_MIN.**
	// The budget is compared against a whole container's request, so a budget
	// below the cap admits nothing: every run queues `InstanceAtCapacity`
	// forever with nothing naming the cause. Flooring at 1 GB did exactly that
	// on any host with roughly 5 GiB or less of RAM+swap - a 4 GB VPS with no
	// swap yielded a 1 GB budget against the 2 GB default cap - so the
	// instance bricked on hardware the docs treat as ordinary.
	//
	// Admitting one container over-subscribes a host that genuinely cannot fit
	// it, and that is the better failure: the container is memory-capped, so
	// the kernel bounds the damage to that one run, whereas the alternative is
	// an instance that can never do anything at all.
	return Math.min(MAX_CONTAINER_MEMORY_GB_MAX, Math.max(cap, Math.floor(usableGib)));
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
 * Disk, in GB, allocated to each project container.
 *
 * The sibling of the per-container RAM cap: an instance-wide default, overridable
 * per project. Unlike memory it is only meaningful where the backend allocates a
 * per-container filesystem - a managed sandbox does, a local Docker container's
 * workspace is a bind mount with the operator's whole disk behind it - so each
 * engine absorbs it, and the setting is stated once rather than branched on by a
 * caller.
 *
 * Small on purpose. A sandbox's disk is billed and quota'd by the provider, and
 * the account-wide disk quota is usually what binds first, so the default is
 * sized for a working checkout plus its dependencies rather than for the largest
 * repository anyone might have. Raise it - globally or for the one project that
 * needs it - rather than paying for headroom every project holds and none uses.
 */
export const DEFAULT_CONTAINER_DISK_GB = 5;
/** Below this a checkout plus `node_modules` does not reliably fit. */
export const CONTAINER_DISK_GB_MIN = 2;
export const CONTAINER_DISK_GB_MAX = 1024;

/**
 * Headroom, in GB, left below a container's allocation before the pool recycles
 * it rather than handing it to another run.
 *
 * A container that fills up *during* a run fails that run partway through, which
 * is strictly worse than paying for a fresh container up front - so the recycle
 * threshold sits below the allocation, not at it, and the gap has to be big
 * enough for one run's growth (a dependency install, a build output).
 */
const POOL_DISK_HEADROOM_GB = 1;

/**
 * Disk a container may consume before the pool recycles it, in bytes.
 *
 * Derived from that container's own allocation rather than fixed, because the
 * allocation is now configurable: a ceiling that made sense against one size is
 * either pointless (far above what the container can hold) or thrashing (recycles
 * a container that had plenty left) against another. The floor keeps the
 * threshold meaningful when the allocation is small enough that the flat headroom
 * would consume most of it.
 */
export function poolDiskCeilingBytes(diskGb: number): number {
	const usable = Math.max(diskGb / 2, diskGb - POOL_DISK_HEADROOM_GB);
	return Math.round(usable * 1024 ** 3);
}

/**
 * Bytes as GB to one decimal - the unit every container surface reports in.
 *
 * Shared rather than per-surface because the run log names a container's size
 * and then links straight to the page that names it again: rounding the two
 * differently would show one container as two.
 */
export function formatGib(bytes: number): string {
	return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
}

/**
 * The run log's opening line naming the container the run was given and what it
 * was built with.
 *
 * Written by the runner and matched by the log viewer, which turns the id into a
 * link to that container's page - so the two halves live together and are
 * round-tripped by one test rather than being a format one side re-derives.
 *
 * The **full** engine id goes in the line, not a truncated one: it is what the
 * container page is keyed on, and a log line is also the thing an operator
 * copies into their own tooling. The viewer shortens it for display.
 *
 * The memory segment is dropped rather than guessed when the allocation is
 * unrecorded, which is the same thing the Containers page does with it.
 */
export function formatContainerMetaLogLine(meta: {
	containerId: string;
	memoryBytes: number | null;
	diskCeilingBytes: number;
}): string {
	const parts = [`${CONTAINER_META_LOG_LABEL}${meta.containerId}`];
	if (meta.memoryBytes !== null) parts.push(`${formatGib(meta.memoryBytes)} RAM`);
	parts.push(`${formatGib(meta.diskCeilingBytes)} disk`);
	return parts.join(CONTAINER_META_LOG_SEPARATOR);
}

/**
 * The wording of {@link formatContainerMetaLogLine}, exported because the viewer
 * rebuilds the line around a shortened, linked id and must not restate it.
 *
 * Untranslated like every other runner line: the log is written once, in one
 * language, and persisted verbatim.
 */
export const CONTAINER_META_LOG_LABEL = 'Container ';
export const CONTAINER_META_LOG_SEPARATOR = ' · ';

/** The id and the rendered remainder of {@link formatContainerMetaLogLine}, or null for any other line. */
export function parseContainerMetaLogLine(
	text: string,
): { containerId: string; details: string } | null {
	if (!text.startsWith(CONTAINER_META_LOG_LABEL)) return null;
	const [containerId, ...rest] = text
		.slice(CONTAINER_META_LOG_LABEL.length)
		.split(CONTAINER_META_LOG_SEPARATOR);
	if (!containerId || /\s/.test(containerId)) return null;
	return { containerId, details: rest.join(CONTAINER_META_LOG_SEPARATOR) };
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
 * The same window, for a project whose **assistant chat session is live**.
 *
 * Longer because the two are measuring different things. Between agent runs the
 * gap is mechanical - a wakeup fires, the dispatch cron ticks, a container is
 * acquired - and two minutes covers it. Between chat messages the gap is a
 * person reading a reply and deciding what to say next, and two minutes of that
 * is an ordinary pause, not an idle instance. Reclaiming there suspended the
 * container out from under an open chatbox, so the next message paid a cold
 * start (~30s on a managed backend) for a conversation the operator never left.
 *
 * Fifteen minutes is "you have gone away" rather than "you are thinking". It
 * applies only while a session is `starting`/`running` - once it stops, the
 * project falls back to the ordinary window immediately.
 */
export const CHAT_IDLE_TIMEOUT_MIN = 15;

/**
 * How long a member must have sat idle before another **project** may reclaim it
 * to fit its own container into the memory budget.
 *
 * Much shorter than {@link CONTAINER_IDLE_TIMEOUT_MIN} because it answers a
 * different question. The idle window asks "is this container still worth
 * keeping warm?", and the answer stays yes for a while because nothing else
 * wants the memory. Reclaim only runs when something else demonstrably does: a
 * run that is otherwise queued indefinitely. A starved project waiting two
 * minutes for a container its neighbour is not using is the defect, not the
 * remedy.
 *
 * It is not zero, and that is what stops the thrash. A project mid-burst
 * releases a container between two runs seconds apart, and stripping it in that
 * gap would make the pair of runs pay a cold start each to hand memory to a
 * third project that would then lose it the same way. Thirty seconds is longer
 * than the release-to-reacquire chain (comment insert, wakeup fire, 1 Hz
 * dispatch cron, acquire) and short enough that a genuinely stranded run is not
 * left waiting on a container nobody wants.
 */
export const CONTAINER_RECLAIM_MIN_IDLE_SEC = 30;

/**
 * How long a container must have **existed** before another project may reclaim
 * it, independent of how long it has sat idle.
 *
 * {@link CONTAINER_RECLAIM_MIN_IDLE_SEC} floors the idle clock; this floors the
 * container's whole life, and they are different questions. One created at T,
 * claimed, and released at T+5s clears the idle floor at T+35s while still being
 * a container the instance has only just paid a cold provision for - an image
 * resolve, a clone and a round of package installs. Retiring it to hand its
 * memory to a project that will pay the same cold start for a replacement is a
 * loss on both sides.
 *
 * Derived rather than picked. It must exceed {@link CONTAINER_IDLE_TIMEOUT_MIN}
 * so a project's own surplus-idle pass always gets first refusal: that pass
 * keeps the project warm and cross-project reclaim cannot, so memory reachable
 * both ways should be freed the cheaper way. And it must stay inside the
 * capacity-park window, so a run blocked behind this floor is still parked
 * rather than requeued when the surplus pass frees the same memory properly.
 * Five minutes sits between the two with room either side.
 */
export const CONTAINER_RECLAIM_MIN_AGE_SEC = 300;

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

/**
 * Lowest heartbeat cadence the scheduler honours, in minutes. Anything lower is
 * clamped up to this when the next heartbeat is computed, so offering a shorter
 * cadence anywhere would promise a tick that never fires.
 *
 * The server's effective floor is this value unless `HEZO_HEARTBEAT_FLOOR_MIN`
 * raises it (see `HEARTBEAT_INTERVAL_FLOOR_MIN` in
 * `services/heartbeat-schedule.ts`, the authority for validation). The web has
 * no access to that env var, so it builds its cadence options from this
 * constant: an operator who raises the floor gets a UI that under-reports it,
 * which is better than the browser guessing.
 */
export const HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT = 60;

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
	 * One container's log stream.
	 *
	 * Keyed on the **container**, not the project that owns it. A project holds as
	 * many containers as it has concurrent runs, so a project-keyed room merged
	 * several containers' output into one stream and attributed it to whichever
	 * container the page happened to be showing.
	 */
	containerLogs: (containerId: string) => `container-logs:${containerId}`,
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

/**
 * Why a run is sitting in `queued`, as stamped on `heartbeat_runs.queued_reason`.
 *
 * The values are the stored strings, so they are what a pre-existing row already
 * holds and what the server's own SQL matches on. They live here rather than
 * server-side because the web has to recognise a reason to explain it: an
 * operator reading "queued" wants to know whether that is normal and whether it
 * needs them, and the two answers differ per reason.
 *
 * `CAPACITY_PARK` is load-bearing beyond display - a run parked on it holds no
 * container, so the idle pass must not count its project as busy or it would
 * never reclaim the capacity that run is waiting for.
 */
export const QueuedRunReason = {
	/** At the instance's memory budget; waiting for a container to be released. */
	CapacityPark: 'waiting for container capacity',
	/** The provider credential runs one agent at a time; waiting its turn. */
	CredentialSerialized: 'waiting for prior run on this credential',
} as const;
export type QueuedRunReason = (typeof QueuedRunReason)[keyof typeof QueuedRunReason];

export const QUEUED_RUN_REASONS = [
	QueuedRunReason.CapacityPark,
	QueuedRunReason.CredentialSerialized,
] as const;

/** Whether a stored `queued_reason` is one this build knows how to explain. */
export function isQueuedRunReason(value: unknown): value is QueuedRunReason {
	return typeof value === 'string' && (QUEUED_RUN_REASONS as readonly string[]).includes(value);
}

/**
 * Why a run ended up `cancelled`.
 *
 * `cancelled` covers two opposite events. Two of these are somebody deciding to
 * stop: an operator pressing Terminate, or a task being cancelled or re-opened
 * so its pending work is moot. The other two are the instance giving up on its
 * own, and only one of those leaves work owed with nothing carrying it.
 */
export const RunCancelReason = {
	/** A person pressed Terminate on this run. */
	OperatorTerminated: 'operator_terminated',
	/** Nobody wants the work any more: the task was cancelled, or a re-open made a review moot. */
	WorkWithdrawn: 'work_withdrawn',
	/** The instance gave up waiting and put the work back on the queue. */
	HandedBack: 'handed_back',
	/** The instance gave up and could not put the work back. Needs a human. */
	Abandoned: 'abandoned',
} as const;
export type RunCancelReason = (typeof RunCancelReason)[keyof typeof RunCancelReason];

export const RUN_CANCEL_REASONS = [
	RunCancelReason.OperatorTerminated,
	RunCancelReason.WorkWithdrawn,
	RunCancelReason.HandedBack,
	RunCancelReason.Abandoned,
] as const;

/**
 * What each cancel means for the reader, as a table rather than a branch: a new
 * reason is a row here and a compile error at every consumer until it is filled
 * in, instead of four call sites quietly falling through to a default.
 *
 * `offerRetry` is false for `handed_back` on purpose. The work is already queued
 * there, so a Retry button would be dead UI at best and a double dispatch at
 * worst; `abandoned` is the only cancel where a person still has something to do.
 */
export const RUN_CANCEL_BEHAVIOUR: Record<
	RunCancelReason,
	{
		/** The work this run was woken for has still not been done. */
		workStillOwed: boolean;
		/** Nothing is carrying that work, so offer the reader a way to run it again. */
		offerRetry: boolean;
	}
> = {
	[RunCancelReason.OperatorTerminated]: { workStillOwed: false, offerRetry: false },
	[RunCancelReason.WorkWithdrawn]: { workStillOwed: false, offerRetry: false },
	[RunCancelReason.HandedBack]: { workStillOwed: true, offerRetry: false },
	[RunCancelReason.Abandoned]: { workStillOwed: true, offerRetry: true },
};

/**
 * Whether a stored `cancel_reason` is one this build knows what to do with.
 *
 * Guarding rather than indexing straight into the table matters across a
 * version skew: a reason written by a newer server reads as unknown here and
 * falls through to "no Retry", which is the safe answer, instead of indexing to
 * `undefined` and throwing in the middle of a render.
 */
export function isRunCancelReason(value: unknown): value is RunCancelReason {
	return typeof value === 'string' && (RUN_CANCEL_REASONS as readonly string[]).includes(value);
}

/**
 * Whether a cancelled run should offer the reader a way to run it again.
 *
 * The guard plus the table lookup, in one place, because both surfaces that ask
 * (the run card's own button and the thread's fold rule) must agree - a fold
 * that opens on a row with no button, or a button on a folded row, is worse than
 * either answer alone. An unknown or absent reason is false: an older cancel
 * carries no attribution, and inventing an affordance for it would re-dispatch
 * work somebody may have deliberately stopped.
 */
export function runCancelOffersRetry(reason: string | null | undefined): boolean {
	return isRunCancelReason(reason) && RUN_CANCEL_BEHAVIOUR[reason].offerRetry;
}
