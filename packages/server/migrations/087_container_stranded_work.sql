-- Record which branch, in which repository, pins a container that holds the only
-- copy of committed work.
--
-- The pin was one boolean per container (`has_unpushed_commits`), and every task
-- run overwrote it from a scan of its own task branch only. A run on task B with
-- nothing unpushed therefore released a container still holding task A's
-- stranded commits, and the pool was then free to destroy the only copy. The
-- same happened inside one task across repositories: a clean scan of repo R2
-- released the pin R1's commits had set.
--
-- A row here is one clone's branch whose commits reached no durable remote and
-- could not be copied to the recovery vault. A run adds the row for each clone
-- it leaves in that state and deletes the row for each clone whose work reached
-- the remote or the vault, so a run only ever answers for the branch it scanned.
-- The container stays pinned while any row remains.
--
-- `has_unpushed_commits` stays, as a value derived from this table: the one
-- writer recomputes it from these rows in the same transaction, and every reader
-- (the pool ladder, the idle planners, the dormant sweep, cross-project reclaim,
-- the Containers page) is unchanged.
--
-- `task_id` is for routing only: the pool sends the task's next run back to the
-- container holding its work, which is the run that can push or copy it out. A
-- deleted task leaves its row with a NULL `task_id`, so the pin stays and only
-- the routing is lost.
--
-- `repo_name` and `branch` NULL together mean "cause unknown": a container that
-- was already pinned before this migration, when nothing recorded which branch
-- pinned it. No run can answer for an unknown branch, so no run clears that row.
-- It goes when an operator removes the container, or with the project.
CREATE TABLE IF NOT EXISTS container_stranded_work (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Cascades because a member row is deleted only when its container is
    -- removed, and then there is nothing left to pin.
    container_id TEXT NOT NULL
                 REFERENCES container_pool_members(container_id) ON DELETE CASCADE,
    task_id      UUID REFERENCES tasks(id) ON DELETE SET NULL,
    repo_name    TEXT,
    branch       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT container_stranded_work_cause_known_together
        CHECK ((repo_name IS NULL) = (branch IS NULL)),
    -- Also serves every per-container read and write, which leads with
    -- `container_id`: the run-end write and the per-member lookup the pool
    -- makes on every container acquire.
    CONSTRAINT container_stranded_work_branch_unique
        UNIQUE (container_id, repo_name, branch)
);

-- Serves the `ON DELETE SET NULL` when a task is deleted.
CREATE INDEX IF NOT EXISTS idx_container_stranded_work_task
    ON container_stranded_work (task_id)
    WHERE task_id IS NOT NULL;

-- Carry every existing pin across as a row of unknown cause, so the upgrade
-- releases nothing.
INSERT INTO container_stranded_work (container_id)
SELECT m.container_id
  FROM container_pool_members m
 WHERE m.has_unpushed_commits
   AND NOT EXISTS (
         SELECT 1 FROM container_stranded_work s
          WHERE s.container_id = m.container_id AND s.branch IS NULL
       );
