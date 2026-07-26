-- User-controlled ordering for the project rail: the operator drags a project
-- avatar up or down and the rail remembers where it was put. Before this, rail
-- order was derived (`created_at DESC`), so the project you work in every day
-- drifted down as newer projects were created.
--
-- Ascending, lowest first — `display_order` 1 is the topmost avatar. The sort key
-- everywhere is `display_order ASC, created_at DESC`; the tiebreak keeps the old
-- behaviour for rows that tie (concurrent creates, an unarchived project rejoining
-- the rail). Plain integers with a full renumber per reorder rather than sparse or
-- float positions: the list is tens of rows at most and the renumber is one
-- statement, so the column stays trivially readable.
--
-- Newly created projects are inserted at `MIN(display_order) - 1` so they keep
-- landing on top, as they do today. Values therefore drift negative over time —
-- that is by design and harmless, and it self-heals because every reorder
-- renumbers the whole visible list back to 1..N.
--
-- The backfill assigns positions in the order the rail renders them today, so
-- upgrading an existing instance is a visual no-op. `id` breaks ties on identical
-- timestamps to keep the backfill deterministic.
ALTER TABLE projects ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
    SELECT id, row_number() OVER (ORDER BY created_at DESC, id) AS rn FROM projects
)
UPDATE projects p SET display_order = ranked.rn FROM ranked WHERE p.id = ranked.id;

-- Mirrors `idx_projects_active` (026) — the partial index behind the active-only
-- rail listing, now keyed by the column that listing actually orders on.
CREATE INDEX idx_projects_display_order ON projects(display_order, created_at DESC)
    WHERE archived_at IS NULL;
