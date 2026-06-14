-- Runtime model pricing (per-model token rates → run cost).
--
-- Single source of truth for the dollar cost of a run. The agent stream parser
-- reports token buckets per run; the cost is `tokens × rate` looked up here
-- (services/pricing). This replaces reading a per-runtime cost field out of CLI
-- output, so OpenAI (Codex) and Google (Gemini) runs — which emit tokens only,
-- no cost — get real cost, and providers whose model ids the Claude Code price
-- map doesn't know (DeepSeek's `deepseek-v4-pro`, Z.ai's GLM ids) can be priced
-- via an operator override row.
--
-- Two row sources share the table, distinguished by `source`:
--   'litellm' — seeded on first boot from a bundled snapshot, then refreshed
--               periodically from the public LiteLLM pricing feed.
--   'manual'  — operator overrides. These WIN at lookup time and are never
--               touched by the feed refresh.
-- Rates are per-token, matching the feed. Cache columns are nullable; when a
-- model has no distinct cache rate the lookup falls back to the input rate.
CREATE TABLE model_pricing (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id                 TEXT NOT NULL,
    input_per_token          DOUBLE PRECISION NOT NULL,
    output_per_token         DOUBLE PRECISION NOT NULL,
    cache_read_per_token     DOUBLE PRECISION,
    cache_creation_per_token DOUBLE PRECISION,
    source                   TEXT NOT NULL DEFAULT 'litellm' CHECK (source IN ('litellm', 'manual')),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_id, source)
);

CREATE INDEX idx_model_pricing_model ON model_pricing(model_id);
