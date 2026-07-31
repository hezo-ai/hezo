-- Capacity becomes a memory budget instead of a container count.
--
-- `max_active_containers` bounded memory only while every container was the
-- same size, and `projects.memory_limit_gib` exists precisely so they are not:
-- a project raising its cap to 4 GB took one "slot" but twice the memory of the
-- 2 GB containers the instance was sized for, silently oversubscribing the host
-- (and, on a managed backend, silently doubling the bill for the same count).
--
-- Summing what each running container actually asked for makes the cap mean one
-- thing regardless of overrides. It also removes a setting rather than adding
-- one: how many containers fit now falls out of the budget and the per-container
-- cap, so there is nothing left for an operator to keep consistent by hand.
--
-- The trade-off is that a large container waits for enough budget rather than
-- for any free slot. That is a delay, not starvation, because a cap larger than
-- the whole budget is refused where it is set (see `projectMemoryFitsBudget`)
-- rather than queued forever.

-- Carry an explicit choice forward rather than dropping the operator's intent:
-- N containers at the effective per-container cap is N x cap GB. Only an
-- explicitly-set value is converted - an instance that never set one keeps
-- getting the computed default, which is now computed in GB.
INSERT INTO system_meta (key, value)
SELECT
    'max_container_memory_gb',
    (
        (SELECT value::int FROM system_meta WHERE key = 'max_active_containers')
        * COALESCE(
            (SELECT value::int FROM system_meta WHERE key = 'default_ram_cap_per_container_gb'),
            2
        )
    )::text
WHERE EXISTS (SELECT 1 FROM system_meta WHERE key = 'max_active_containers')
  AND NOT EXISTS (SELECT 1 FROM system_meta WHERE key = 'max_container_memory_gb')
ON CONFLICT (key) DO NOTHING;

-- The old key is read by nothing after this. Removing it is what stops a stale
-- number sitting in the settings table looking authoritative.
DELETE FROM system_meta WHERE key = 'max_active_containers';

-- The container idle window stops being an operator setting too.
--
-- Its only real job is coalescing a burst - covering the gap between one run
-- finishing and the next starting in the same project, so the next run finds a
-- warm container rather than resuming or creating one. That gap is seconds to
-- about a minute, and an operator has no way to reason about it better than the
-- system can, so it is now the `CONTAINER_IDLE_TIMEOUT_MIN` constant.
--
-- Nothing is carried forward: there is no new key for the value to move to, and
-- a stored number that nothing reads is worse than no row at all - it sits in
-- the settings table looking authoritative. The `0 = never stop` escape hatch
-- goes with it, deliberately: a container that never stops bills forever on a
-- managed backend, and the dev server it used to keep alive belongs in
-- something with its own lifecycle.
DELETE FROM system_meta WHERE key = 'container_idle_timeout_min';
