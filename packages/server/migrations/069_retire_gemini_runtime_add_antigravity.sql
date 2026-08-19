-- 069: retire the Gemini runtime, add Antigravity (`agy`).
--
-- Google retired the Gemini CLI's consumer Login-with-Google sign-in, so Hezo
-- runs Google models on the Antigravity CLI (`agy`) instead - API-key only.
-- Three data changes, NONE of which *uses* the new enum value in this
-- transaction, so the whole file applies at once (Postgres forbids using a
-- freshly-added enum label in the transaction that adds it - see writing-migrations.md).
--
-- 1. Add the 'antigravity' agent_runtime label. Additive; existing rows keep
--    their labels. The old 'gemini' label stays (Postgres can't drop it) but no
--    runtime maps to it any more - stored 'gemini' credential rows resolve to the
--    Google provider default (antigravity) through effectiveRuntime, so they need
--    no rewrite here.
--
-- 2. Google *subscription* credentials can no longer run: Antigravity's consumer
--    subscription uses a keyring-only interactive login Hezo cannot yet deliver
--    into a run container, and the API-key runtime mounts no credential file
--    either way. Mark them invalid so the resolver drops them (it selects only
--    status='verified'), preserving the encrypted blob rather than deleting the
--    operator's data. is_default is deliberately LEFT set: a default that is
--    invalid fails runs loudly ("the instance default AI provider is invalid")
--    rather than silently switching every agent to a different provider.
--
-- 3. Tasks pinned to runtime_type='gemini' would fail to resolve (no provider
--    maps to gemini). NULL the pin so the task falls back to the provider default
--    at launch. Only the pre-existing 'gemini' label is read; nothing is set to
--    the new 'antigravity' value here.

ALTER TYPE agent_runtime ADD VALUE IF NOT EXISTS 'antigravity';

UPDATE ai_provider_configs
SET status = 'invalid', updated_at = now()
WHERE provider = 'google' AND auth_method = 'subscription' AND status <> 'invalid';

UPDATE tasks
SET runtime_type = NULL
WHERE runtime_type = 'gemini';
