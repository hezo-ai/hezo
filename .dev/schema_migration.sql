-- Migration 001: Initial schema
-- Company orchestration platform
--
-- NOTE: This file will be renamed to migrations/001_initial_schema.sql
-- in the implementation. All subsequent schema changes should be added
-- as new numbered migration files (e.g. 002_add_feature.sql).
-- See spec.md "Migration system" section for the full migration design.

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-------------------------------------------------------------------------------
-- MIGRATION TRACKING (created automatically by the migration runner,
-- included here for reference)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _migrations (
    id          SERIAL PRIMARY KEY,
    filename    TEXT NOT NULL UNIQUE,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    TEXT NOT NULL  -- SHA-256 of migration file contents
);

-------------------------------------------------------------------------------
-- SYSTEM META (master key canary, config)
-------------------------------------------------------------------------------

CREATE TABLE system_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- On first startup: INSERT INTO system_meta VALUES ('master_key_check', encrypt('CANARY', master_key));

-------------------------------------------------------------------------------
-- USERS & AUTH (Better Auth managed)
-------------------------------------------------------------------------------

CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL DEFAULT '',
    email_verified  BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token           TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token);

-------------------------------------------------------------------------------
-- ENUMS
-------------------------------------------------------------------------------

CREATE TYPE agent_runtime AS ENUM ('claude_code', 'codex', 'gemini', 'bash', 'http');
CREATE TYPE agent_status AS ENUM ('active', 'idle', 'paused', 'terminated');
CREATE TYPE container_status AS ENUM ('creating', 'running', 'stopped', 'error');
CREATE TYPE issue_status AS ENUM ('backlog', 'open', 'in_progress', 'review', 'blocked', 'done', 'closed', 'cancelled');
CREATE TYPE issue_priority AS ENUM ('urgent', 'high', 'medium', 'low');
CREATE TYPE comment_author_type AS ENUM ('board', 'agent', 'system');
CREATE TYPE comment_content_type AS ENUM ('text', 'options', 'preview', 'trace', 'system');
CREATE TYPE tool_call_status AS ENUM ('running', 'success', 'error');
CREATE TYPE secret_category AS ENUM ('ssh_key', 'credential', 'api_token', 'certificate', 'other');
CREATE TYPE grant_scope AS ENUM ('single', 'project', 'company');
CREATE TYPE approval_type AS ENUM ('secret_access', 'hire', 'strategy', 'kb_update', 'plan_review', 'deploy_production');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'denied');
CREATE TYPE audit_actor_type AS ENUM ('board', 'agent', 'system');
CREATE TYPE repo_host_type AS ENUM ('github');
CREATE TYPE platform_type AS ENUM ('github', 'gmail', 'gitlab', 'stripe', 'posthog', 'railway', 'vercel', 'digitalocean', 'x');
CREATE TYPE connection_status AS ENUM ('active', 'expired', 'disconnected');
CREATE TYPE wakeup_source AS ENUM ('timer', 'assignment', 'on_demand', 'mention', 'automation');
CREATE TYPE wakeup_status AS ENUM ('queued', 'claimed', 'completed', 'failed', 'skipped', 'coalesced', 'deferred', 'cancelled');
CREATE TYPE heartbeat_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out');
CREATE TYPE plugin_status AS ENUM ('installed', 'enabled', 'disabled', 'error');
CREATE TYPE membership_role AS ENUM ('owner', 'member');
CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE project_doc_type AS ENUM ('tech_spec', 'implementation_plan', 'research', 'ui_design_decisions', 'marketing_plan', 'other');

-------------------------------------------------------------------------------
-- COMPANY TYPES (blueprints/recipes for creating companies)
-------------------------------------------------------------------------------

CREATE TABLE company_types (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL UNIQUE,
    description         TEXT NOT NULL DEFAULT '',
    is_builtin          BOOLEAN NOT NULL DEFAULT false,  -- true for "Software Development"
    -- Snapshot of default config for new companies created from this type
    agents_config       JSONB NOT NULL DEFAULT '[]'::jsonb,
    kb_docs_config      JSONB NOT NULL DEFAULT '[]'::jsonb,
    preferences_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
    mcp_servers         JSONB NOT NULL DEFAULT '[]'::jsonb,
    mpp_config          JSONB NOT NULL DEFAULT '{"enabled": false}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- COMPANIES
-------------------------------------------------------------------------------

CREATE TABLE companies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    mission             TEXT NOT NULL DEFAULT '',
    -- The company type this company was created from
    company_type_id     UUID REFERENCES company_types(id) ON DELETE SET NULL,
    -- Auto-derived from name, globally unique (e.g. "ACME", "NOTE")
    issue_prefix        TEXT NOT NULL UNIQUE,
    -- Company email for outbound communication (invites, notifications)
    email               TEXT,
    -- Company-level budget cap across all agents
    budget_monthly_cents INTEGER NOT NULL DEFAULT 50000,  -- $500 default
    budget_used_cents    INTEGER NOT NULL DEFAULT 0,
    budget_reset_at      TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    -- Company-level MCP servers shared by all agents
    mcp_servers         JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- MPP wallet config
    mpp_config          JSONB NOT NULL DEFAULT '{"enabled": false}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- COMPANY MEMBERSHIPS
-------------------------------------------------------------------------------

CREATE TABLE company_memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        membership_role NOT NULL DEFAULT 'member',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, user_id)
);

CREATE INDEX idx_memberships_company ON company_memberships(company_id);
CREATE INDEX idx_memberships_user ON company_memberships(user_id);

-------------------------------------------------------------------------------
-- INVITES
-------------------------------------------------------------------------------

CREATE TABLE invites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    status      invite_status NOT NULL DEFAULT 'pending',
    invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    accepted_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invites_company ON invites(company_id);
CREATE INDEX idx_invites_code ON invites(code);

-------------------------------------------------------------------------------
-- API KEYS (for external orchestrators: OpenClaw, scripts, AI agents)
-------------------------------------------------------------------------------

CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    -- First 8 chars of the key, for display: "hezo_a3b8..."
    prefix          TEXT NOT NULL,
    -- bcrypt hash of the full key. Raw key shown once at creation.
    key_hash        TEXT NOT NULL,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_company ON api_keys(company_id);

-------------------------------------------------------------------------------
-- AGENTS
-------------------------------------------------------------------------------

CREATE TABLE agents (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    reports_to              UUID REFERENCES agents(id) ON DELETE SET NULL,
    title                   TEXT NOT NULL,
    -- Derived from title: lowercased, spaces→hyphens. Used for @-mentions.
    slug                    TEXT NOT NULL,
    role_description        TEXT NOT NULL DEFAULT '',
    system_prompt           TEXT NOT NULL DEFAULT '',
    runtime_type            agent_runtime NOT NULL DEFAULT 'claude_code',
    heartbeat_interval_min  INTEGER NOT NULL DEFAULT 60,
    monthly_budget_cents    INTEGER NOT NULL DEFAULT 3000,  -- $30 default
    budget_used_cents       INTEGER NOT NULL DEFAULT 0,
    budget_reset_at         TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    status                  agent_status NOT NULL DEFAULT 'idle',
    -- Agent-level MCP servers (merged with company-level at runtime)
    -- [{ "name": "db", "url": "stdio://...", "description": "..." }]
    mcp_servers             JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_heartbeat_at       TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Slug must be unique within a company (for unambiguous @-mentions)
    UNIQUE (company_id, slug)
);

CREATE INDEX idx_agents_company ON agents(company_id);
CREATE INDEX idx_agents_reports_to ON agents(reports_to);
CREATE INDEX idx_agents_status ON agents(company_id, status);

-------------------------------------------------------------------------------
-- PROJECTS
-------------------------------------------------------------------------------

CREATE TABLE projects (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    goal                TEXT NOT NULL DEFAULT '',
    -- Docker container for this project (one container per project)
    docker_base_image   TEXT NOT NULL DEFAULT 'node:20-slim',
    container_id        TEXT,          -- Docker container ID
    container_status    container_status,
    -- Dev preview port forwarding: [{"container": 3000, "host": 13000}]
    dev_ports           JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_company ON projects(company_id);

-------------------------------------------------------------------------------
-- REPOS
-------------------------------------------------------------------------------

CREATE TABLE repos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    short_name  TEXT NOT NULL,
    url         TEXT NOT NULL,
    host_type   repo_host_type NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- short_name unique within a project
    UNIQUE (project_id, short_name),

    -- URL must be GitHub (enforced in app layer too)
    CONSTRAINT valid_repo_url CHECK (
        url ~ '^https?://github\.com/'
    )
);

CREATE INDEX idx_repos_project ON repos(project_id);

-------------------------------------------------------------------------------
-- ISSUES
-------------------------------------------------------------------------------

-- Per-company auto-incrementing issue numbers
CREATE TABLE company_issue_counters (
    company_id  UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE issues (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    assignee_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    parent_issue_id     UUID REFERENCES issues(id) ON DELETE SET NULL,
    blocked_by_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
    created_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    number              INTEGER NOT NULL,
    -- Linear-style identifier: {prefix}-{number} (e.g. "ACME-42")
    identifier          TEXT NOT NULL UNIQUE,
    title               TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    status              issue_status NOT NULL DEFAULT 'backlog',
    priority            issue_priority NOT NULL DEFAULT 'medium',
    -- Simple labels as JSONB array: ["bug", "frontend"]
    labels              JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Work ownership: only one agent works on an issue at a time (may span days)
    execution_run_id    UUID,
    execution_locked_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Issue number unique within company
    UNIQUE (company_id, number)
);

CREATE INDEX idx_issues_company ON issues(company_id);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
CREATE INDEX idx_issues_status ON issues(company_id, status);
CREATE INDEX idx_issues_parent ON issues(parent_issue_id);
CREATE INDEX idx_issues_identifier ON issues(identifier);
CREATE INDEX idx_issues_blocked_by ON issues(blocked_by_issue_id);

-------------------------------------------------------------------------------
-- ISSUE COMMENTS
-------------------------------------------------------------------------------

CREATE TABLE issue_comments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_type     comment_author_type NOT NULL,
    author_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    -- What kind of content this comment carries
    content_type    comment_content_type NOT NULL DEFAULT 'text',
    -- Polymorphic content:
    --   text:    { "text": "message body" }
    --   options: { "prompt": "...", "options": [...] }
    --   preview: { "filename": "...", "label": "...", "description": "..." }
    --   trace:   { "summary": "4 tool calls" }  (detail in tool_calls table)
    --   system:  { "text": "Agent paused — budget limit reached" }
    content         JSONB NOT NULL,
    -- For options: records which option the user picked
    -- { "chosen_id": "jwt", "chosen_at": "..." }
    chosen_option   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_issue ON issue_comments(issue_id);
CREATE INDEX idx_comments_author ON issue_comments(author_agent_id);

-------------------------------------------------------------------------------
-- TOOL CALLS (trace log)
-------------------------------------------------------------------------------

CREATE TABLE tool_calls (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id  UUID NOT NULL REFERENCES issue_comments(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name   TEXT NOT NULL,
    input       JSONB,
    output      JSONB,
    status      tool_call_status NOT NULL DEFAULT 'running',
    duration_ms INTEGER,
    cost_cents  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_calls_comment ON tool_calls(comment_id);
CREATE INDEX idx_tool_calls_agent ON tool_calls(agent_id);

-------------------------------------------------------------------------------
-- SECRETS
-------------------------------------------------------------------------------

CREATE TABLE secrets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    -- NULL project_id = company-wide secret
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    -- Encrypted with MASTER_KEY (AES-256-GCM)
    encrypted_value TEXT NOT NULL,
    category        secret_category NOT NULL DEFAULT 'other',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Secret name unique within company+project scope
    UNIQUE (company_id, project_id, name)
);

CREATE INDEX idx_secrets_company ON secrets(company_id);
CREATE INDEX idx_secrets_project ON secrets(project_id);

-------------------------------------------------------------------------------
-- SECRET GRANTS
-------------------------------------------------------------------------------

CREATE TABLE secret_grants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_id   UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    scope       grant_scope NOT NULL DEFAULT 'single',
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,

    -- Prevent duplicate active grants
    UNIQUE (secret_id, agent_id)
);

CREATE INDEX idx_grants_agent ON secret_grants(agent_id);
CREATE INDEX idx_grants_secret ON secret_grants(secret_id);

-------------------------------------------------------------------------------
-- APPROVALS
-------------------------------------------------------------------------------

CREATE TABLE approvals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type                    approval_type NOT NULL,
    status                  approval_status NOT NULL DEFAULT 'pending',
    requested_by_agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    -- Polymorphic payload depending on type:
    --   secret_access: { "secret_id": "...", "reason": "..." }
    --   hire:          { "title": "...", "role_description": "...", "system_prompt": "...", 
    --                    "runtime_type": "...", "reports_to": "...", "budget": 3000 }
    --   strategy:      { "summary": "...", "details": "..." }
    payload                 JSONB NOT NULL,
    resolved_at             TIMESTAMPTZ,
    resolution_note         TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approvals_company ON approvals(company_id);
CREATE INDEX idx_approvals_status ON approvals(company_id, status);

-------------------------------------------------------------------------------
-- COST ENTRIES
-------------------------------------------------------------------------------

CREATE TABLE cost_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    issue_id    UUID REFERENCES issues(id) ON DELETE SET NULL,
    project_id  UUID REFERENCES projects(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_costs_company ON cost_entries(company_id);
CREATE INDEX idx_costs_agent ON cost_entries(agent_id);
CREATE INDEX idx_costs_issue ON cost_entries(issue_id);
CREATE INDEX idx_costs_project ON cost_entries(project_id);
CREATE INDEX idx_costs_created ON cost_entries(created_at);

-------------------------------------------------------------------------------
-- AUDIT LOG (append-only)
-------------------------------------------------------------------------------

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    actor_type      audit_actor_type NOT NULL,
    actor_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       UUID,
    -- Arbitrary details: old/new values, context, etc.
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No UPDATE or DELETE should ever run on this table (enforced in app layer)
CREATE INDEX idx_audit_company ON audit_log(company_id);
CREATE INDEX idx_audit_created ON audit_log(company_id, created_at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-------------------------------------------------------------------------------
-- KNOWLEDGE BASE DOCUMENTS
-------------------------------------------------------------------------------

CREATE TABLE kb_docs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    title                   TEXT NOT NULL,
    -- URL-safe slug for referencing: "coding-standards", "ux-guidelines"
    slug                    TEXT NOT NULL,
    content                 TEXT NOT NULL DEFAULT '',
    last_updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, slug)
);

CREATE INDEX idx_kb_docs_company ON kb_docs(company_id);

-------------------------------------------------------------------------------
-- LIVE CHAT SESSIONS
-------------------------------------------------------------------------------

CREATE TABLE live_chat_sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id    UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    -- Full transcript: [{ "author": "board|agent", "text": "...", "timestamp": "..." }, ...]
    transcript  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Agent-generated summary, stored after session ends
    summary     TEXT,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at    TIMESTAMPTZ
);

CREATE INDEX idx_live_chat_issue ON live_chat_sessions(issue_id);
CREATE INDEX idx_live_chat_agent ON live_chat_sessions(agent_id);

-------------------------------------------------------------------------------
-- CONNECTED PLATFORMS (OAuth connections via Hezo Connect)
-------------------------------------------------------------------------------

CREATE TABLE connected_platforms (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    platform                    platform_type NOT NULL,
    status                      connection_status NOT NULL DEFAULT 'active',
    -- FK references to secrets table for encrypted tokens
    access_token_secret_id      UUID REFERENCES secrets(id) ON DELETE SET NULL,
    refresh_token_secret_id     UUID REFERENCES secrets(id) ON DELETE SET NULL,
    -- OAuth scopes that were granted
    scopes                      TEXT NOT NULL DEFAULT '',
    -- Platform-specific metadata: { "username": "...", "email": "...", "account_id": "..." }
    metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    token_expires_at            TIMESTAMPTZ,
    connected_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One connection per platform per company
    UNIQUE (company_id, platform)
);

CREATE INDEX idx_connected_platforms_company ON connected_platforms(company_id);

-------------------------------------------------------------------------------
-- ISSUE ATTACHMENTS
-------------------------------------------------------------------------------

CREATE TABLE assets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL DEFAULT 'local_disk',
    object_key          TEXT NOT NULL,
    content_type        TEXT NOT NULL,
    byte_size           BIGINT NOT NULL,
    sha256              TEXT NOT NULL,
    original_filename   TEXT NOT NULL,
    uploaded_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_company ON assets(company_id);

CREATE TABLE issue_attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id    UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    asset_id    UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (issue_id, asset_id)
);

CREATE INDEX idx_issue_attachments_issue ON issue_attachments(issue_id);

-------------------------------------------------------------------------------
-- COMPANY PREFERENCES (board-observed working style preferences)
-------------------------------------------------------------------------------

CREATE TABLE company_preferences (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    content                 TEXT NOT NULL DEFAULT '',
    last_updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id)
);

-------------------------------------------------------------------------------
-- COMPANY PREFERENCE REVISIONS
-------------------------------------------------------------------------------

CREATE TABLE company_preference_revisions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    preference_id           UUID NOT NULL REFERENCES company_preferences(id) ON DELETE CASCADE,
    revision_number         INTEGER NOT NULL,
    content                 TEXT NOT NULL,
    change_summary          TEXT NOT NULL DEFAULT '',
    author_agent_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (preference_id, revision_number)
);

CREATE INDEX idx_company_pref_revisions_pref ON company_preference_revisions(preference_id);

-------------------------------------------------------------------------------
-- PROJECT DOCUMENTS
-------------------------------------------------------------------------------

CREATE TABLE project_docs (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id              UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    doc_type                project_doc_type NOT NULL,
    title                   TEXT NOT NULL,
    slug                    TEXT NOT NULL,
    content                 TEXT NOT NULL DEFAULT '',
    created_by_agent_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
    last_updated_by_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, slug)
);

-- Enforce one doc per type per project (except 'other' which allows multiples)
CREATE UNIQUE INDEX idx_project_docs_one_per_type
    ON project_docs(project_id, doc_type)
    WHERE doc_type != 'other';

CREATE INDEX idx_project_docs_project ON project_docs(project_id);
CREATE INDEX idx_project_docs_company ON project_docs(company_id);

-------------------------------------------------------------------------------
-- PROJECT DOCUMENT REVISIONS
-------------------------------------------------------------------------------

CREATE TABLE project_doc_revisions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id                  UUID NOT NULL REFERENCES project_docs(id) ON DELETE CASCADE,
    revision_number         INTEGER NOT NULL,
    content                 TEXT NOT NULL,
    change_summary          TEXT NOT NULL DEFAULT '',
    author_agent_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (doc_id, revision_number)
);

CREATE INDEX idx_project_doc_revisions_doc ON project_doc_revisions(doc_id);

-------------------------------------------------------------------------------
-- KB DOCUMENT REVISIONS
-------------------------------------------------------------------------------

CREATE TABLE kb_doc_revisions (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id                  UUID NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
    revision_number         INTEGER NOT NULL,
    content                 TEXT NOT NULL,
    change_summary          TEXT NOT NULL DEFAULT '',
    author_agent_id         UUID REFERENCES agents(id) ON DELETE SET NULL,
    author_user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (doc_id, revision_number)
);

CREATE INDEX idx_kb_revisions_doc ON kb_doc_revisions(doc_id);

-------------------------------------------------------------------------------
-- AGENT WAKEUP REQUESTS
-------------------------------------------------------------------------------

CREATE TABLE agent_wakeup_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source          wakeup_source NOT NULL,
    status          wakeup_status NOT NULL DEFAULT 'queued',
    idempotency_key TEXT,
    coalesced_count INTEGER NOT NULL DEFAULT 0,
    -- Context for the wakeup: issue ID, comment ID, etc.
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_wakeups_agent ON agent_wakeup_requests(agent_id);
CREATE INDEX idx_wakeups_status ON agent_wakeup_requests(status);
CREATE INDEX idx_wakeups_idempotency ON agent_wakeup_requests(idempotency_key);

-------------------------------------------------------------------------------
-- HEARTBEAT RUNS
-------------------------------------------------------------------------------

CREATE TABLE heartbeat_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    wakeup_id       UUID REFERENCES agent_wakeup_requests(id) ON DELETE SET NULL,
    status          heartbeat_run_status NOT NULL DEFAULT 'queued',
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    exit_code       INTEGER,
    error           TEXT,
    -- Token usage and cost
    input_tokens    BIGINT NOT NULL DEFAULT 0,
    output_tokens   BIGINT NOT NULL DEFAULT 0,
    cost_cents      INTEGER NOT NULL DEFAULT 0,
    -- Log references
    stdout_excerpt  TEXT,
    stderr_excerpt  TEXT,
    process_pid     INTEGER,
    -- Retry tracking for orphan recovery
    retry_of_run_id         UUID REFERENCES heartbeat_runs(id),
    process_loss_retry_count INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_runs_agent ON heartbeat_runs(agent_id);
CREATE INDEX idx_runs_status ON heartbeat_runs(status);
CREATE INDEX idx_runs_company ON heartbeat_runs(company_id);

-------------------------------------------------------------------------------
-- AGENT TASK SESSIONS (session compaction)
-------------------------------------------------------------------------------

CREATE TABLE agent_task_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_key         TEXT NOT NULL,
    -- Serialized session state (adapter-specific)
    session_params  JSONB NOT NULL DEFAULT '{}'::jsonb,
    session_display_id TEXT,
    run_count       INTEGER NOT NULL DEFAULT 0,
    total_input_tokens BIGINT NOT NULL DEFAULT 0,
    last_run_id     UUID REFERENCES heartbeat_runs(id),
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (agent_id, task_key)
);

CREATE INDEX idx_task_sessions_agent ON agent_task_sessions(agent_id);

-------------------------------------------------------------------------------
-- PLUGINS
-------------------------------------------------------------------------------

CREATE TABLE plugins (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plugin_key      TEXT NOT NULL,
    name            TEXT NOT NULL,
    version         TEXT NOT NULL,
    manifest        JSONB NOT NULL,
    status          plugin_status NOT NULL DEFAULT 'installed',
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    installed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, plugin_key)
);

CREATE INDEX idx_plugins_company ON plugins(company_id);

CREATE TABLE plugin_state (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id   UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    namespace   TEXT NOT NULL DEFAULT '',
    state_key   TEXT NOT NULL,
    state_value JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (plugin_id, company_id, namespace, state_key)
);

CREATE INDEX idx_plugin_state_plugin ON plugin_state(plugin_id);

CREATE TABLE plugin_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id   UUID NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    job_key     TEXT NOT NULL,
    schedule    TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    next_run_at TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (plugin_id, job_key)
);

CREATE INDEX idx_plugin_jobs_plugin ON plugin_jobs(plugin_id);
CREATE INDEX idx_plugin_jobs_next_run ON plugin_jobs(next_run_at);

-------------------------------------------------------------------------------
-- INSTANCE USER ROLES (server-level admin)
-------------------------------------------------------------------------------

CREATE TABLE instance_user_roles (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL DEFAULT 'instance_admin',

    UNIQUE (user_id, role)
);

-------------------------------------------------------------------------------
-- TRIGGERS: auto-update updated_at
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_companies_updated BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_agents_updated BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_issues_updated BEFORE UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_secrets_updated BEFORE UPDATE ON secrets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_kb_docs_updated BEFORE UPDATE ON kb_docs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_company_prefs_updated BEFORE UPDATE ON company_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_project_docs_updated BEFORE UPDATE ON project_docs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_connected_platforms_updated BEFORE UPDATE ON connected_platforms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_sessions_updated BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_task_sessions_updated BEFORE UPDATE ON agent_task_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_plugins_updated BEFORE UPDATE ON plugins
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_plugin_state_updated BEFORE UPDATE ON plugin_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-------------------------------------------------------------------------------
-- FUNCTION: atomic issue number assignment
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_issue_number(p_company_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_number INTEGER;
BEGIN
    INSERT INTO company_issue_counters (company_id, next_number)
    VALUES (p_company_id, 2)
    ON CONFLICT (company_id)
    DO UPDATE SET next_number = company_issue_counters.next_number + 1
    RETURNING next_number - 1 INTO v_number;
    
    RETURN v_number;
END;
$$ LANGUAGE plpgsql;

-------------------------------------------------------------------------------
-- FUNCTION: atomic budget check + debit
-- Returns TRUE if debit succeeded, FALSE if over budget
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION debit_agent_budget(
    p_agent_id UUID,
    p_amount_cents INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
    v_agent_budget INTEGER;
    v_agent_used INTEGER;
    v_company_id UUID;
    v_company_budget INTEGER;
    v_company_used INTEGER;
BEGIN
    -- Lock and check agent budget
    SELECT monthly_budget_cents, budget_used_cents, company_id
    INTO v_agent_budget, v_agent_used, v_company_id
    FROM agents
    WHERE id = p_agent_id
    FOR UPDATE;

    IF (v_agent_used + p_amount_cents) > v_agent_budget THEN
        RETURN FALSE;
    END IF;

    -- Lock and check company budget
    SELECT budget_monthly_cents, budget_used_cents
    INTO v_company_budget, v_company_used
    FROM companies
    WHERE id = v_company_id
    FOR UPDATE;

    IF (v_company_used + p_amount_cents) > v_company_budget THEN
        RETURN FALSE;
    END IF;

    -- Debit both
    UPDATE agents
    SET budget_used_cents = budget_used_cents + p_amount_cents
    WHERE id = p_agent_id;

    UPDATE companies
    SET budget_used_cents = budget_used_cents + p_amount_cents
    WHERE id = v_company_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
