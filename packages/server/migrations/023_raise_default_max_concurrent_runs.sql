-- Raise the per-project concurrent agent-run ceiling default from 3 to 10.
-- New projects (created via project-create.ts / teams.ts, which never set the
-- column explicitly and rely on the DB default) now start at 10.
--
-- Existing projects still sitting on the old default (3) are bumped to the new
-- default so the change reaches deployed instances too. Projects an operator
-- deliberately customized to any other value are left untouched.
ALTER TABLE projects ALTER COLUMN max_concurrent_runs SET DEFAULT 10;

UPDATE projects SET max_concurrent_runs = 10 WHERE max_concurrent_runs = 3;
