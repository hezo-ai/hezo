-- Initial schema for the company orchestration platform

CREATE EXTENSION IF NOT EXISTS vector;

-------------------------------------------------------------------------------
-- SYSTEM META
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS system_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-------------------------------------------------------------------------------
-- USERS & AUTH
-------------------------------------------------------------------------------

CREATE TABLE users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url   TEXT,
    is_superuser BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_auth_methods (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    provider_user_id  TEXT NOT NULL,
    provider_metadata JSONB NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id)
);

CREATE INDEX idx_auth_methods_user ON user_auth_methods(user_id);

-------------------------------------------------------------------------------
-- ENUMS
-------------------------------------------------------------------------------

CREATE TYPE member_type AS ENUM ('agent', 'user');
CREATE TYPE agent_runtime AS ENUM ('claude_code', 'codex', 'gemini');
CREATE TYPE agent_effort AS ENUM ('minimal', 'low', 'medium', 'high', 'max');
CREATE TYPE agent_runtime_status AS ENUM ('active', 'idle', 'paused');
CREATE TYPE agent_admin_status AS ENUM ('enabled', 'disabled');
CREATE TYPE container_status AS ENUM ('creating', 'running', 'stopping', 'stopped', 'error');
CREATE TYPE issue_status AS ENUM ('backlog', 'in_progress', 'review', 'approved', 'blocked', 'done', 'closed', 'cancelled');
CREATE TYPE issue_priority AS ENUM ('urgent', 'high', 'medium', 'low');
CREATE TYPE comment_content_type AS ENUM ('text', 'options', 'preview', 'trace', 'system', 'run', 'action', 'credential_request');
CREATE TYPE tool_call_status AS ENUM ('running', 'success', 'error');
CREATE TYPE secret_category AS ENUM ('ssh_key', 'credential', 'api_token', 'certificate', 'other');
CREATE TYPE grant_scope AS ENUM ('single', 'project', 'company');
CREATE TYPE approval_type AS ENUM ('secret_access', 'hire', 'strategy', 'kb_update', 'plan_review', 'deploy_production', 'oauth_request', 'skill_proposal');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'denied');
CREATE TYPE audit_actor_type AS ENUM ('board', 'agent', 'system');
CREATE TYPE repo_host_type AS ENUM ('github');
CREATE TYPE platform_type AS ENUM ('github', 'gmail', 'gitlab', 'stripe', 'posthog', 'railway', 'vercel', 'digitalocean', 'x', 'anthropic', 'openai', 'google');
CREATE TYPE connection_status AS ENUM ('active', 'expired', 'disconnected');
CREATE TYPE wakeup_source AS ENUM ('timer', 'assignment', 'on_demand', 'mention', 'automation', 'option_chosen', 'credential_provided', 'comment', 'reply', 'heartbeat');
CREATE TYPE wakeup_status AS ENUM ('queued', 'claimed', 'completed', 'failed', 'skipped', 'coalesced', 'deferred', 'cancelled');
CREATE TYPE heartbeat_run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out');
CREATE TYPE plugin_status AS ENUM ('installed', 'enabled', 'disabled', 'error');
CREATE TYPE membership_role AS ENUM ('board', 'member');
CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE agent_type_source AS ENUM ('builtin', 'custom', 'remote');
CREATE TYPE company_type_source AS ENUM ('builtin', 'custom', 'marketplace');
CREATE TYPE goal_status AS ENUM ('active', 'achieved', 'archived');
CREATE TYPE ai_provider AS ENUM ('anthropic', 'openai', 'google', 'deepseek');
CREATE TYPE ai_auth_method AS ENUM ('api_key', 'subscription');

-------------------------------------------------------------------------------
-- AGENT TYPES
-------------------------------------------------------------------------------

CREATE TABLE agent_types (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                   TEXT NOT NULL,
    slug                   TEXT NOT NULL UNIQUE,
    description            TEXT NOT NULL DEFAULT '',
    role_description       TEXT NOT NULL DEFAULT '',
    default_summary        TEXT NOT NULL DEFAULT '',
    system_prompt_template TEXT NOT NULL DEFAULT '',
    default_effort         agent_effort NOT NULL DEFAULT 'medium',
    heartbeat_interval_min INTEGER NOT NULL DEFAULT 60,
    monthly_budget_cents   INTEGER NOT NULL DEFAULT 3000,
    touches_code           BOOLEAN NOT NULL DEFAULT false,
    is_builtin             BOOLEAN NOT NULL DEFAULT false,
    source                 agent_type_source NOT NULL DEFAULT 'custom',
    source_url             TEXT,
    source_version         TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- COMPANY TYPES
-------------------------------------------------------------------------------

CREATE TABLE company_types (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT NOT NULL UNIQUE,
    description           TEXT NOT NULL DEFAULT '',
    default_team_summary  TEXT NOT NULL DEFAULT '',
    is_builtin            BOOLEAN NOT NULL DEFAULT false,
    source              company_type_source NOT NULL DEFAULT 'custom',
    source_url          TEXT,
    source_version      TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    kb_docs_config      JSONB NOT NULL DEFAULT '[]'::jsonb,
    skills_config       JSONB NOT NULL DEFAULT '[]'::jsonb,
    preferences_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
    mcp_servers         JSONB NOT NULL DEFAULT '[]'::jsonb,
    mpp_config          JSONB NOT NULL DEFAULT '{"enabled": false}'::jsonb,
    builtin_agent_prompts JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- COMPANY TYPE ↔ AGENT TYPE (join table)
-------------------------------------------------------------------------------

CREATE TABLE company_type_agent_types (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_type_id             UUID NOT NULL REFERENCES company_types(id) ON DELETE CASCADE,
    agent_type_id               UUID NOT NULL REFERENCES agent_types(id) ON DELETE CASCADE,
    reports_to_slug             TEXT,
    heartbeat_interval_override INTEGER,
    monthly_budget_override     INTEGER,
    sort_order                  INTEGER NOT NULL DEFAULT 0,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_type_id, agent_type_id)
);

CREATE INDEX idx_ctat_company_type ON company_type_agent_types(company_type_id);
CREATE INDEX idx_ctat_agent_type ON company_type_agent_types(agent_type_id);

-------------------------------------------------------------------------------
-- COMPANIES
-------------------------------------------------------------------------------

CREATE TABLE companies (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 TEXT NOT NULL,
    slug                 TEXT NOT NULL UNIQUE,
    description          TEXT NOT NULL DEFAULT '',
    team_summary         TEXT NOT NULL DEFAULT '',
    budget_monthly_cents INTEGER NOT NULL DEFAULT 50000,
    budget_used_cents    INTEGER NOT NULL DEFAULT 0,
    budget_reset_at      TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    mcp_servers          JSONB NOT NULL DEFAULT '[]'::jsonb,
    mpp_config           JSONB NOT NULL DEFAULT '{"enabled": false}'::jsonb,
    settings             JSONB NOT NULL DEFAULT '{"wake_mentioner_on_reply": true}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-------------------------------------------------------------------------------
-- COMPANY ↔ TEAM TYPES (many-to-many)
-------------------------------------------------------------------------------

CREATE TABLE company_team_types (
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    company_type_id UUID NOT NULL REFERENCES company_types(id) ON DELETE CASCADE,
    PRIMARY KEY (company_id, company_type_id)
);

-------------------------------------------------------------------------------
-- MEMBERS (unified base for agents and users within a company)
-------------------------------------------------------------------------------

CREATE TABLE members (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    member_type  member_type NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_members_company ON members(company_id);
CREATE INDEX idx_members_type ON members(company_id, member_type);

-------------------------------------------------------------------------------
-- MEMBER AGENTS
-------------------------------------------------------------------------------

CREATE TABLE member_agents (
    id                      UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    agent_type_id           UUID REFERENCES agent_types(id) ON DELETE SET NULL,
    reports_to              UUID REFERENCES members(id) ON DELETE SET NULL,
    title                   TEXT NOT NULL,
    slug                    TEXT NOT NULL,
    role_description        TEXT NOT NULL DEFAULT '',
    summary                 TEXT NOT NULL DEFAULT '',
    default_effort          agent_effort NOT NULL DEFAULT 'medium',
    heartbeat_interval_min  INTEGER NOT NULL DEFAULT 60,
    monthly_budget_cents    INTEGER NOT NULL DEFAULT 3000,
    touches_code            BOOLEAN NOT NULL DEFAULT false,
    budget_used_cents       INTEGER NOT NULL DEFAULT 0,
    budget_reset_at         TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
    runtime_status          agent_runtime_status NOT NULL DEFAULT 'idle',
    admin_status            agent_admin_status NOT NULL DEFAULT 'enabled',
    mcp_servers             JSONB NOT NULL DEFAULT '[]'::jsonb,
    model_override_provider ai_provider,
    model_override_model    TEXT,
    last_heartbeat_at       TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, slug),
    CONSTRAINT model_override_requires_provider
        CHECK (model_override_model IS NULL OR model_override_provider IS NOT NULL)
);

-- Slug uniqueness within a company enforced at the app layer
-- (requires joining members to get company_id)

-------------------------------------------------------------------------------
-- MEMBER USERS
-------------------------------------------------------------------------------

CREATE TABLE member_users (
    id               UUID PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role             membership_role NOT NULL DEFAULT 'member',
    role_title       TEXT,
    permissions_text TEXT NOT NULL DEFAULT '',
    project_ids      JSONB,
    settings         JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_member_users_user ON member_users(user_id);

-------------------------------------------------------------------------------
-- INVITES
-------------------------------------------------------------------------------

CREATE TABLE invites (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email            TEXT NOT NULL,
    code             TEXT NOT NULL UNIQUE,
    status           invite_status NOT NULL DEFAULT 'pending',
    role             membership_role NOT NULL DEFAULT 'member',
    role_title       TEXT,
    permissions_text TEXT NOT NULL DEFAULT '',
    project_ids      JSONB,
    invited_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    accepted_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invites_company ON invites(company_id);
CREATE INDEX idx_invites_code ON invites(code);

-------------------------------------------------------------------------------
-- API KEYS
-------------------------------------------------------------------------------

CREATE TABLE api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    key_hash     TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_company ON api_keys(company_id);

-------------------------------------------------------------------------------
-- PROJECTS
-------------------------------------------------------------------------------

CREATE TABLE projects (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    slug                TEXT NOT NULL,
    issue_prefix        TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    is_internal         BOOLEAN NOT NULL DEFAULT false,
    docker_base_image   TEXT NOT NULL DEFAULT 'hezo/agent-base:latest',
    container_id        TEXT,
    container_status    container_status,
    container_error     TEXT,
    container_last_logs TEXT,
    designated_repo_id  UUID,
    dev_ports           JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_company ON projects(company_id);
CREATE UNIQUE INDEX idx_projects_company_slug ON projects(company_id, slug);
CREATE UNIQUE INDEX idx_projects_company_issue_prefix ON projects(company_id, issue_prefix);

-------------------------------------------------------------------------------
-- REPOS
-------------------------------------------------------------------------------

CREATE TABLE repos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    short_name      TEXT NOT NULL,
    repo_identifier TEXT NOT NULL,
    host_type       repo_host_type NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, short_name)
);

CREATE INDEX idx_repos_project ON repos(project_id);

-- Deferred FK: projects.designated_repo_id → repos(id) (repos defined after projects)
-- RESTRICT: the designated repo cannot be deleted directly; project cascade still
-- cleans it up because repos is deleted first when the project row is removed.
ALTER TABLE projects ADD CONSTRAINT fk_projects_designated_repo
    FOREIGN KEY (designated_repo_id) REFERENCES repos(id) ON DELETE RESTRICT;

-------------------------------------------------------------------------------
-- SECRETS
-------------------------------------------------------------------------------

CREATE TABLE secrets (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id       UUID REFERENCES projects(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    encrypted_value  TEXT NOT NULL,
    category         secret_category NOT NULL DEFAULT 'other',
    allowed_hosts    TEXT[] NOT NULL DEFAULT '{}',
    allow_all_hosts  BOOLEAN NOT NULL DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, project_id, name)
);

CREATE INDEX idx_secrets_company ON secrets(company_id);
CREATE INDEX idx_secrets_project ON secrets(project_id);

-------------------------------------------------------------------------------
-- MCP CONNECTIONS
-------------------------------------------------------------------------------

CREATE TYPE mcp_connection_kind AS ENUM ('saas', 'local');
CREATE TYPE mcp_install_status AS ENUM ('pending', 'installed', 'failed');

-- Catalog of MCP servers (SaaS or local stdio) made available to agents
-- across runs. Per-run agent runtime merges these into the spawned agent's
-- MCP descriptor list alongside the built-in `hezo` server.
--
-- `config` shape:
--   kind = 'saas':  { url: string, headers?: Record<string,string> }
--                   header values may contain __HEZO_SECRET_*__ placeholders
--                   that the egress proxy substitutes at request time.
--   kind = 'local': { command: string, args?: string[],
--                     env?: Record<string,string>, package?: string }
--                   `package` is the npm/pypi spec the installer uses to
--                   provision the server under /workspace/.hezo/mcp/<name>/.
CREATE TABLE mcp_connections (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES projects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            mcp_connection_kind NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    install_status  mcp_install_status NOT NULL DEFAULT 'pending',
    install_error   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, project_id, name)
);

CREATE INDEX idx_mcp_connections_company ON mcp_connections(company_id);
CREATE INDEX idx_mcp_connections_project ON mcp_connections(project_id);

-------------------------------------------------------------------------------
-- GOALS
-------------------------------------------------------------------------------

CREATE TABLE goals (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id           UUID REFERENCES projects(id) ON DELETE CASCADE,
    title                TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    status               goal_status NOT NULL DEFAULT 'active',
    created_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_goals_company ON goals(company_id);
CREATE INDEX idx_goals_project ON goals(project_id);
CREATE INDEX idx_goals_status  ON goals(status);

-------------------------------------------------------------------------------
-- COMPANY SSH KEYS
-------------------------------------------------------------------------------

CREATE TABLE company_ssh_keys (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    public_key            TEXT NOT NULL,
    fingerprint           TEXT,
    private_key_secret_id UUID REFERENCES secrets(id) ON DELETE SET NULL,
    github_key_id         INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id)
);

-------------------------------------------------------------------------------
-- ISSUES
-------------------------------------------------------------------------------

CREATE TABLE project_issue_counters (
    project_id  UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    next_number INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE issues (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    assignee_id          UUID REFERENCES members(id) ON DELETE SET NULL,
    parent_issue_id      UUID REFERENCES issues(id) ON DELETE SET NULL,
    created_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    created_by_run_id    UUID,
    number               INTEGER NOT NULL,
    identifier           TEXT NOT NULL,
    title                TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    status               issue_status NOT NULL DEFAULT 'backlog',
    priority             issue_priority NOT NULL DEFAULT 'medium',
    labels               JSONB NOT NULL DEFAULT '[]'::jsonb,
    progress_summary             TEXT,
    progress_summary_updated_at  TIMESTAMPTZ,
    progress_summary_updated_by  UUID REFERENCES members(id) ON DELETE SET NULL,
    rules                TEXT,
    branch_name          TEXT,
    runtime_type         agent_runtime,
    embedding            vector(384),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (project_id, number),
    UNIQUE (company_id, identifier)
);

CREATE INDEX idx_issues_company ON issues(company_id);
CREATE INDEX idx_issues_project ON issues(project_id);
CREATE INDEX idx_issues_assignee ON issues(assignee_id);
CREATE INDEX idx_issues_status ON issues(company_id, status);
CREATE INDEX idx_issues_parent ON issues(parent_issue_id);
CREATE INDEX idx_issues_identifier ON issues(company_id, identifier);
CREATE INDEX idx_issues_embedding ON issues USING hnsw (embedding vector_cosine_ops);

-------------------------------------------------------------------------------
-- ISSUE DEPENDENCIES
-------------------------------------------------------------------------------

CREATE TABLE issue_dependencies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id            UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    blocked_by_issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (issue_id, blocked_by_issue_id)
);

CREATE INDEX idx_issue_deps_issue ON issue_dependencies(issue_id);
CREATE INDEX idx_issue_deps_blocked ON issue_dependencies(blocked_by_issue_id);

-------------------------------------------------------------------------------
-- EXECUTION LOCKS
-------------------------------------------------------------------------------

CREATE TABLE execution_locks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id    UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    lock_type   TEXT NOT NULL DEFAULT 'write' CHECK (lock_type IN ('read', 'write')),
    locked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ
);

CREATE INDEX idx_exec_locks_issue ON execution_locks(issue_id);
CREATE INDEX idx_exec_locks_member ON execution_locks(member_id);

-------------------------------------------------------------------------------
-- ISSUE COMMENTS
-------------------------------------------------------------------------------

CREATE TABLE issue_comments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id         UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    content_type     comment_content_type NOT NULL DEFAULT 'text',
    content          JSONB NOT NULL,
    chosen_option    JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_issue ON issue_comments(issue_id);
CREATE INDEX idx_comments_author ON issue_comments(author_member_id);

-------------------------------------------------------------------------------
-- TOOL CALLS
-------------------------------------------------------------------------------

CREATE TABLE tool_calls (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comment_id  UUID NOT NULL REFERENCES issue_comments(id) ON DELETE CASCADE,
    member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    tool_name   TEXT NOT NULL,
    input       JSONB,
    output      JSONB,
    status      tool_call_status NOT NULL DEFAULT 'running',
    duration_ms INTEGER,
    cost_cents  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tool_calls_comment ON tool_calls(comment_id);
CREATE INDEX idx_tool_calls_member ON tool_calls(member_id);

-------------------------------------------------------------------------------
-- SECRET GRANTS
-------------------------------------------------------------------------------

CREATE TABLE secret_grants (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_id  UUID NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
    member_id  UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    scope      grant_scope NOT NULL DEFAULT 'single',
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,

    UNIQUE (secret_id, member_id)
);

CREATE INDEX idx_grants_member ON secret_grants(member_id);
CREATE INDEX idx_grants_secret ON secret_grants(secret_id);

-------------------------------------------------------------------------------
-- APPROVALS
-------------------------------------------------------------------------------

CREATE TABLE approvals (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id             UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type                   approval_type NOT NULL,
    status                 approval_status NOT NULL DEFAULT 'pending',
    requested_by_member_id UUID REFERENCES members(id) ON DELETE CASCADE,
    payload                JSONB NOT NULL,
    resolved_at            TIMESTAMPTZ,
    resolution_note        TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approvals_company ON approvals(company_id);
CREATE INDEX idx_approvals_status ON approvals(company_id, status);

-- One pending designated-repo setup approval per project: allows concurrent
-- agent runs on the same project to share a single approval while still posting
-- their own action comments on their respective issues.
CREATE UNIQUE INDEX idx_one_pending_repo_setup
    ON approvals (company_id, (payload->>'project_id'))
    WHERE type = 'oauth_request'
      AND status = 'pending'
      AND payload->>'reason' = 'designated_repo';

-------------------------------------------------------------------------------
-- COST ENTRIES
-------------------------------------------------------------------------------

CREATE TABLE cost_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    member_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    issue_id     UUID REFERENCES issues(id) ON DELETE SET NULL,
    project_id   UUID REFERENCES projects(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_costs_company ON cost_entries(company_id);
CREATE INDEX idx_costs_member ON cost_entries(member_id);
CREATE INDEX idx_costs_issue ON cost_entries(issue_id);
CREATE INDEX idx_costs_project ON cost_entries(project_id);
CREATE INDEX idx_costs_created ON cost_entries(created_at);

-------------------------------------------------------------------------------
-- AUDIT LOG
-------------------------------------------------------------------------------

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    actor_type      audit_actor_type NOT NULL,
    actor_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       UUID,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_company ON audit_log(company_id);
CREATE INDEX idx_audit_created ON audit_log(company_id, created_at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-------------------------------------------------------------------------------
-- DOCUMENTS (unified: project docs, knowledge base, company preferences)
-------------------------------------------------------------------------------

CREATE TYPE document_type AS ENUM ('project_doc', 'kb_doc', 'company_preferences', 'agent_system_prompt');

CREATE TABLE documents (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    project_id                UUID REFERENCES projects(id) ON DELETE CASCADE,
    member_agent_id           UUID REFERENCES member_agents(id) ON DELETE CASCADE,
    type                      document_type NOT NULL,
    slug                      TEXT NOT NULL,
    title                     TEXT NOT NULL DEFAULT '',
    content                   TEXT NOT NULL DEFAULT '',
    last_updated_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    embedding                 vector(384),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT documents_agent_system_prompt_requires_member_agent
        CHECK (type <> 'agent_system_prompt' OR member_agent_id IS NOT NULL)
);

CREATE UNIQUE INDEX idx_documents_project_doc
    ON documents (project_id, slug)
    WHERE type = 'project_doc';
CREATE UNIQUE INDEX idx_documents_kb_doc
    ON documents (company_id, slug)
    WHERE type = 'kb_doc';
CREATE UNIQUE INDEX idx_documents_company_preferences
    ON documents (company_id)
    WHERE type = 'company_preferences';
CREATE UNIQUE INDEX idx_documents_agent_system_prompt
    ON documents (member_agent_id)
    WHERE type = 'agent_system_prompt';

CREATE INDEX idx_documents_company ON documents (company_id);
CREATE INDEX idx_documents_type_company ON documents (type, company_id);
CREATE INDEX idx_documents_project ON documents (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_documents_member_agent ON documents (member_agent_id) WHERE member_agent_id IS NOT NULL;
CREATE INDEX idx_documents_embedding ON documents USING hnsw (embedding vector_cosine_ops);

CREATE TABLE document_revisions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id      UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision_number  INTEGER NOT NULL,
    content          TEXT NOT NULL,
    change_summary   TEXT NOT NULL DEFAULT '',
    author_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (document_id, revision_number)
);

CREATE INDEX idx_document_revisions_document ON document_revisions(document_id);

-------------------------------------------------------------------------------
-- CONNECTED PLATFORMS
-------------------------------------------------------------------------------

CREATE TABLE connected_platforms (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    platform                platform_type NOT NULL,
    status                  connection_status NOT NULL DEFAULT 'active',
    access_token_secret_id  UUID REFERENCES secrets(id) ON DELETE SET NULL,
    refresh_token_secret_id UUID REFERENCES secrets(id) ON DELETE SET NULL,
    scopes                  TEXT NOT NULL DEFAULT '',
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    token_expires_at        TIMESTAMPTZ,
    connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (company_id, platform)
);

CREATE INDEX idx_connected_platforms_company ON connected_platforms(company_id);

-------------------------------------------------------------------------------
-- AI PROVIDER CONFIGS
-------------------------------------------------------------------------------

CREATE TABLE ai_provider_configs (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider             ai_provider NOT NULL,
    auth_method          ai_auth_method NOT NULL DEFAULT 'api_key',
    label                TEXT NOT NULL,
    encrypted_credential TEXT NOT NULL,
    is_default           BOOLEAN NOT NULL DEFAULT false,
    status               TEXT NOT NULL DEFAULT 'active',
    default_model        TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (provider, label)
);

CREATE UNIQUE INDEX ai_provider_configs_default_per_provider
    ON ai_provider_configs(provider) WHERE is_default;

-------------------------------------------------------------------------------
-- ASSETS & ATTACHMENTS
-------------------------------------------------------------------------------

CREATE TABLE assets (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provider              TEXT NOT NULL DEFAULT 'local_disk',
    object_key            TEXT NOT NULL,
    content_type          TEXT NOT NULL,
    byte_size             BIGINT NOT NULL,
    sha256                TEXT NOT NULL,
    original_filename     TEXT NOT NULL,
    uploaded_by_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_company ON assets(company_id);

CREATE TABLE issue_attachments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id   UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    asset_id   UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (issue_id, asset_id)
);

CREATE INDEX idx_issue_attachments_issue ON issue_attachments(issue_id);

-------------------------------------------------------------------------------
-- SKILLS
-------------------------------------------------------------------------------

CREATE TABLE skills (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    slug                  TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    content               TEXT NOT NULL DEFAULT '',
    source_url            TEXT,
    content_hash          TEXT NOT NULL DEFAULT '',
    created_by_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    tags                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_active             BOOLEAN NOT NULL DEFAULT true,
    embedding             vector(384),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(company_id, slug)
);

CREATE INDEX idx_skills_company ON skills(company_id);
CREATE INDEX idx_skills_embedding ON skills USING hnsw (embedding vector_cosine_ops);

-------------------------------------------------------------------------------
-- SKILL REVISIONS
-------------------------------------------------------------------------------

CREATE TABLE skill_revisions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    skill_id          UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    revision_number   INTEGER NOT NULL,
    content           TEXT NOT NULL,
    content_hash      TEXT NOT NULL DEFAULT '',
    change_summary    TEXT NOT NULL DEFAULT '',
    author_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (skill_id, revision_number)
);

CREATE INDEX idx_skill_revisions_skill ON skill_revisions(skill_id);

-------------------------------------------------------------------------------
-- AGENT WAKEUP REQUESTS
-------------------------------------------------------------------------------

CREATE TABLE agent_wakeup_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source          wakeup_source NOT NULL,
    status          wakeup_status NOT NULL DEFAULT 'queued',
    idempotency_key TEXT,
    coalesced_count INTEGER NOT NULL DEFAULT 0,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_wakeups_member ON agent_wakeup_requests(member_id);
CREATE INDEX idx_wakeups_status ON agent_wakeup_requests(status);
CREATE INDEX idx_wakeups_idempotency ON agent_wakeup_requests(idempotency_key);

-------------------------------------------------------------------------------
-- HEARTBEAT RUNS
-------------------------------------------------------------------------------

CREATE TABLE heartbeat_runs (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id               UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    member_id                UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    wakeup_id                UUID REFERENCES agent_wakeup_requests(id) ON DELETE SET NULL,
    issue_id                 UUID REFERENCES issues(id) ON DELETE SET NULL,
    status                   heartbeat_run_status NOT NULL DEFAULT 'queued',
    started_at               TIMESTAMPTZ,
    finished_at              TIMESTAMPTZ,
    exit_code                INTEGER,
    error                    TEXT,
    input_tokens             BIGINT NOT NULL DEFAULT 0,
    output_tokens            BIGINT NOT NULL DEFAULT 0,
    cost_cents               INTEGER NOT NULL DEFAULT 0,
    invocation_command       TEXT,
    log_text                 TEXT NOT NULL DEFAULT '',
    working_dir              TEXT,
    process_pid              INTEGER,
    retry_of_run_id          UUID REFERENCES heartbeat_runs(id),
    process_loss_retry_count INTEGER NOT NULL DEFAULT 0,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_runs_member ON heartbeat_runs(member_id);
CREATE INDEX idx_runs_status ON heartbeat_runs(status);
CREATE INDEX idx_runs_company ON heartbeat_runs(company_id);
CREATE INDEX idx_runs_issue ON heartbeat_runs(issue_id);

ALTER TABLE issues
    ADD CONSTRAINT issues_created_by_run_fk
    FOREIGN KEY (created_by_run_id) REFERENCES heartbeat_runs(id) ON DELETE SET NULL;

CREATE INDEX idx_issues_created_by_run ON issues(created_by_run_id) WHERE created_by_run_id IS NOT NULL;

-------------------------------------------------------------------------------
-- AGENT TASK SESSIONS
-------------------------------------------------------------------------------

CREATE TABLE agent_task_sessions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    member_id          UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    task_key           TEXT NOT NULL,
    session_params     JSONB NOT NULL DEFAULT '{}'::jsonb,
    session_display_id TEXT,
    run_count          INTEGER NOT NULL DEFAULT 0,
    total_input_tokens BIGINT NOT NULL DEFAULT 0,
    last_run_id        UUID REFERENCES heartbeat_runs(id),
    last_error         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (member_id, task_key)
);

CREATE INDEX idx_task_sessions_member ON agent_task_sessions(member_id);

-------------------------------------------------------------------------------
-- PLUGINS
-------------------------------------------------------------------------------

CREATE TABLE plugins (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plugin_key   TEXT NOT NULL,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    manifest     JSONB NOT NULL,
    status       plugin_status NOT NULL DEFAULT 'installed',
    config       JSONB NOT NULL DEFAULT '{}'::jsonb,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

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
-- INSTANCE USER ROLES
-------------------------------------------------------------------------------

CREATE TABLE instance_user_roles (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL DEFAULT 'instance_admin',

    UNIQUE (user_id, role)
);

-------------------------------------------------------------------------------
-- NOTIFICATION PREFERENCES
-------------------------------------------------------------------------------

CREATE TABLE notification_preferences (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel          TEXT NOT NULL,
    enabled          BOOLEAN NOT NULL DEFAULT true,
    event_types      JSONB NOT NULL DEFAULT '[]'::jsonb,
    telegram_chat_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, channel)
);

-------------------------------------------------------------------------------
-- SLACK CONNECTIONS
-------------------------------------------------------------------------------

CREATE TABLE slack_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    bot_token_secret_id UUID NOT NULL REFERENCES secrets(id),
    team_id             TEXT NOT NULL,
    team_name           TEXT NOT NULL,
    installed_by        UUID NOT NULL REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id)
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

CREATE TRIGGER trg_agent_types_updated BEFORE UPDATE ON agent_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_company_types_updated BEFORE UPDATE ON company_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_companies_updated BEFORE UPDATE ON companies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_member_agents_updated BEFORE UPDATE ON member_agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_member_users_updated BEFORE UPDATE ON member_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_issues_updated BEFORE UPDATE ON issues
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_secrets_updated BEFORE UPDATE ON secrets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_mcp_connections_updated BEFORE UPDATE ON mcp_connections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_documents_updated BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_connected_platforms_updated BEFORE UPDATE ON connected_platforms
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_task_sessions_updated BEFORE UPDATE ON agent_task_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_plugins_updated BEFORE UPDATE ON plugins
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_plugin_state_updated BEFORE UPDATE ON plugin_state
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_notification_prefs_updated BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-------------------------------------------------------------------------------
-- FUNCTIONS
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION next_project_issue_number(p_project_id UUID)
RETURNS INTEGER AS $$
DECLARE
    v_number INTEGER;
BEGIN
    INSERT INTO project_issue_counters (project_id, next_number)
    VALUES (p_project_id, 2)
    ON CONFLICT (project_id)
    DO UPDATE SET next_number = project_issue_counters.next_number + 1
    RETURNING next_number - 1 INTO v_number;

    RETURN v_number;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION debit_agent_budget(
    p_member_id UUID,
    p_amount_cents INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
    v_agent_budget INTEGER;
    v_agent_used INTEGER;
    v_company_id UUID;
    v_company_budget INTEGER;
    v_company_used INTEGER;
BEGIN
    SELECT ma.monthly_budget_cents, ma.budget_used_cents, m.company_id
    INTO v_agent_budget, v_agent_used, v_company_id
    FROM member_agents ma
    JOIN members m ON m.id = ma.id
    WHERE ma.id = p_member_id
    FOR UPDATE OF ma;

    IF (v_agent_used + p_amount_cents) > v_agent_budget THEN
        RETURN FALSE;
    END IF;

    SELECT budget_monthly_cents, budget_used_cents
    INTO v_company_budget, v_company_used
    FROM companies
    WHERE id = v_company_id
    FOR UPDATE;

    IF (v_company_used + p_amount_cents) > v_company_budget THEN
        RETURN FALSE;
    END IF;

    UPDATE member_agents
    SET budget_used_cents = budget_used_cents + p_amount_cents
    WHERE id = p_member_id;

    UPDATE companies
    SET budget_used_cents = budget_used_cents + p_amount_cents
    WHERE id = v_company_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
