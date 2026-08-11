-- Put pending credential requests in the admin inbox.
--
-- `request_credential` now raises an `admin_mentions` row per admin (via
-- fireAdminMention, the same seam an @admin mention rides), so the ask is
-- visible and dismissable outside the task thread it was posted in, and leaves
-- the dashboard's action items once someone reads it.
--
-- Requests filed before this migration have no such row, so without a backfill
-- they would vanish from every surface at once - an instance carrying weeks of
-- unanswered requests would simply lose them. This recreates the row that
-- would have been written at request time, for every credential request still
-- unanswered (`chosen_option IS NULL`) on a task that still exists.
--
-- Recipients mirror fireAdminMention exactly: the team's admin member_users ∪
-- all superusers. UNION dedupes a superuser who is also a team admin. No author
-- is excluded - a credential request is always filed by an agent.
--
-- `created_at` is taken from the comment, not now(): these rows are as old as
-- the ask, and dating them today would sort a 46-day-old request above this
-- morning's mention and reset the archive sweep's clock. `read_at` stays NULL
-- so the requests surface as unread, which is what they are.
--
-- No new index: every read of these rows goes through the existing
-- idx_admin_mentions_user_unread / _team_unread / _user_active.
INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id, created_at)
SELECT t.team_id, t.id, tc.id, recipients.user_id, tc.created_at
FROM task_comments tc
JOIN tasks t ON t.id = tc.task_id
CROSS JOIN LATERAL (
    SELECT mu.user_id
    FROM member_users mu
    JOIN members m ON m.id = mu.id
    WHERE m.team_id = t.team_id AND mu.role = 'admin'
    UNION
    SELECT u.id AS user_id FROM users u WHERE u.is_superuser = true
) AS recipients
WHERE tc.content_type = 'credential_request'::comment_content_type
  AND tc.chosen_option IS NULL
ON CONFLICT (comment_id, user_id) DO NOTHING;
