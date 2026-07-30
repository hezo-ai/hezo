-- A per-project run cap returns, deliberately, after 048 dropped one. Read that
-- file first: it removed `projects.max_concurrent_runs` because a per-project cap
-- "cannot bound what the host actually experiences: N projects x M runs each all
-- land on the same box." That reasoning still holds and is untouched here - the
-- host bound remains `max_active_containers x ram cap`, which is unaffected by
-- how many runs share a container.
--
-- This column answers a different question: how many of ONE project's agents may
-- run at once inside its shared container, so a single project cannot stampede
-- itself with a dozen agents contending for CPU, the git worktree and the egress
-- proxy. It is a throughput / fair-share knob, not a memory bound. Nullable, so
-- NULL = inherit the global default (system_meta 'default_max_runs_per_project'),
-- matching the inherit-or-override shape memory_limit_gib already has - unlike
-- the NOT NULL DEFAULT 3 column 001 declared.
ALTER TABLE projects ADD COLUMN max_concurrent_runs INTEGER
    CHECK (max_concurrent_runs IS NULL OR max_concurrent_runs >= 1);

-- Memory caps become fractional to one decimal place, floor 0.5 GB, so a small
-- host can pack containers more tightly than a whole-GB divisor allows.
--
-- The inline CHECK (memory_limit_gib >= 1) from 001 is still live: 048 altered
-- only NOT NULL and the DEFAULT, neither of which touches a check constraint.
-- Left in place it would reject every fractional cap at write time, so it is
-- dropped and re-added at the new floor. DOUBLE PRECISION rather than NUMERIC
-- because NUMERIC is returned as a *string* by both drivers (pinned by
-- database-conformance.test.ts), which would silently break the byte arithmetic
-- in services/containers.ts. Widening INTEGER -> DOUBLE PRECISION is lossless,
-- so existing caps carry over exactly and no backfill is needed.
ALTER TABLE projects DROP CONSTRAINT projects_memory_limit_gib_check;
ALTER TABLE projects ALTER COLUMN memory_limit_gib TYPE DOUBLE PRECISION;
ALTER TABLE projects ADD CONSTRAINT projects_memory_limit_gib_check
    CHECK (memory_limit_gib IS NULL OR memory_limit_gib >= 0.5);
