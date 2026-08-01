-- Container disk becomes a setting, and the pool's recycle threshold becomes a
-- property of each container rather than a constant.
--
-- Disk was fixed at whatever the adapter hardcoded (10 GB on Daytona) and the
-- pool recycled a member at a flat 2 GB. That pairing only makes sense for one
-- allocation size: on a provider whose account-wide disk quota is what binds
-- first, 10 GB per sandbox buys headroom nobody uses and costs slots everybody
-- wants, and a 2 GB recycle threshold against it churns containers with 8 GB
-- free. So the allocation becomes an instance default with a per-project
-- override - the same shape as the per-container RAM cap, which projects already
-- override the same way - and the threshold is derived from it.
--
-- The threshold is stored per member rather than computed at read time on
-- purpose: a container keeps the ceiling matching the disk it was actually
-- created with. Raising the default afterwards must not tell a container that was
-- given the old allocation that it may fill to the new one, because it really does
-- only have what it was created with and the run that discovered otherwise would
-- fail partway through.

-- NULL means "inherit the instance default", exactly like memory_limit_gib.
ALTER TABLE projects ADD COLUMN container_disk_gb INTEGER;

ALTER TABLE projects ADD CONSTRAINT projects_container_disk_gb_positive
    CHECK (container_disk_gb IS NULL OR container_disk_gb >= 2);

-- Existing members keep the flat 2 GB they were provisioned and judged against.
-- Backfilling them to a threshold derived from the *new* default would change
-- the recycle behaviour of containers that already exist, which is the one thing
-- this migration must not do.
ALTER TABLE container_pool_members
    ADD COLUMN disk_ceiling_bytes BIGINT NOT NULL DEFAULT 2147483648;
