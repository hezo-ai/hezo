-- Persist raster-image pixel dimensions on library assets so agents (and the
-- asset MCP tools / web UI) can read an image's width/height without downloading
-- and parsing the blob. Nullable: non-raster assets (SVG, PDF, scripts, media)
-- have no pixel dimensions, and rows written before this migration backfill
-- lazily on the next read_project_asset. Mirrors the agent_icons/user_icons
-- width/height columns.

ALTER TABLE assets ADD COLUMN width INTEGER;
ALTER TABLE assets ADD COLUMN height INTEGER;
