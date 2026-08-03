-- The last-known logs belong to a container, not to a project.
--
-- `projects.container_last_logs` is a single column describing "the project's
-- container", which stopped being a thing in 050: a project now holds as many
-- containers as it has concurrent runs, and the column can only ever hold one
-- of their snapshots - whichever was written last. An operator opening one
-- container to find out why it died was shown another container's output.
--
-- Additive, like 050. `projects.container_last_logs` stays: dropping a column
-- is its own migration once nothing reads it, and doing both at once means a
-- schema change and a rewrite of the container lifecycle land together.

ALTER TABLE container_pool_members
    ADD COLUMN last_logs TEXT;

-- Carry each project's existing snapshot onto the member it actually described.
--
-- Matched on `projects.container_id`, which is exactly what the column meant:
-- the logs were captured for the container that row named. A member the row
-- never named has no snapshot to inherit and correctly stays null - inventing
-- one by copying the project's would attribute another container's output to
-- it, which is the bug this migration exists to end.
UPDATE container_pool_members m
   SET last_logs = p.container_last_logs
  FROM projects p
 WHERE p.id = m.project_id
   AND p.container_id = m.container_id
   AND p.container_last_logs IS NOT NULL;
