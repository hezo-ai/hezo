-- Per-project dashboard widget order preference (set by the user via drag-to-reorder).
-- NULL = unset, use the default order. Stored as a jsonb array of DashboardWidgetId strings.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS dashboard_widget_order jsonb DEFAULT NULL;
