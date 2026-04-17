# API Design

Base URL: `http://localhost:3100/api`

All responses follow:
```json
{ "data": <payload> }           // success
{ "error": { "code": "...", "message": "..." } }  // error
```

Timestamps are ISO 8601. IDs are UUIDs. Money is in cents.

---

## Authentication

Three auth methods:

### Bootstrap — Master Key Exchange

`POST /auth/token` exchanges the master key for a board JWT. This is the bootstrap endpoint for initial access.

Request:
```json
{ "master_key": "..." }
```

Response:
```json
{ "data": { "token": "<user_jwt>" } }
```

### Board — User JWT

All subsequent requests use a stateless JWT signed with the master key. No session cookies.

```
Authorization: Bearer <user_jwt>
```

### Board — API key (remote orchestrators)
For external orchestrators (OpenClaw, scripts, AI agents controlling Hezo
remotely). Company-scoped. Full board-level access to that company.

```
Authorization: Bearer hezo_<key>
```

The `hezo_` prefix distinguishes board API keys from agent JWTs.
Keys are stored hashed (bcrypt). Shown once at creation, never again.

### Agent — JWT
Per-run bearer token minted each time an agent run starts. The token is bound to
the specific `heartbeat_runs` row for that run and is accepted only while the run
is still executing.

```
Authorization: Bearer <agent_jwt>
```

Agent tokens are JWTs signed with the master key (held in memory, never on disk),
containing:
```json
{ "member_id": "...", "company_id": "...", "run_id": "...", "iat": ..., "exp": ... }
```

`member_id` is the agent's ID in the members table (same as agent_id). `run_id`
is the `heartbeat_runs.id` for the run the token was issued for. `exp` is set to
four hours after issuance.

Validation on every request:
1. JWT signature verifies against the master key.
2. `heartbeat_runs` has a row with `id = run_id`, `member_id` matching, `company_id` matching.
3. That row's status is `running`.

Any failure returns `401`. When the run finalizes (status moves to `succeeded`,
`failed`, `cancelled`, or `timed_out`), the token is immediately rejected on the
next call — revocation happens for free via the status check, without a separate
token store.

---

## Board API (Web UI)

### Permission enforcement

All Board API endpoints check the caller's membership role:

| Access Level | Endpoints |
|-------------|-----------|
| **Board-only** (member_users with role='board') | Company settings, agent management (hire/fire/pause/resume/terminate), budget adjustments, secrets vault, API keys, connected platforms, audit log, plugin management, invites, member management |
| **All members** (agents and users, scoped by `project_ids`) | Issues, comments, live chat, KB (read), project docs (file-based, read/write), inbox (filtered), notification preferences |

Members (both agents and users) with role='member' are restricted by `project_ids` — they can only access issues, comments, and documents within their allowed projects. Requests outside their scope return 403.

### Companies

#### `GET /companies`
List all companies.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "NoteGenius AI",
      "description": "Build the #1 AI note-taking app",
      "agent_count": 6,
      "open_issue_count": 14,
      "total_budget_cents": 24000,
      "total_used_cents": 12700,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `POST /companies`
Create a company. Optionally seed from a template.

Request:
```json
{
  "name": "NoteGenius AI",
  "description": "Build the #1 AI note-taking app",
  "template_id": "uuid",
  "issue_prefix": "NOTE"
}
```

`template_id` is optional. When set, agents are provisioned from the selected template with their configurations (titles, prompts, org chart, runtimes, budgets). `issue_prefix` is optional and defaults to an auto-generated prefix from the company name.

Response: full company object. On creation, the server automatically:

1. Creates `~/.hezo/companies/{slug}/` folder structure with auto-generated AGENTS.md.
2. Creates agent team from the selected template. The UI defaults to "Software Development" pre-selected.
3. Creates an **"Operations" project** and auto-provisions its container.

Docker container provisioning for the Operations project happens at company creation. Other project containers are provisioned when those projects are created.

The board lands on a company with 11 agents.

#### `GET /companies/:companyId`
Get company detail.

Response: full company object with summary stats (same shape as list item).

#### `PATCH /companies/:companyId`
Update company config.

Request:
```json
{
  "name": "NoteGenius AI",
  "description": "Updated description",
  "settings": { "coach_auto_apply": true },
  "mcp_servers": [
    { "name": "slack", "url": "https://mcp.slack.com/sse", "description": "Team Slack" }
  ],
  "mpp_config": {
    "wallet_address": "0x...",
    "wallet_key_secret_name": "MPP_WALLET_KEY",
    "default_currency": "USD",
    "enabled": true
  }
}
```

`mcp_servers` — company-level MCP servers shared by all agents. Merged with
agent-level servers at runtime.

`mpp_config` — MPP wallet configuration. The wallet private key is stored in
the secrets vault (referenced by name). When enabled, the company container has
`mppx` CLI and wallet credentials are injected into agent subprocesses so they can pay for HTTP 402
services autonomously. MPP costs are debited against the agent's budget.

#### `DELETE /companies/:companyId`
Delete company and all associated data. Tears down the company container.

---

### API Keys

#### `GET /companies/:companyId/api-keys`
List API keys for a company (metadata only — key values are never returned).

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "OpenClaw orchestrator",
      "prefix": "hezo_a3b8",
      "last_used_at": "...",
      "created_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/api-keys`
Generate a new API key. The raw key is returned **once** in this response and
never again.

Request:
```json
{
  "name": "OpenClaw orchestrator"
}
```

Response:
```json
{
  "data": {
    "id": "uuid",
    "name": "OpenClaw orchestrator",
    "key": "hezo_a3b8c9d4e5f6...full_key_here",
    "prefix": "hezo_a3b8",
    "created_at": "..."
  }
}
```

#### `DELETE /companies/:companyId/api-keys/:apiKeyId`
Revoke an API key. Immediate. Any request using this key will fail.

---

### Agent Types

#### `GET /agent-types`
List all agent types. Optional `?source=builtin,custom` filter.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "CEO",
      "slug": "ceo",
      "description": "...",
      "role_description": "...",
      "system_prompt_template": "You are the CEO of {{company_name}}...",
      "default_effort": "max",
      "heartbeat_interval_min": 120,
      "monthly_budget_cents": 2000,
      "is_builtin": true,
      "source": "builtin",
      "source_url": null,
      "source_version": null
    }
  ]
}
```

#### `POST /agent-types`
Create a custom agent type.

Request:
```json
{
  "name": "Data Scientist",
  "description": "ML and data analysis",
  "role_description": "Builds models and analyzes data",
  "system_prompt_template": "You are a data scientist for {{company_name}}.",
  "default_effort": "medium",
  "heartbeat_interval_min": 60,
  "monthly_budget_cents": 5000
}
```

`default_effort` is optional. Valid values: `minimal | low | medium | high | max`.
It is the baseline reasoning level every agent created from this type inherits
(each agent can also override it individually, and each run can override it
again via a comment — see [Reasoning effort](#reasoning-effort)).

#### `GET /agent-types/:id`
Get a single agent type.

#### `PATCH /agent-types/:id`
Update an agent type. Built-in types cannot have heartbeat_interval_min or monthly_budget_cents changed.

#### `DELETE /agent-types/:id`
Delete a custom agent type. Built-in types cannot be deleted (returns 403).

---

### Agents

#### `GET /companies/:companyId/agents`
List agents for a company.

Query params: `?admin_status=enabled,disabled,terminated`

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "reports_to": "uuid | null",
      "reports_to_title": "CTO",
      "title": "Dev Engineer",
      "role_description": "Senior Engineer",
      "default_effort": "medium",
      "heartbeat_interval_min": 30,
      "monthly_budget_cents": 3000,
      "budget_used_cents": 1800,
      "status": "active",
      "last_heartbeat_at": "...",
      "assigned_issue_count": 4,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/agents`
Create (hire) an agent. If requested by the board directly, no approval needed.
If requested by another agent, creates a pending approval instead.

Request:
```json
{
  "title": "Frontend Engineer",
  "role_description": "Builds and maintains all user-facing interfaces",
  "system_prompt": "You are the **Frontend Engineer** at {{company_name}}...",
  "reports_to": "uuid",
  "default_effort": "medium",
  "heartbeat_interval_min": 60,
  "monthly_budget_cents": 3000,
  "mcp_servers": [
    { "name": "postgres", "url": "stdio://npx -y @modelcontextprotocol/server-postgres", "description": "Project database" }
  ]
}
```

`mcp_servers` is optional. Agent-level MCP servers are merged with company-level
MCP servers at runtime (agent-level takes precedence on name conflicts).

Response: full agent object.

#### `POST /companies/:companyId/agents/onboard`
Create an agent through the onboarding flow. The agent starts in `disabled` state.
An onboarding issue is created in the Operations project, assigned to the CEO agent.
The CEO reviews the new hire against the existing team and negotiates reporting
structure and responsibilities with the board via issue comments.

If no CEO agent exists, falls back to creating the agent directly in `enabled` state.

Request:
```json
{
  "title": "Data Scientist",
  "role_description": "Analyzes data and builds ML models",
  "system_prompt": "You are the Data Scientist at {{company_name}}...",
  "default_effort": "medium",
  "heartbeat_interval_min": 60,
  "monthly_budget_cents": 3000
}
```

Response:
```json
{
  "data": {
    "agent": { ... },
    "issue": { "id": "uuid", "identifier": "ACME-12", ... }
  }
}
```

#### `GET /companies/:companyId/agents/:agentId`
Get agent detail including system prompt.

Response: full agent object (same as list item + `system_prompt` + `mcp_servers` fields).

#### `PATCH /companies/:companyId/agents/:agentId`
Update agent config: title, role_description, system_prompt, default_effort,
heartbeat_interval_min, monthly_budget_cents, reports_to, mcp_servers.

Cannot update: status (use lifecycle endpoints), budget_used_cents (system-managed).

`default_effort` accepts `minimal | low | medium | high | max`. It sets the
baseline reasoning level applied to every run of this agent; comments posted
on the issue can override it per-run — see [Reasoning effort](#reasoning-effort).

#### `POST /companies/:companyId/agents/:agentId/disable`
Disable an agent. Stops heartbeats, kills subprocess if running. Does not affect the project container.

#### `POST /companies/:companyId/agents/:agentId/enable`
Enable a disabled agent.

#### `POST /companies/:companyId/agents/:agentId/terminate`
Terminate an agent. Kills the agent's subprocess. Unassigns all issues.
Agent record is kept for audit trail (admin_status = `terminated`).

#### `GET /companies/:companyId/agents/:agentId/heartbeat-runs`
Get agent execution history (last 50 runs). Each row includes timing
(`started_at`, `finished_at`, `status`, `exit_code`), usage (`input_tokens`,
`output_tokens`, `cost_cents`), and the new log fields:

- `invocation_command` — the exact CLI passed to `docker exec` with the JWT
  redacted.
- `log_text` — interleaved stdout/stderr captured from the streaming exec,
  capped at 1 MB. Stderr lines are prefixed `[stderr] `.
- `working_dir` — the container path the exec was rooted at (per-issue worktree
  or `/workspace`).
- `project_id` — project the run belongs to, used by the UI to subscribe to
  the corresponding `project-runs:<projectId>` WebSocket room.

#### `GET /companies/:companyId/agents/:agentId/heartbeat-runs/:runId`
Get a single heartbeat run with issue metadata and the full fields listed above.

#### `GET /companies/:companyId/issues/:issueId/latest-run`
Returns the most recent `heartbeat_run` for the issue (or `null` if none).
Powers the minified log strip on the issue detail page so it can subscribe to
the run's live stream and link to the full run page.

---

### Org Chart

#### `GET /companies/:companyId/org-chart`
Returns the full org tree as a nested structure.

Response:
```json
{
  "data": {
    "board": {
      "children": [
        {
          "id": "uuid",
          "title": "CEO",
          "runtime_status": "idle",
          "admin_status": "enabled",

          "children": [
            {
              "id": "uuid",
              "title": "CTO",
              "runtime_status": "idle",
              "admin_status": "enabled",
    
              "children": [
                { "id": "uuid", "title": "Dev Engineer", "runtime_status": "idle", "admin_status": "enabled", "children": [] },
                { "id": "uuid", "title": "UI Designer", "runtime_status": "idle", "admin_status": "enabled", "children": [] }
              ]
            },
            {
              "id": "uuid",
              "title": "CMO",
              "runtime_status": "idle",
              "admin_status": "disabled",
    
              "children": []
            }
          ]
        }
      ]
    }
  }
}
```

---

### Projects

#### `GET /companies/:companyId/projects`
List projects.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "name": "Backend API",
      "slug": "backend-api",
      "description": "Authenticated HTTP API for the main app.",
      "repo_count": 2,
      "open_issue_count": 5,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/projects`
Create a project. Container is auto-provisioned asynchronously. A planning issue titled
`Draft execution plan for "{name}"` is opened and assigned to the company's enabled CEO
agent — board users are redirected there so the CEO can draft the execution plan.
Fails with 500 if no enabled CEO agent exists.

Request: `name` and `description` are required. `docker_base_image` is optional and
defaults to `hezo/agent-base:latest`.
```json
{
  "name": "Backend API",
  "description": "Authenticated HTTP API for the main app.",
  "docker_base_image": "node:20"
}
```

Response includes the created project plus `planning_issue_id`, the UUID of the
auto-opened CEO planning issue.
```json
{
  "data": {
    "id": "uuid",
    "slug": "backend-api",
    "name": "Backend API",
    "description": "Authenticated HTTP API for the main app.",
    "planning_issue_id": "uuid",
    "...": "other project fields"
  }
}
```

#### `GET /companies/:companyId/projects/:projectId`
Get project detail including repos. Accepts project ID or slug.

Response: project object + `repos` array.

#### `PATCH /companies/:companyId/projects/:projectId`
Update name or description.

#### `DELETE /companies/:companyId/projects/:projectId`
Delete project. Cannot delete internal projects (e.g. Operations). Fails if there are open issues referencing it. Tears down the container asynchronously.

#### `POST /companies/:companyId/projects/:projectId/container/start`
Start the project container. Container must be provisioned. Wakes agents with pending work. Returns `{ container_status: "running" }`.

#### `POST /companies/:companyId/projects/:projectId/container/stop`
Gracefully stop the project container. Cancels running agent tasks. Returns `{ container_status: "stopping" }`.

#### `POST /companies/:companyId/projects/:projectId/container/rebuild`
Tear down and rebuild the project's Docker container. Kills all agent subprocesses
in this project, destroys the container, provisions a new one. Useful when base
image or dependency config changes. All agents keep their identity and config.
Returns `{ container_status: "creating" }`.

---

### Repos

#### `GET /companies/:companyId/projects/:projectId/repos`
List repos for a project.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "project_id": "uuid",
      "short_name": "frontend",
      "url": "https://github.com/org/frontend",
      "host_type": "github",
      "created_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/projects/:projectId/repos`
Add a repo. Server validates the URL pattern (GitHub only) and tests access
using the company's connected GitHub OAuth token before saving.

Requires: GitHub platform must be connected for this company.

Request:
```json
{
  "short_name": "frontend",
  "url": "https://github.com/org/frontend"
}
```

**Validation flow:**

1. Parse `owner/repo` from the URL
2. Check `connected_platforms` for an active GitHub connection for this company
3. If connected: call `GET https://api.github.com/repos/{owner}/{repo}` with the OAuth token
4. If accessible (200): insert the repo record
5. If not accessible (403/404): return `REPO_ACCESS_FAILED`
6. If GitHub not connected: return `GITHUB_NOT_CONNECTED` and create a board inbox item

Error if GitHub not connected (also creates a board inbox item of type
`oauth_request` with a link to start the GitHub OAuth flow):
```json
{
  "error": {
    "code": "GITHUB_NOT_CONNECTED",
    "message": "Connect GitHub in company settings before adding repos"
  }
}
```

Error if the connected GitHub account cannot access the repo:
```json
{
  "error": {
    "code": "REPO_ACCESS_FAILED",
    "message": "Cannot access this repo — the GitHub user 'acme-bot' needs to be added to org/frontend"
  }
}
```

The `REPO_ACCESS_FAILED` message includes the connected GitHub username (from
`connected_platforms.metadata.username`) so the board knows which account needs
access to the repository.

**Synchronous clone:** on a successful insert the server clones the repo via
SSH into `<dataDir>/companies/<company-slug>/projects/<project-slug>/workspace/<short_name>/`
(bind-mounted as `/workspace/<short_name>/` inside the project container) and
returns the result in the response body as `clone_status` (`"cloned"`,
`"skipped"`, or `"failed"`) and `clone_error` (string or `null`). Clone
failures do not fail the request — the repo record is still created, and
`ensureProjectRepos` will retry on the next agent run or the next container
provision.

#### `DELETE /companies/:companyId/projects/:projectId/repos/:repoId`
Remove a repo from a project. The server also removes the repo's on-disk
workspace directory and every per-issue worktree derived from it
(`<workspace>/<short_name>/` and `<worktrees>/<issue>/<short_name>/`).

---

### Issues

#### `GET /companies/:companyId/issues`
List issues. Supports filtering and pagination.

Query params:
- `?project_id=uuid` — filter by project
- `?assignee_id=uuid` — filter by assignee (references members.id)
- `?status=open,in_progress` — comma-separated status filter
- `?priority=urgent,high` — comma-separated priority filter
- `?search=websocket` — full-text search on title + description
- `?page=1&per_page=50` — pagination (default 50, max 200)
- `?sort=created_at:desc` — sort field and direction

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "project_id": "uuid",
      "project_name": "Backend API",
      "assignee_id": "uuid",
      "assignee_name": "Dev Engineer",
      "assignee_type": "agent",
      "has_active_run": true,
      "parent_issue_id": null,
      "number": 47,
      "title": "Implement WebSocket handler for real-time sync",
      "status": "in_progress",
      "priority": "urgent",
      "labels": ["backend", "collab"],
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "meta": {
    "page": 1,
    "per_page": 50,
    "total": 14
  }
}
```

`assignee_type` is `"agent"` or `"user"` depending on whether the assignee is an agent member or a human board member (matches `members.member_type`). `has_active_run` is `true` when at least one `heartbeat_runs` row exists for the issue in `running` or `queued` status — used by the UI to show a live indicator next to the assignee name.

#### `POST /companies/:companyId/issues`
Create an issue.

Request:
```json
{
  "project_id": "uuid",
  "title": "Implement WebSocket handler for real-time sync",
  "description": "We need a WebSocket handler that supports...",
  "assignee_id": "uuid",
  "parent_issue_id": "uuid | null",
  "priority": "urgent",
  "labels": ["backend", "collab"],
  "runtime_type": "claude_code"
}
```

`project_id` and `assignee_id` are required (enforced). `number` is auto-assigned via
`next_issue_number()`. If the assignee is an agent, the agent receives
an event trigger. If a board member, they are notified via inbox and
configured messaging channels.

`runtime_type` is optional. It pins this issue to a specific AI adapter
(`claude_code | codex | gemini | kimi`). When unset, the server picks the
instance default — the single active AI provider if only one is configured,
or the oldest/default active provider otherwise.

#### `GET /companies/:companyId/issues/:issueId`
Full issue detail including description, goal chain, cost.

Response: full issue object + computed fields:
```json
{
  "data": {
    "id": "uuid",
    "number": 47,
    "title": "...",
    "description": "...",
    "project_id": "uuid",
    "project_name": "Backend API",
    "project_goal": "Ship collaboration features",
    "company_description": "Build the #1 AI note-taking app",
    "assignee_id": "uuid",
    "assignee_name": "Dev Engineer",
    "assignee_type": "agent",
    "parent_issue_id": null,
    "status": "in_progress",
    "priority": "urgent",
    "labels": ["backend", "collab"],
    "cost_cents": 234,
    "comment_count": 4,
    "created_at": "...",
    "updated_at": "..."
  }
}
```

#### `PATCH /companies/:companyId/issues/:issueId`
Update issue fields: title, description, status, priority, assignee_id, labels, rules, progress_summary, runtime_type.

`assignee_id` cannot be set to null — every issue must have an assignee.
Changing `assignee_id` triggers an event on the newly assigned agent, or a notification to the newly assigned board member.
Changing `status` to `done` or `closed` triggers preview cleanup.

#### `DELETE /companies/:companyId/issues/:issueId`
Delete an issue. Only allowed if status is `backlog` or `open`, and no comments exist.

#### `POST /companies/:companyId/issues/:issueId/sub-issues`
Create a sub-issue. `project_id` is inherited from the parent.

Request:
```json
{
  "title": "Write unit tests for WebSocket reconnection",
  "description": "...",
  "assignee_id": "uuid",
  "priority": "high",
  "labels": ["testing"]
}
```

#### `GET /companies/:companyId/issues/:issueId/dependencies`
List dependencies (blocking issues) for an issue.

#### `POST /companies/:companyId/issues/:issueId/dependencies`
Add a dependency. An issue cannot block itself, and both issues must be in the same company.

Request:
```json
{
  "blocked_by_issue_id": "uuid"
}
```

#### `DELETE /companies/:companyId/issues/:issueId/dependencies/:depId`
Remove a dependency.

---

### Issue Comments

#### `GET /companies/:companyId/issues/:issueId/comments`
List all comments for an issue, ordered by created_at asc.

Query params: `?include_tool_calls=true` — inline tool_calls under each
trace-type comment.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "issue_id": "uuid",
      "author_type": "agent",
      "author_agent_id": "uuid",
      "author_agent_title": "Dev Engineer",
      "content_type": "text",
      "content": { "text": "Starting on the WebSocket handler..." },
      "chosen_option": null,
      "tool_calls": [],
      "created_at": "..."
    },
    {
      "id": "uuid",
      "author_type": "agent",
      "author_agent_id": "uuid",
      "author_agent_title": "Dev Engineer",
      "content_type": "options",
      "content": {
        "prompt": "Which auth strategy should I implement?",
        "options": [
          { "id": "jwt", "label": "JWT tokens", "description": "Stateless, good for API-first" },
          { "id": "session", "label": "Server sessions", "description": "Simpler, good for SSR" }
        ]
      },
      "chosen_option": null,
      "tool_calls": [],
      "created_at": "..."
    },
    {
      "id": "uuid",
      "author_type": "agent",
      "author_agent_id": "uuid",
      "author_agent_title": "Dev Engineer",
      "content_type": "preview",
      "content": {
        "filename": "auth-flow-mockup.html",
        "label": "Auth flow mockup",
        "description": "Interactive prototype of the login/signup flow"
      },
      "preview_url": "/api/companies/company-uuid/projects/project-uuid/preview/auth-flow-mockup.html",
      "tool_calls": [],
      "created_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/issues/:issueId/comments`
Board posts a comment.

Request:
```json
{
  "content_type": "text",
  "content": { "text": "Make sure we handle reconnection gracefully..." },
  "effort": "max"
}
```

`author_type` is always `board` for this endpoint.

`effort` is optional. When set (valid values: `minimal | low | medium | high | max`),
it overrides the assigned agent's `default_effort` for the wakeup triggered by
this comment — useful for asking an agent to think harder about a tricky piece
of feedback. Invalid values are silently dropped. See
[Reasoning effort](#reasoning-effort).

#### `POST /companies/:companyId/issues/:issueId/comments/:commentId/choose`
Board picks an option on an options-type comment.

Request:
```json
{
  "chosen_id": "jwt"
}
```

Sets `chosen_option` on the comment and posts a system comment recording the
choice. Triggers the assigned agent.

---

### Tool Calls

#### `GET /companies/:companyId/issues/:issueId/comments/:commentId/tool-calls`
List tool calls for a specific comment.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "agent_id": "uuid",
      "tool_name": "bash",
      "input": { "command": "npm test -- --grep websocket" },
      "output": { "exit_code": 0, "stdout": "..." },
      "status": "success",
      "duration_ms": 3400,
      "cost_cents": 12,
      "created_at": "..."
    }
  ]
}
```

---

### Secrets

#### `GET /companies/:companyId/secrets`
List secrets (values are never returned, only metadata).

Query params: `?project_id=uuid` — filter by project scope.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "project_id": "uuid | null",
      "project_name": "Backend API | null",
      "name": "GITHUB_TOKEN",
      "category": "api_token",
      "grant_count": 2,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/secrets`
Create a secret.

Request:
```json
{
  "name": "GITHUB_TOKEN",
  "value": "ghp_abc123...",
  "project_id": "uuid | null",
  "category": "api_token"
}
```

`value` is encrypted server-side before storage. Never stored or logged in
plaintext.

#### `PATCH /companies/:companyId/secrets/:secretId`
Update a secret's value or category. Rotating a value does not revoke existing
grants.

Request:
```json
{
  "value": "ghp_newtoken...",
  "category": "api_token"
}
```

#### `DELETE /companies/:companyId/secrets/:secretId`
Delete a secret. Revokes all grants. Agents with this secret injected will
lose access on next subprocess invocation.

---

### Secret Grants

#### `GET /companies/:companyId/secrets/:secretId/grants`
List grants for a secret.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "secret_id": "uuid",
      "agent_id": "uuid",
      "agent_title": "Dev Engineer",
      "scope": "single",
      "granted_at": "...",
      "revoked_at": null
    }
  ]
}
```

#### `POST /companies/:companyId/secrets/:secretId/grants`
Directly grant an agent access (board action, no approval needed).

Request:
```json
{
  "agent_id": "uuid",
  "scope": "single"
}
```

If `scope` is `project`, grants access to all secrets in the same project.
If `scope` is `company`, grants access to all secrets in the company.
These expanded grants create individual `secret_grants` rows for each
matching secret.

#### `DELETE /companies/:companyId/secret-grants/:grantId`
Revoke a grant. Sets `revoked_at`.

---

### Approvals

#### `GET /companies/:companyId/approvals`
List pending approvals for a company.

Query params: `?status=pending` (default)

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "company_name": "NoteGenius AI",
      "type": "secret_access",
      "status": "pending",
      "requested_by_agent_id": "uuid",
      "requested_by_agent_title": "Dev Engineer",
      "payload": {
        "secret_id": "uuid",
        "secret_name": "GITHUB_TOKEN",
        "reason": "Need to push to feature branch for issue #47"
      },
      "created_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/approvals`
Create an approval request directly. Used internally by agents and the board.

Request:
```json
{
  "type": "secret_access",
  "requested_by_member_id": "uuid",
  "payload": { ... }
}
```

#### `POST /approvals/:approvalId/resolve`
Approve or deny a pending approval.

Request:
```json
{
  "status": "approved",
  "resolution_note": "Approved for project scope"
}
```

`status` must be `"approved"` or `"denied"`.

When approved, side effects depend on approval type: `SystemPromptUpdate` approvals update the agent's system prompt and record a revision; `SkillProposal` approvals write the skill to the database.
```

---

### Cost & Budget

#### `GET /companies/:companyId/costs`
List cost entries with aggregation.

Query params:
- `?agent_id=uuid`
- `?project_id=uuid`
- `?issue_id=uuid`
- `?from=2026-03-01&to=2026-03-31`
- `?group_by=agent|project|day`

Response (when `group_by=agent`):
```json
{
  "data": {
    "entries": [...],
    "summary": [
      { "agent_id": "uuid", "agent_title": "CEO", "total_cents": 2400 },
      { "agent_id": "uuid", "agent_title": "Dev Engineer", "total_cents": 1800 }
    ],
    "total_cents": 12700
  }
}
```

#### `POST /companies/:companyId/costs`
Create a cost entry. Returns 402 if the agent's budget is exceeded.

Request:
```json
{
  "member_id": "uuid",
  "amount_cents": 100,
  "issue_id": "uuid",
  "project_id": "uuid",
  "description": "API call cost"
}
```

---

### Audit Log

#### `GET /companies/:companyId/audit-log`
Paginated, read-only.

Query params:
- `?entity_type=agent&entity_id=uuid`
- `?action=agent.created`
- `?from=...&to=...`
- `?page=1&per_page=50`

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "actor_type": "board",
      "actor_agent_id": null,
      "action": "agent.created",
      "entity_type": "agent",
      "entity_id": "uuid",
      "details": { "title": "Frontend Engineer" },
      "created_at": "..."
    }
  ],
  "meta": { "page": 1, "per_page": 50, "total": 234 }
}
```

---

### Connected Platforms (Hezo Connect OAuth)

#### `GET /companies/:companyId/connections`
List all connected platforms for a company.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "platform": "github",
      "status": "active",
      "scopes": "repo,workflow,read:org",
      "metadata": { "username": "acme-bot", "email": "bot@acme.com" },
      "token_expires_at": "...",
      "connected_at": "..."
    },
    {
      "id": "uuid",
      "platform": "anthropic",
      "status": "active",
      "scopes": "",
      "metadata": {},
      "token_expires_at": "...",
      "connected_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/connections/:platform/start`
Initiate an OAuth connection. Returns a redirect URL that the UI opens in a
new window/tab for the user to authorize.

`platform` is one of: `github`, `anthropic`, `openai`, `google`.

Response:
```json
{
  "data": {
    "auth_url": "https://connect.hezo.ai/auth/github/start?callback=http://localhost:3100/oauth/callback&state=encrypted_state",
    "state": "encrypted_state_token"
  }
}
```

#### `DELETE /companies/:companyId/connections/:connectionId`
Disconnect a platform. Removes SSH keys from GitHub if applicable, cleans up
associated secrets, and deletes the connection record.

#### `POST /companies/:companyId/connections/:connectionId/refresh`
Force a token refresh. Returns updated status and token expiry.

Response:
```json
{
  "data": {
    "status": "active",
    "token_expires_at": "..."
  }
}
```

---

### AI Providers

AI provider credentials are **instance-level**: a single set of configs is shared across every company in the Hezo instance. Keys are encrypted with the master key. The web shell blocks the app with a full-screen setup gate until at least one provider is configured; it re-appears if the last active provider is deleted.

Authentication: read endpoints require a board-role token. Mutation endpoints (`POST`, `DELETE`, `PATCH`, OAuth start, verify) additionally require superuser.

#### `GET /ai-providers`
List all configured AI providers.

#### `GET /ai-providers/status`
Lightweight status check. Returns `{ configured: boolean, providers: string[] }`.

#### `POST /ai-providers`
Add an AI provider configuration. Validates key format and (unless `SKIP_AI_KEY_VALIDATION` is set) makes a live call to the provider to confirm the key works before storing.

Request:
```json
{
  "provider": "anthropic",
  "api_key": "sk-ant-...",
  "label": "anthropic-primary",
  "auth_method": "api_key"
}
```

`provider` is one of: `anthropic`, `openai`, `google`, `moonshot`. `label` is optional; the server auto-derives one from the provider name if omitted. Returns 409 if a `(provider, label)` pair already exists.

#### `DELETE /ai-providers/:configId`
Remove a configuration.

#### `PATCH /ai-providers/:configId/default`
Mark a config as the default for its provider (exactly one default per provider is enforced by a partial unique index).

#### `POST /ai-providers/:provider/oauth/start`
Initiate OAuth flow for a provider (`anthropic`, `openai`, `google`). Returns `auth_url` and `state`. State carries `ai_provider` only — no company context.

#### `POST /ai-providers/:configId/verify`
Verify a stored key by making a lightweight call to the provider. Updates config status to `invalid` if the key is bad.

---

### Execution Locks

#### `GET /companies/:companyId/issues/:issueId/lock`
Get current locks on an issue.

Response:
```json
{
  "data": {
    "locks": [{ "id": "uuid", "issue_id": "uuid", "member_id": "uuid", "lock_type": "write", "locked_at": "...", "member_name": "..." }],
    "has_write_lock": true
  }
}
```

#### `POST /companies/:companyId/issues/:issueId/lock`
Acquire a lock. Write locks are exclusive; read locks are shared (blocked only by write locks). Returns 409 if already locked.

Request:
```json
{
  "member_id": "uuid",
  "lock_type": "write"
}
```

#### `DELETE /companies/:companyId/issues/:issueId/lock`
Release all locks for the issue.

---

### Semantic Search

#### `GET /companies/:companyId/search`
Natural language search across company content.

Query params:
- `?q=query` — search query (required)
- `?scope=all` — `all`, `kb_docs`, `issues`, or `skills` (default `all`)
- `?limit=10` — max results (default 10)

---

### UI State

#### `GET /companies/:companyId/ui-state`
Get the board user's UI state settings (stored as JSON in member_users). Board users only.

#### `PATCH /companies/:companyId/ui-state`
Update UI state settings (merged with existing). Board users only.

---

### Previews (proxy)

#### `GET /companies/:companyId/projects/:projectId/preview/*`
Serves static files from the project container workspace. The wildcard path
maps to a file within the container's working directory.

Headers on response:
```
Content-Security-Policy: sandbox allow-scripts
X-Frame-Options: SAMEORIGIN
Cache-Control: no-store
```

Returns 404 if file doesn't exist. Returns 403 if the requesting user doesn't
have board access to the company. Paths are sanitized (no path traversal).

---

### Knowledge Base

#### `GET /companies/:companyId/kb-docs`
List all knowledge base documents for a company.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "title": "Coding Standards",
      "slug": "coding-standards",
      "last_updated_by_agent_id": "uuid | null",
      "last_updated_by_agent_title": "CTO",
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/kb-docs`
Create a knowledge base document (board action).

Request:
```json
{
  "title": "Coding Standards",
  "content": "# Coding Standards\n\n## TypeScript\n- Always use strict mode...",
  "slug": "coding-standards"
}
```

`slug` is optional — auto-derived from the title if not provided (lowercased, spaces → hyphens).

#### `GET /companies/:companyId/kb-docs/:slug`
Get full document content.

Response: full doc object including `content` field.

#### `PATCH /companies/:companyId/kb-docs/:slug`
Update a document. Direct edits by the board do not require approval.
Agent edits create a pending approval instead (returns 202).

Request:
```json
{
  "title": "Coding Standards",
  "content": "# Coding Standards\n\n## Updated content...",
  "change_summary": "Updated TypeScript guidelines"
}
```

#### `DELETE /companies/:companyId/kb-docs/:slug`
Delete a knowledge base document.

#### `POST /companies/:companyId/kb-docs/:slug/restore`
Restore a document to a previous revision. Board-only (agents cannot restore).

Request:
```json
{
  "revision_number": 3
}
```

#### `GET /companies/:companyId/kb-docs/:slug/revisions`
List revision history for a knowledge base document, ordered by revision_number descending.

---

### Skills

#### `GET /companies/:companyId/skills`
List the skills manifest for a company. Returns all installed skills with metadata.

#### `GET /companies/:companyId/skills/:slug`
Get a skill's content by slug.

#### `POST /companies/:companyId/skills`
Add or download a skill. Downloads content from `source_url`.

Request:
```json
{
  "name": "Code Review",
  "source_url": "https://example.com/skills/code-review",
  "description": "Automated code review skill",
  "slug": "code-review",
  "tags": ["review", "quality"]
}
```

`source_url` is required (the remote source to download from). `description`, `slug`, and `tags` are optional.

#### `PATCH /companies/:companyId/skills/:slug`
Update skill metadata or content. If `content` changes, creates a new skill revision.

#### `DELETE /companies/:companyId/skills/:slug`
Remove a skill.

#### `POST /companies/:companyId/skills/:slug/sync`
Sync a skill from its source URL, pulling the latest version.

---

### Company Preferences

#### `GET /companies/:companyId/preferences`
Get the company preferences document.

Response:
```json
{
  "data": {
    "id": "uuid",
    "company_id": "uuid",
    "content": "## Code Architecture\n- Prefer functional patterns...\n\n## Design\n...",
    "last_updated_by_agent_id": "uuid | null",
    "last_updated_by_agent_title": "Architect",
    "created_at": "...",
    "updated_at": "..."
  }
}
```

Returns an empty document (auto-created) if no preferences have been set yet.

#### `PATCH /companies/:companyId/preferences`
Update the company preferences document (board action). Creates a revision automatically.

Request:
```json
{
  "content": "## Code Architecture\n- Prefer functional patterns...",
  "change_summary": "Added preference for functional patterns based on recent feedback"
}
```

#### `GET /companies/:companyId/preferences/revisions`
List revision history for the company preferences document.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "revision_number": 3,
      "change_summary": "Added preference for functional patterns",
      "author_agent_title": "Architect",
      "author_user_name": null,
      "created_at": "..."
    }
  ]
}
```

---

### Project Documents

Project documents are stored in the database, identified by filename (e.g. `prd.md`, `spec.md`).

#### `GET /companies/:companyId/projects/:projectId/docs`
List all project documents.

Response:
```json
{
  "data": [
    { "id": "uuid", "filename": "spec.md", "updated_at": "..." },
    { "id": "uuid", "filename": "prd.md", "updated_at": "..." }
  ]
}
```

#### `GET /companies/:companyId/projects/:projectId/docs/:filename`
Read a project document by filename.

Response:
```json
{
  "data": { "id": "uuid", "filename": "spec.md", "content": "# Technical Specification\n...", "updated_at": "..." }
}
```

#### `PUT /companies/:companyId/projects/:projectId/docs/:filename`
Write a project document (upsert). Agent writes to `prd.md` create an approval request (202 response) instead of writing directly.

Request:
```json
{
  "content": "# Technical Specification\n\n## Updated..."
}
```

#### `DELETE /companies/:companyId/projects/:projectId/docs/:filename`
Delete a project document.

#### `GET /companies/:companyId/projects/:projectId/agents-md`
Read the project's AGENTS.md file.

#### `PUT /companies/:companyId/projects/:projectId/agents-md`
Write the project's AGENTS.md file.

Request:
```json
{
  "content": "# Agent Guidelines\n..."
}
```

---

### Live Chat

Each issue has a **persistent live chat** — one ongoing conversation per issue, always
available. The chat is auto-created with the issue, no sessions or setup required. The assigned agent is always a participant. Board members can @-mention any other agent to pull them in.

#### `GET /companies/:companyId/issues/:issueId/chat/messages`
Get chat messages for this issue.

Query params:
- `?after=<timestamp>` — only messages after this timestamp (for polling/pagination)
- `?limit=50` — max messages to return (default 50, from most recent)

Response:
```json
{
  "data": [
    { "id": "uuid", "author": "board:alice", "content": "What auth strategy do you recommend?", "created_at": "..." },
    { "id": "uuid", "author": "agent:architect", "content": "For this API-first product, I'd suggest JWT...", "created_at": "..." }
  ]
}
```

#### `POST /companies/:companyId/issues/:issueId/chat/messages`
Post a chat message. The server detects @-mentions in the content text, wakes
the mentioned agent immediately, and adds them to the chat.

Request:
```json
{
  "content": "What auth strategy do you recommend? @architect"
}
```

Mentions are parsed from the content text (e.g. `@architect`). The server creates wakeups for mentioned agents.

---

### File Attachments

**Not yet implemented — planned for Phase 7+.**

#### `GET /companies/:companyId/issues/:issueId/attachments`
List file attachments for an issue.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "original_filename": "screenshot.png",
      "content_type": "image/png",
      "byte_size": 245000,
      "uploaded_by_agent_id": "uuid",
      "created_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/issues/:issueId/attachments`
Upload a file attachment. Multipart form data.

Max file size: 10MB. Allowed types: images, PDFs, text files, archezos, logs.

Response:
```json
{
  "data": {
    "id": "uuid",
    "original_filename": "screenshot.png",
    "content_type": "image/png",
    "byte_size": 245000,
    "sha256": "abc123...",
    "created_at": "..."
  }
}
```

#### `DELETE /companies/:companyId/issues/:issueId/attachments/:attachmentId`
Remove a file attachment from an issue. The underlying asset is deleted.

---

### Plugins

**Not yet implemented — planned for Phase 8+.**

#### `GET /plugins/registry`
Browse and search the centralized plugin registry at plugins.hezo.ai.

Query params:
- `?search=linear` — keyword search
- `?category=integration` — filter by category
- `?sort=rating|downloads|updated` — sort order
- `?page=1&per_page=20` — pagination

Response:
```json
{
  "data": [
    {
      "key": "hezo-community/linear-sync",
      "name": "Linear Sync",
      "description": "Two-way sync between Hezo issues and Linear tickets",
      "version": "1.2.0",
      "author": "hezo-community",
      "rating": 4.7,
      "download_count": 1240,
      "verified": true
    }
  ]
}
```

#### `GET /plugins/registry/:pluginKey`
Get plugin detail including readme, ratings, reviews, and version history.

#### `POST /companies/:companyId/plugins`
Install a plugin from the registry.

Request:
```json
{
  "plugin_key": "hezo-community/linear-sync",
  "version": "1.2.0",
  "config": { "linear_api_key_secret": "LINEAR_API_KEY" }
}
```

Response: full plugin object with status `installed`.

#### `PATCH /companies/:companyId/plugins/:pluginId`
Enable, disable, or update a plugin's config.

Request:
```json
{
  "status": "enabled",
  "config": { "sync_interval_minutes": 5 }
}
```

#### `DELETE /companies/:companyId/plugins/:pluginId`
Uninstall a plugin. Stops the worker thread, cleans up state and jobs.

#### `GET /companies/:companyId/plugins`
List installed plugins for a company.

---

### Auth & Team

Current auth uses `POST /auth/token` to exchange the master key for a board JWT (see Authentication section above). OAuth login (GitHub/GitLab) is planned for Phase 6.5.

**OAuth login endpoints — not yet implemented — planned for Phase 6.5.**

#### `GET /auth/github`
Initiate GitHub OAuth login.

#### `GET /auth/gitlab`
Initiate GitLab OAuth login.

#### `GET /auth/callback`
OAuth callback endpoint.

**Invite endpoints — not yet implemented — planned for Phase 7+.**

#### `POST /companies/:companyId/invites`
Invite a new member to the company. Board-only.

Request:
```json
{
  "email": "bob@example.com",
  "role": "member",
  "role_title": "Frontend Developer",
  "permissions_text": "Can direct Engineer and QA Engineer on frontend tasks. Cannot modify architecture decisions.",
  "project_ids": ["uuid-1", "uuid-2"]
}
```

`role` defaults to `member`. For board invites, omit `role_title`, `permissions_text`, and `project_ids`. `project_ids` is optional — if omitted, the member can access all projects.

Response:
```json
{
  "data": {
    "id": "uuid",
    "email": "bob@example.com",
    "role": "member",
    "role_title": "Frontend Developer",
    "code": "invite-code-here",
    "expires_at": "..."
  }
}
```

The invite code can be shared out-of-band (email, chat, etc.).

#### `POST /invites/:code/accept`
Accept an invite and join the company. Requires authentication (user JWT). The invite's role, title, permissions, and project scope are copied to a new member_users row.

**Member management endpoints — not yet implemented — planned for Phase 7+.**

#### `GET /companies/:companyId/members`
List all members of a company.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "user_id": "...",
      "member_id": "uuid",
      "name": "Alice",
      "email": "alice@example.com",
      "role": "board",
      "role_title": null,
      "permissions_text": "",
      "project_ids": null,
      "joined_at": "..."
    },
    {
      "id": "uuid",
      "user_id": "...",
      "member_id": "uuid",
      "name": "Bob",
      "email": "bob@example.com",
      "role": "member",
      "role_title": "Frontend Developer",
      "permissions_text": "Can direct Engineer and QA Engineer on frontend tasks.",
      "project_ids": ["uuid-1"],
      "joined_at": "..."
    }
  ]
}
```

#### `PATCH /companies/:companyId/members/:userId`
Update a member's role_title, permissions_text, or project_ids. Board-only.

Request:
```json
{
  "role_title": "Senior Frontend Developer",
  "permissions_text": "Can direct Engineer, QA Engineer, and UI Designer.",
  "project_ids": null
}
```

---

### Board Inbox

**Not yet implemented — planned for Phase 7+.**

#### `GET /companies/:companyId/inbox`
Aggregated notifications. Board members see all items (approvals, escalations, budget alerts, design reviews, etc.). Members see only items relevant to their assigned issues and project scope.

Query params:
- `?status=unread` — filter by read/unread
- `?page=1&per_page=50` — pagination

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "company_id": "uuid",
      "type": "approval",
      "title": "Secret access request from Dev Engineer",
      "reference_type": "approval",
      "reference_id": "uuid",
      "dismissed_at": null,
      "created_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/inbox/:id/dismiss`
Dismiss an inbox item. Sets `dismissed_at`.

---

### Notification Preferences

**Not yet implemented — planned for Phase 7+.**

#### `GET /users/me/notification-preferences`
List notification preferences for all channels.

Response:
```json
{
  "data": [
    {
      "channel": "web",
      "enabled": true,
      "event_types": ["approvals", "escalations", "budget_alerts", "agent_errors", "qa_findings", "oauth_requests", "design_reviews"]
    },
    {
      "channel": "telegram",
      "enabled": true,
      "event_types": ["approvals", "escalations"],
      "telegram_chat_id": "123456789"
    }
  ]
}
```

#### `PUT /users/me/notification-preferences`
Update notification preferences. Accepts an array of channel configs. Upserts by channel.

---

### Slack Connection

**Not yet implemented — planned for Phase 7+.**

#### `GET /companies/:companyId/slack-connection`
Get Slack connection status for a company.

#### `POST /companies/:companyId/slack-connection`
Set up Slack integration for a company. Stores the bot token encrypted in secrets.

Request:
```json
{
  "bot_token": "xoxb-...",
  "team_id": "T0123ABC",
  "team_name": "My Workspace"
}
```

#### `DELETE /companies/:companyId/slack-connection`
Disconnect Slack from a company. Revokes the bot token secret.

---

### Webhooks

**Not yet implemented — planned for Phase 7+.**

#### `POST /webhooks/slack`
Receives Slack Events API payloads. Handles interactive messages (approvals), slash commands, and channel messages directed at agents.

#### `POST /webhooks/telegram`
Receives Telegram Bot API webhook updates. Handles bot commands (`/issues`, `/approve`, `/comment`), inline keyboard callbacks, and text messages.

---

## Reasoning effort

Every agent run picks a reasoning effort level from the `agent_effort` enum:

```
minimal | low | medium | high | max
```

The effective level is resolved at run-activation time with this precedence
(highest wins):

1. An explicit `effort` value on the triggering wakeup payload — set by a
   human via a comment, or by an MCP caller that wants a single run to reason
   harder.
2. The agent's `default_effort` column on `member_agents` (copied from
   `agent_types.default_effort` when the agent is hired).
3. The global default, `medium`.

Each runtime translates the resolved level to its native knob:

| Runtime | Translation |
|---------|-------------|
| `claude_code` | Appends `think` / `think hard` / `ultrathink` to the task prompt. |
| `codex` | Passes `-c model_reasoning_effort=<level>` (`max` → `high`). |
| `gemini` | Sets `GEMINI_REASONING_EFFORT=<level>` in the container env. |
| `kimi` | Prompt-only directive (no native knob). |

The resolved level is also exposed as `HEZO_AGENT_EFFORT` in the container
env so agent-side tooling can read it.

Built-in agent defaults: CEO and Architect default to `max` (ultrathink),
Product Lead / QA / Security / Researcher to `high`, all implementers to
`medium`.

---

## Agent API

Agents call these endpoints from inside the project's Docker container.
All requests require `Authorization: Bearer <agent_token>`.

Base URL: `http://host.docker.internal:3100/agent-api`

The agent token encodes `agent_id` and `company_id`, so routes don't need
those as path params.

---

### Heartbeat

#### `POST /heartbeat`
Agent reports in. Server returns pending work.

Request:
```json
{
  "metrics": {
    "memory_mb": 256,
    "disk_mb": 1024
  }
}
```

Response:
```json
{
  "data": {
    "agent": {
      "id": "uuid",
      "member_id": "uuid",
      "title": "Dev Engineer",
      "status": "active",
      "system_prompt": "You are the **Frontend Engineer**...",
      "budget_remaining_cents": 1200
    },
    "assigned_issues": [
      {
        "id": "uuid",
        "number": 47,
        "title": "Implement WebSocket handler...",
        "status": "in_progress",
        "priority": "urgent",
        "project_name": "Backend API",
        "project_goal": "Ship collaboration features",
        "company_description": "Build the #1 AI note-taking app",
        "repos": [
          { "short_name": "api", "url": "https://github.com/org/api" }
        ],
        "unread_comments": 1
      }
    ],
    "notifications": [
      { "type": "mention", "issue_id": "uuid", "issue_number": 45, "text": "@deveng can you review this?" }
    ]
  }
}
```

Updates `last_heartbeat_at`. If agent admin_status is `disabled` or `terminated`,
response includes empty `assigned_issues` and agent should stop working.

---

### Post Comment

#### `POST /issues/:issueId/comments`
Agent posts a comment on an issue.

Request (text):
```json
{
  "content_type": "text",
  "content": { "text": "Starting on the WebSocket handler..." }
}
```

Request (options):
```json
{
  "content_type": "options",
  "content": {
    "prompt": "Which auth strategy should I implement?",
    "options": [
      { "id": "jwt", "label": "JWT tokens", "description": "Stateless" },
      { "id": "session", "label": "Server sessions", "description": "Simpler" }
    ]
  }
}
```

Request (preview):
```json
{
  "content_type": "preview",
  "content": {
    "filename": "auth-flow-mockup.html",
    "label": "Auth flow mockup",
    "description": "Interactive prototype"
  }
}
```

Server validates that the file exists in the agent's preview directory.

#### @-mentions (agent-to-agent communication)

All inter-agent communication happens via @-mentions in issue comments — same
as GitHub. No side channels, no direct messaging. Everything is on the record.

Text content can contain `@<agent-slug>` references. The slug is derived from
the agent title (lowercased, spaces → hyphens, e.g. "Dev Engineer" → `dev-engineer`).
Repo short names can also be referenced: `@frontend`, `@api`.

The server parses mentions from comment content and creates notifications for
the mentioned agent. The mentioned agent receives the notification on its next
heartbeat (in the `notifications` array).

Agents can use this to: ask questions, request reviews, escalate blockers, hand
off context, or coordinate work across teams — all visible in the issue thread,
all traceable in the audit log.

---

### Report Tool Calls

#### `POST /issues/:issueId/comments/:commentId/tool-calls`
Agent reports tool calls associated with a comment.

Request:
```json
{
  "tool_calls": [
    {
      "tool_name": "bash",
      "input": { "command": "npm test" },
      "output": { "exit_code": 0, "stdout": "..." },
      "status": "success",
      "duration_ms": 3400,
      "cost_cents": 12
    }
  ]
}
```

Each tool call with `cost_cents > 0` also creates a `cost_entries` row and
debits the agent's budget atomically. If budget is exceeded, returns:
```json
{
  "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "Agent budget limit reached."
  }
}
```

---

### Request Secret

#### `POST /secrets/request`
Agent requests access to a secret. Creates a pending approval.

Request:
```json
{
  "secret_name": "GITHUB_TOKEN",
  "project_id": "uuid | null",
  "reason": "Need to push to feature branch for issue #47"
}
```

Response:
```json
{
  "data": {
    "approval_id": "uuid",
    "status": "pending"
  }
}
```

#### `GET /secrets/mine`
Agent lists secrets it currently has access to (granted, not revoked).

Response:
```json
{
  "data": [
    {
      "name": "GITHUB_TOKEN",
      "category": "api_token",
      "project_id": "uuid | null"
    }
  ]
}
```

Note: actual values are injected as env vars in the agent's subprocess, never returned
via API.

---

### Self System Prompt

#### `GET /self/system-prompt`
Agent reads its own system prompt and agent type info.

Response:
```json
{
  "data": {
    "system_prompt": "You are the CEO of {{company_name}}...",
    "agent_type_id": "uuid | null",
    "type_template": "original template from agent type | null"
  }
}
```

#### `PATCH /self/system-prompt`
Agent requests to update its own system prompt. Creates a `system_prompt_update` approval for board review.

Request:
```json
{
  "system_prompt": "Updated prompt text...",
  "reason": "Board asked me to focus more on testing"
}
```

Response (202):
```json
{
  "data": {
    "approval_id": "uuid",
    "status": "pending"
  }
}
```

When the board approves, the system prompt is updated automatically.

---

### Request Hire

#### `POST /agents/request-hire`
**Not yet implemented.**

Agent (e.g. CTO) requests to hire a new agent. Creates a pending approval.

Request:
```json
{
  "title": "QA Engineer",
  "role_description": "Automated test coverage",
  "system_prompt": "You are the QA Engineer at {{company_name}}...",
  "reports_to": "self",
  "heartbeat_interval_min": 120,
  "monthly_budget_cents": 2500,
  "reason": "We need automated test coverage before the collab feature ships."
}
```

`"reports_to": "self"` means the new agent will report to the requesting agent.

---

### Create Sub-Issue

#### `POST /issues/:issueId/sub-issues`
**Not yet implemented.**

Agent creates a sub-issue (delegation).

Request:
```json
{
  "title": "Write unit tests for WebSocket reconnection",
  "description": "...",
  "assignee_id": "uuid",
  "priority": "high"
}
```

`project_id` is inherited from the parent issue. `assignee_id` is required. If
`assignee_id` is set to an agent outside the creating agent's delegation scope,
the request fails. Agents can delegate to peers (same level in the org chart) or downward.

---

### Get Context

#### `GET /context`
**Not yet implemented.**

Agent retrieves its full operational context in one call. Convenience endpoint
that combines heartbeat data with system prompt, resolved variables, and org
chart position.

Response:
```json
{
  "data": {
    "agent": {
      "id": "uuid",
      "title": "Dev Engineer",
      "system_prompt_resolved": "You are the **Dev Engineer** at NoteGenius AI...",
      "reports_to": { "id": "uuid", "title": "CTO" },
      "direct_reports": [],
      "budget_remaining_cents": 1200
    },
    "company": {
      "id": "uuid",
      "name": "NoteGenius AI",
      "description": "Build the #1 AI note-taking app"
    },
    "assigned_issues": [...],
    "available_secrets": ["GITHUB_TOKEN", "NPM_TOKEN"],
    "mcp_servers": [
      { "name": "slack", "url": "https://mcp.slack.com/sse", "description": "Team Slack" },
      { "name": "db", "url": "stdio://npx -y @modelcontextprotocol/server-postgres", "description": "Project database" }
    ],
    "mpp_enabled": true,
    "kb_docs": [
      { "id": "uuid", "title": "Coding Standards", "slug": "coding-standards", "updated_at": "..." }
    ],
    "company_preferences": {
      "id": "uuid",
      "content": "## Code Architecture\n- Prefer functional patterns...",
      "updated_at": "..."
    },
    "project_docs": [
      { "filename": "spec.md", "path": ".dev/spec.md" }
    ],
    "peers": [
      { "id": "uuid", "title": "UI Designer", "status": "active" }
    ]
  }
}
```

---

### Company Preferences (agent-side)

#### `GET /company-preferences`
Agent reads the company preferences document for its company.

Response: full preferences object including `content`.

#### `POST /company-preferences/update`
**Not yet implemented.**

Agent updates the company preferences document. No approval required. Creates a
revision automatically. Auto-creates the preferences document if it doesn't exist.

Request:
```json
{
  "content": "## Code Architecture\n- Prefer functional patterns over class-based...",
  "change_summary": "Observed preference for functional patterns in board feedback on issue ACME-42"
}
```

Response:
```json
{
  "data": {
    "id": "uuid",
    "revision_number": 4,
    "updated_at": "..."
  }
}
```

---

### Project Documents (agent-side)

Agents access project documents through the same board endpoints (scoped to their company). Project docs are file-based — stored as `.dev/*.md` files in the designated repo worktree. See the board-side Project Documents section for endpoint details.

Agent writes to `prd.md` create an approval request instead of writing the file directly.

---

### Knowledge Base (agent-side)

#### `GET /kb-docs`
**Not yet implemented.**

Agent lists all knowledge base documents for its company.

Response: array of doc metadata (same shape as board list, without content).

#### `GET /kb-docs/:docId`
**Not yet implemented.**

Agent reads a full knowledge base document.

Response: full doc object including `content`.

#### `POST /kb-docs/propose-update`
**Not yet implemented.**

Agent proposes a new document or an edit to an existing document. Creates a
`kb_update` approval with a diff.

Request (new doc):
```json
{
  "title": "Error Handling Patterns",
  "content": "# Error Handling Patterns\n\n## API Errors\n...",
  "reason": "Established consistent error handling during WebSocket implementation"
}
```

Request (edit existing):
```json
{
  "doc_id": "uuid",
  "content": "# Coding Standards\n\n## Updated with new patterns...",
  "reason": "Added React Server Components conventions after frontend refactor"
}
```

Response:
```json
{
  "data": {
    "approval_id": "uuid",
    "status": "pending"
  }
}
```

The board sees the proposal in the approval inbox as a diff view (for edits)
or a full preview (for new docs). On approval, the document is created/updated.

#### `POST /plans/submit-for-review`
**Not yet implemented.**

Agent (typically Architect) submits an implementation plan for Product Lead
review. Creates a `plan_review` approval.

Request:
```json
{
  "issue_id": "uuid",
  "plan_summary": "Implementation plan for WebSocket auth...",
  "plan_content": "## PRD\n...\n## Technical Spec\n...\n## Phases\n...",
  "reason": "Ready for Product Lead review before dev work begins"
}
```

Response:
```json
{
  "data": {
    "approval_id": "uuid",
    "status": "pending"
  }
}
```

The Product Lead (or any board member) reviews the plan in the approval inbox.
On approval, the Engineer can begin implementation.

#### `POST /issues/:issueId/attachments`
**Not yet implemented.**

Agent uploads a file attachment to an issue (screenshot, log, diagram, etc.).
Multipart form data, same constraints as the board endpoint.

---

## WebSocket (real-time updates)

### `WS /ws`

Single WebSocket endpoint. Clients connect to `/ws` on the server (upgraded from HTTP). Auth via user JWT or agent JWT.

### Room-based subscriptions

After connecting, clients subscribe to rooms:

```json
{ "action": "subscribe", "room": "company:<uuid>" }
{ "action": "subscribe", "room": "container-logs:<projectId>" }
{ "action": "subscribe", "room": "project-runs:<projectId>" }
{ "action": "unsubscribe", "room": "company:<uuid>" }
```

Room types:
- `company:<uuid>` — receives row changes, chat messages, and agent lifecycle events for the company. Access is verified (agents/API keys must match company; board users must be members or superusers).
- `container-logs:<projectId>` — streams Docker container stdout/stderr for a project's main process.
- `project-runs:<projectId>` — streams `run_log` messages from every agent `docker exec` on that project. Clients filter by `runId` to isolate a specific run.

Room names always use UUIDs, never slugs. The frontend `useWebSocket` hook takes two params: the UUID for room subscription and the route-param slug for TanStack Query cache invalidation.

### Server message types

Defined in `@hezo/shared` as the `WsMessageType` enum:

| Type | Description | Payload |
|------|-------------|---------|
| `connected` | Sent on initial connection | — |
| `row_change` | Database row changed | `{ type, table, action, row }` where `action` is `INSERT`, `UPDATE`, or `DELETE` |
| `chat_message` | Live chat message | `{ type, issueId, message: { id, chatId, authorMemberId, authorType, content, createdAt } }` |
| `agent_lifecycle` | Agent status change | `{ type, memberId, status }` |
| `container_log` | Container stdout/stderr stream | `{ type, projectId, stream, text }` where `stream` is `stdout` or `stderr` |
| `run_log` | Agent run stdout/stderr (streaming `docker exec` output plus worktree-prep steps and the invocation line) | `{ type, projectId, runId, issueId, stream, text }` |
| `error` | Error message | `{ type, code, message }` |

### Client action types

Defined in `@hezo/shared` as the `WsClientAction` enum:

| Action | Description | Payload |
|--------|-------------|---------|
| `subscribe` | Subscribe to a room | `{ action, room }` |
| `unsubscribe` | Unsubscribe from a room | `{ action, room }` |
| `chat` | Send a chat message | `{ action, issueId, content, mentions? }` |

Note: The `chat` action is defined in the shared types but not currently handled by the WebSocket server. Chat messages are sent via the REST endpoint `POST /companies/:companyId/issues/:issueId/chat/messages` and broadcast to subscribers via `chat_message` events.

### Cache invalidation

`RowChange` messages trigger TanStack Query cache invalidation on the client. The frontend maps table names to query cache keys and calls `invalidateQueries`, causing affected queries to refetch. This provides real-time UI updates without requiring the server to push full data payloads.

`heartbeat_runs` row-change broadcasts carry a minimal `{ id, issue_id, company_id, member_id, status }` payload — enough to route cache invalidation without leaking per-run logs or shell args. They are emitted on run INSERT (status transitions to `running`) and on the terminal UPDATE only; mid-run log flushes are not broadcast. The client maps `heartbeat_runs` row changes to invalidate the issues list query so the assignee running indicator updates in real time.

### Server-side broadcasting

The server uses `broadcastChange()` for row-level changes and `broadcastEvent()` for typed events. Both broadcast to all subscribers of the relevant room (identified by UUID).

---

## Audit Log Actions Reference

Every mutating operation writes to `audit_log`. Standard action names:

| Action | Entity Type | Trigger |
|--------|-------------|---------|
| `company.created` | company | Board creates company |
| `company.updated` | company | Board updates company |
| `company.deleted` | company | Board deletes company |
| `company.cloned` | company | Board clones company |
| `connection.created` | connected_platform | Board connects platform via OAuth |
| `connection.refreshed` | connected_platform | System or board refreshes token |
| `connection.expired` | connected_platform | System detects expired token |
| `connection.disconnected` | connected_platform | Board disconnects platform |
| `agent.created` | agent | Board hires or approval resolved |
| `agent.updated` | agent | Board edits agent config |
| `agent.disabled` | agent | Board disables agent |
| `agent.resumed` | agent | Board resumes |
| `agent.terminated` | agent | Board terminates |
| `company.container_rebuilt` | company | Board rebuilds company container |
| `project.created` | project | Board creates project |
| `project.updated` | project | Board updates project |
| `project.deleted` | project | Board deletes project |
| `repo.added` | repo | Board adds repo to project |
| `repo.removed` | repo | Board removes repo |
| `issue.created` | issue | Board or agent creates issue |
| `issue.updated` | issue | Board or agent updates issue |
| `issue.assigned` | issue | Issue assigned to agent or board member |
| `issue.closed` | issue | Status changed to closed |
| `comment.created` | issue_comment | Board or agent posts comment |
| `option.chosen` | issue_comment | Board picks an option |
| `secret.created` | secret | Board creates secret |
| `secret.updated` | secret | Board rotates secret value |
| `secret.deleted` | secret | Board deletes secret |
| `secret.granted` | secret_grant | Board grants access |
| `secret.revoked` | secret_grant | Board revokes access |
| `secret.requested` | approval | Agent requests secret access |
| `hire.requested` | approval | Agent requests hire |
| `approval.approved` | approval | Board approves |
| `approval.denied` | approval | Board denies |
| `api_key.created` | api_key | Board generates API key |
| `api_key.revoked` | api_key | Board revokes API key |
| `kb_doc.created` | kb_doc | Board or agent (via approval) |
| `kb_doc.updated` | kb_doc | Board or agent (via approval) |
| `kb_doc.deleted` | kb_doc | Board deletes |
| `kb_update.proposed` | approval | Agent proposes KB change |
| `kb_update.approved` | approval | Board approves KB change |
| `kb_update.denied` | approval | Board denies KB change |
| `company_preferences.updated` | company_preferences | Board or agent updates preferences |
| `project_doc.created` | project_doc | Board or agent creates project doc |
| `project_doc.updated` | project_doc | Board or agent updates project doc |
| `project_doc.deleted` | project_doc | Board deletes project doc |
| `live_chat.message` | live_chat | Message sent in persistent live chat |
| `budget.warning` | agent | Agent hits 80% budget |
| `budget.exceeded` | agent | Agent hits 100% budget |
| `budget.reset` | agent | Monthly budget reset |

---

## MCP Endpoint

Hezo exposes an MCP (Model Context Protocol) endpoint for external AI agents to discover and invoke Hezo operations programmatically.

### `POST /mcp`

Streamable HTTP MCP endpoint. Uses `@modelcontextprotocol/sdk` with the `McpServer` class. Supports bidirectional messaging with optional Server-Sent Events (SSE) for streaming responses.

**Authentication:** Same as REST API — user JWT, or API key (`Authorization: Bearer hezo_<key>`). Agent runs authenticate with a per-run JWT (`signAgentJwt`) whose `run_id` claim binds it to a single `heartbeat_runs` row. The server rejects the token once that run's status is no longer `running`.

**How agent sessions reach this endpoint:** the runner builds an MCP config
per run and passes it to Claude Code via the `--mcp-config <json>` flag (plus
`--strict-mcp-config` so no ambient `~/.claude.json` leaks). The config points
at `http://host.docker.internal:<serverPort>/mcp` and carries
`Authorization: Bearer <agent-jwt>` as a header. The flag is only set for the
`claude_code` runtime; other runtimes keep their current non-MCP behaviour.

**Capabilities:**
- `tools` — Hezo registers all operations as MCP tools
- `listChanged` — tool list can change dynamically (e.g. when plugins register new tools)

**Registered tools:**

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_companies` | List accessible companies | — |
| `get_company` | Get company by ID | `company_id` |
| `create_company` | Create a new company (superuser only) | `name`, `description` |
| `list_issues` | List issues with filtering | `company_id`, `project_id?`, `status?` |
| `get_issue` | Get issue details | `company_id`, `issue_id` |
| `create_issue` | Create a new issue | `company_id`, `project_id`, `title`, `assignee_id` or `assignee_slug`, `description?`, `priority?` |
| `update_issue` | Update an issue | `company_id`, `issue_id`, `status?`, `priority?`, `assignee_id?`, `progress_summary?`, `rules?`, `branch_name?` |
| `list_agents` | List agents in a company | `company_id` |
| `list_projects` | List projects | `company_id` |
| `create_project` | Create a project | `company_id`, `name` |
| `list_comments` | List issue comments | `company_id`, `issue_id` |
| `create_comment` | Add comment to issue | `company_id`, `issue_id`, `content`, `content_type?` |
| `list_approvals` | List pending approvals | `company_id` |
| `resolve_approval` | Resolve an approval | `company_id`, `approval_id`, `status` (`approved`/`denied`), `resolution_note?` |
| `list_kb_docs` | List knowledge base documents | `company_id` |
| `get_kb_doc` | Get KB doc by slug | `company_id`, `slug` |
| `upsert_kb_doc` | Create or update a KB document | `company_id`, `slug`, `title`, `content` |
| `get_costs` | Get cost summary | `company_id`, `group_by?` (`agent`/`project`/`day`) |
| `get_agent_system_prompt` | Read agent's system prompt | `company_id`, `agent_id` |
| `propose_system_prompt_update` | Propose or auto-apply system prompt change | `company_id`, `agent_id`, `system_prompt`, `reason` |
| `list_project_docs` | List project docs | `company_id`, `project_id` |
| `read_project_doc` | Read project doc by filename | `company_id`, `project_id`, `filename` |
| `write_project_doc` | Write project doc | `company_id`, `project_id`, `filename`, `content` |
| `propose_skill` | Create approval for new skill | `company_id`, `name`, `content`, `description?` |
| `semantic_search` | Natural language search | `company_id`, `query`, `scope?` (`all`/`kb_docs`/`issues`/`skills`/`project_docs`), `limit?` |
| `list_skills` | List active skills | `company_id`, `tags?` |
| `get_skill` | Get skill by slug | `company_id`, `slug` |
| `create_skill` | Create skill directly | `company_id`, `name`, `content`, `description?` |
| `set_agent_summary` | Set an agent's auto-generated description | `company_id`, `agent_id`, `summary` (≤1000 chars) |
| `set_team_summary` | Set the team collaboration description (CEO only) | `company_id`, `summary` (≤4000 chars) |

MCP tools call the same business logic layer as REST endpoints.

### Description-update issue convention

To trigger runtime regeneration of agent and team descriptions, the system
creates an issue with the `description-update` label in the Operations project,
assigned to the CEO agent. The CEO processes this issue by calling
`set_agent_summary` for each agent and `set_team_summary` for the company,
then marks the issue done.

---

## Skill File

### `GET /skill.md`

Returns a Markdown document that teaches external AI agents how to interact with Hezo. This is the primary onboarding mechanism for AI-to-AI integration.

**Response:** `Content-Type: text/markdown`

The skill file is dynamically generated at startup from the registered MCP tool definitions and includes:
- Overview of Hezo and its purpose
- Available MCP tools with parameter schemas and descriptions
- Common workflows (create issue → assign agent → monitor → approve)
- REST API endpoint summary (fallback for agents without MCP support)
- Authentication setup instructions (API key creation)
- Example interactions

The same content is also committed to the repo at `SKILL.md` in the project root for local agent discovery.
