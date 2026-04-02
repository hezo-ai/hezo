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

### Board — User JWT
Stateless JWT signed with the master key. Issued after GitHub/GitLab OAuth login.
Required for all human users. No session cookies.

```
Authorization: Bearer <user_jwt>
```

User JWTs contain:
```json
{ "user_id": "...", "email": "...", "iat": ..., "exp": ... }
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
Per-agent bearer token issued at agent creation.

```
Authorization: Bearer <agent_jwt>
```

Agent tokens are JWTs signed with the master key (held in memory, never on disk),
containing:
```json
{ "member_id": "...", "company_id": "...", "iat": ..., "exp": ... }
```

`member_id` is the agent's ID in the members table (same as agent_id).

---

## Board API (Web UI)

### Permission enforcement

All Board API endpoints check the caller's membership role:

| Access Level | Endpoints |
|-------------|-----------|
| **Board-only** (member_users with role='board') | Company settings, agent management (hire/fire/pause/resume/terminate), budget adjustments, secrets vault, API keys, connected platforms, audit log, plugin management, invites, member management |
| **All members** (agents and users, scoped by `project_ids`) | Issues, comments, live chat, KB (read), project docs (read), inbox (filtered), notification preferences |

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
      "mission": "Build the #1 AI note-taking app",
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
Create a company. Optionally clone from a company type.

Request:
```json
{
  "name": "NoteGenius AI",
  "mission": "Build the #1 AI note-taking app",
  "company_type_id": "uuid | null"
}
```

`company_type_id` is optional. When set, the new company is seeded from the matching company type with:
- All knowledge base documents
- All agent configurations (titles, prompts, org chart, runtimes, budgets)
- Company-level MCP server config
- MPP config structure (wallet keys must be set up fresh)

Cloning does NOT copy: projects, repos, issues, secrets, costs, audit log, API keys.

Response: full company object. On creation, the server automatically:

1. Creates `~/.hezo/companies/{slug}/` folder structure with auto-generated AGENTS.md.
2. Creates a **full agent team** from built-in templates: CEO, Architect, Product Lead, Engineer, QA Engineer, UI Designer, Researcher, DevOps Engineer (starts idle), Marketing Lead (or cloned agents if cloning from a company type).
3. Creates a **"Setup" project** with an onboarding issue assigned to the CEO:
   *"Set up repository access — configure deploy keys for connected GitHub account."*
4. Generates an SSH key pair for the company and registers it on the connected GitHub account.

Docker container provisioning happens when the first project is created, not at company creation.

The UI then prompts the owner to connect platforms via OAuth (Hezo Connect):
- **GitHub** (required) — for repo access, PRs, Actions
- **Gmail** (recommended) — for agent email
- Other platforms optional: Stripe, PostHog, Railway, Vercel, DigitalOcean, X, GitLab

Connections can be added or removed later in company settings.
The board lands on a company with 9 agents and one actionable issue.

#### `GET /companies/:companyId`
Get company detail.

Response: full company object with summary stats (same shape as list item).

#### `PATCH /companies/:companyId`
Update company config.

Request:
```json
{
  "name": "NoteGenius AI",
  "mission": "Updated mission statement",
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

### Agents

#### `GET /companies/:companyId/agents`
List agents for a company.

Query params: `?status=active,idle`

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
      "runtime_type": "claude_code",
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
  "runtime_type": "claude_code",
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

#### `GET /companies/:companyId/agents/:agentId`
Get agent detail including system prompt.

Response: full agent object (same as list item + `system_prompt` + `mcp_servers` fields).

#### `PATCH /companies/:companyId/agents/:agentId`
Update agent config: title, role_description, system_prompt, heartbeat_interval_min,
monthly_budget_cents, reports_to, mcp_servers.

Cannot update: status (use lifecycle endpoints), budget_used_cents (system-managed).

#### `POST /companies/:companyId/agents/:agentId/pause`
Pause an agent. Stops heartbeats, kills subprocess if running. Does not affect the company container.

#### `POST /companies/:companyId/agents/:agentId/resume`
Resume a paused agent.

#### `POST /companies/:companyId/agents/:agentId/terminate`
Terminate an agent. Kills the agent's subprocess. Unassigns all issues.
Agent record is kept for audit trail (status = `terminated`).

#### `POST /companies/:companyId/projects/:projectId/rebuild-container`
Tear down and rebuild the project's Docker container. Kills all agent subprocesses
in this project, destroys the container, provisions a new one. Useful when base
image or dependency config changes. All agents keep their identity and config.

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
          "status": "active",

          "children": [
            {
              "id": "uuid",
              "title": "CTO",
              "status": "idle",
    
              "children": [
                { "id": "uuid", "title": "Dev Engineer", "status": "active", "container_status": "running", "children": [] },
                { "id": "uuid", "title": "UI Designer", "status": "active", "container_status": "running", "children": [] }
              ]
            },
            {
              "id": "uuid",
              "title": "CMO",
              "status": "paused",
    
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
      "goal": "Ship collaboration features",
      "repo_count": 2,
      "open_issue_count": 5,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/projects`
Create a project.

Request:
```json
{
  "name": "Backend API",
  "goal": "Ship collaboration features"
}
```

#### `GET /companies/:companyId/projects/:projectId`
Get project detail including repos.

Response: project object + `repos` array.

#### `PATCH /companies/:companyId/projects/:projectId`
Update name, goal.

#### `DELETE /companies/:companyId/projects/:projectId`
Delete project. Fails if there are open issues referencing it.

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

#### `DELETE /companies/:companyId/projects/:projectId/repos/:repoId`
Remove a repo from a project.

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

#### `POST /companies/:companyId/issues`
Create an issue.

Request:
```json
{
  "project_id": "uuid",
  "title": "Implement WebSocket handler for real-time sync",
  "description": "We need a WebSocket handler that supports...",
  "assignee_id": "uuid | null",
  "parent_issue_id": "uuid | null",
  "priority": "urgent",
  "labels": ["backend", "collab"]
}
```

`project_id` is required (enforced). `number` is auto-assigned via
`next_issue_number()`. If `assignee_id` is set to an agent, the agent receives
an event trigger. If set to a board member, they are notified via inbox and
configured messaging channels.

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
    "company_mission": "Build the #1 AI note-taking app",
    "assignee_id": "uuid",
    "assignee_name": "Dev Engineer",
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
Update issue fields: title, description, status, priority, assignee_id, labels.

Changing `assignee_id` triggers an event on the newly assigned agent, or a notification to the newly assigned board member.
Changing `status` to `done` or `closed` triggers preview cleanup.

#### `DELETE /companies/:companyId/issues/:issueId`
Delete an issue. Only allowed if status is `open` and no comments exist.

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
      "preview_url": "/preview/company-uuid/project-uuid/agent-uuid/auth-flow-mockup.html",
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
  "content": { "text": "Make sure we handle reconnection gracefully..." }
}
```

`author_type` is always `board` for this endpoint.

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

#### `POST /approvals/:approvalId/resolve`
Approve or deny.

Request:
```json
{
  "status": "approved",
  "resolution_note": "Approved for project scope",
  "grant_scope": "project"
}
```

`grant_scope` is only relevant for `secret_access` approvals. When approved,
the system creates the grant(s) and injects the secret(s) into the agent's
subprocess on next invocation.

For `hire` approvals, approval triggers agent creation.

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
      "details": { "title": "Frontend Engineer", "runtime_type": "claude_code" },
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
      "platform": "gmail",
      "status": "active",
      "scopes": "gmail.send,gmail.readonly",
      "metadata": { "email": "company@gmail.com" },
      "token_expires_at": "...",
      "connected_at": "..."
    }
  ]
}
```

#### `POST /companies/:companyId/connections/:platform/start`
Initiate an OAuth connection. Returns a redirect URL that the UI opens in a
new window/tab for the user to authorize.

`platform` is one of: `github`, `gmail`, `gitlab`, `stripe`, `posthog`,
`railway`, `vercel`, `digitalocean`, `x`.

Response:
```json
{
  "data": {
    "auth_url": "https://connect.hezo.ai/auth/github/start?callback=http://localhost:3100/oauth/callback&state=encrypted_state",
    "state": "encrypted_state_token"
  }
}
```

#### `GET /oauth/callback`
OAuth callback endpoint. The browser is redirected here by Hezo Connect after
the user authorizes and Connect exchanges the auth code for tokens.

This endpoint is not called directly by the UI — it's the browser redirect
target from Hezo Connect.

Query params: `?platform=github&access_token=...&scopes=...&metadata=...&state=...`

On error: `?error=access_denied&platform=github&state=...`

Processing:
1. Verify the `state` parameter signature
2. Extract `company_id` from the state payload
3. Encrypt the access token with the master key, store in `secrets` table
4. Upsert `connected_platforms` row (status=active, token reference, scopes, metadata)
5. Dismiss any existing `oauth_request` inbox items for this company+platform
6. Redirect browser to company settings page with success/failure message

#### `DELETE /companies/:companyId/connections/:connectionId`
Disconnect a platform. Revokes tokens (if the provider supports it), removes
the MCP server registration, and deletes the connection record.

#### `POST /companies/:companyId/connections/:connectionId/refresh`
Force a token refresh. Normally handled automatically, but available for
manual intervention when a connection is in `expired` status.

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

### Previews (proxy)

#### `GET /preview/:companyId/:projectId/:agentId/:filename`
Serves a preview file from the agent's preview directory.

Headers on response:
```
Content-Security-Policy: sandbox allow-scripts
X-Frame-Options: SAMEORIGIN
Cache-Control: no-store
```

Returns 404 if file doesn't exist. Returns 403 if the requesting user doesn't
have board access to the company. Filenames are sanitized (no path traversal).

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
  "content": "# Coding Standards\n\n## TypeScript\n- Always use strict mode..."
}
```

`slug` is auto-derived from the title (lowercased, spaces → hyphens).

#### `GET /companies/:companyId/kb-docs/:docId`
Get full document content.

Response: full doc object including `content` field.

#### `PATCH /companies/:companyId/kb-docs/:docId`
Update a document (board action). Direct edits by the board do not require
approval.

Request:
```json
{
  "title": "Coding Standards",
  "content": "# Coding Standards\n\n## Updated content..."
}
```

#### `DELETE /companies/:companyId/kb-docs/:docId`
Delete a knowledge base document.

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

#### `GET /companies/:companyId/projects/:projectId/docs`
List all project documents.

Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "project_id": "uuid",
      "doc_type": "tech_spec",
      "title": "Technical Specification",
      "slug": "technical-specification",
      "created_by_agent_title": "Architect",
      "last_updated_by_agent_title": "Engineer",
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

#### `GET /companies/:companyId/projects/:projectId/docs/:docId`
Get full project document content.

Response: full doc object including `content` field.

#### `POST /companies/:companyId/projects/:projectId/docs`
Create a project document (board action).

Request:
```json
{
  "doc_type": "tech_spec",
  "title": "Technical Specification",
  "content": "# Technical Specification\n\n## Architecture\n..."
}
```

`slug` is auto-derived from the title. Returns 409 if a document of that type already exists for the project (except `other` type).

#### `PATCH /companies/:companyId/projects/:projectId/docs/:docId`
Update a project document (board action). Creates a revision automatically.

Request:
```json
{
  "content": "# Technical Specification\n\n## Updated...",
  "change_summary": "Updated API section after implementation review"
}
```

#### `DELETE /companies/:companyId/projects/:projectId/docs/:docId`
Delete a project document.

#### `GET /companies/:companyId/projects/:projectId/docs/:docId/revisions`
List revision history for a project document.

Response: same shape as KB doc revisions.

---

### Live Chat

Each issue has a **persistent live chat** — one ongoing conversation per issue, always
available. The assigned agent is always a participant. Board members can @-mention any
other agent to pull them in.

#### `GET /companies/:companyId/issues/:issueId/live-chat`
Get the live chat for this issue (transcript, participants, metadata).
The chat is auto-created when the issue is created — no "start" step needed.

Response:
```json
{
  "data": {
    "id": "uuid",
    "issue_id": "uuid",
    "assigned_agent_id": "uuid",
    "active_agents": ["uuid-architect", "uuid-engineer"],
    "message_count": 24,
    "transcript": [
      { "author": "board:alice", "text": "What auth strategy do you recommend?", "timestamp": "..." },
      { "author": "agent:architect", "text": "For this API-first product, I'd suggest JWT...", "timestamp": "..." },
      { "author": "board:alice", "text": "@engineer can you estimate effort for this?", "timestamp": "..." },
      { "author": "agent:engineer", "text": "JWT with refresh tokens — about 2 phases...", "timestamp": "..." }
    ],
    "created_at": "..."
  }
}
```

Query params:
- `?after=<timestamp>` — only messages after this timestamp (for polling/pagination)
- `?limit=50` — max messages to return (default 50, from most recent)

#### `WS /ws/live-chat/:issueId`
Real-time WebSocket for the issue's live chat. Board members and agents connect
to send and receive messages.

Send a message:
```json
{ "type": "message", "text": "What auth strategy do you recommend?" }
```

@-mention an agent to pull them in:
```json
{ "type": "message", "text": "@architect what do you think about this approach?" }
```

The server detects @-mentions, wakes the mentioned agent immediately, and adds
them to the chat. Messages are appended to the transcript in real time.

Agent tool call notifications:
```json
{ "type": "tool_call", "agent": "engineer", "tool_name": "bash", "status": "success", "summary": "npm test — 42 passed" }
```

---

### File Attachments

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

#### `GET /auth/github`
Initiate GitHub OAuth login. Redirects to Hezo Connect which handles the OAuth flow. On success, creates or updates the user account and returns a signed user JWT.

#### `GET /auth/gitlab`
Initiate GitLab OAuth login. Same flow as GitHub.

#### `GET /auth/callback`
OAuth callback endpoint. Receives tokens from Hezo Connect, creates/updates user, issues a user JWT, redirects to the app with the token.

#### `POST /auth/logout`
End the current session. Client discards the JWT.

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

#### `POST /webhooks/slack`
Receives Slack Events API payloads. Handles interactive messages (approvals), slash commands, and channel messages directed at agents.

#### `POST /webhooks/telegram`
Receives Telegram Bot API webhook updates. Handles bot commands (`/issues`, `/approve`, `/comment`), inline keyboard callbacks, and text messages.

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
        "company_mission": "Build the #1 AI note-taking app",
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

Updates `last_heartbeat_at`. If agent status is `paused` or `terminated`,
response includes `"agent": { "status": "paused" }` and agent should stop
working.

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
    "message": "Agent budget limit reached. Agent has been paused."
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

### Request Hire

#### `POST /agents/request-hire`
Agent (e.g. CTO) requests to hire a new agent. Creates a pending approval.

Request:
```json
{
  "title": "QA Engineer",
  "role_description": "Automated test coverage",
  "system_prompt": "You are the QA Engineer at {{company_name}}...",
  "reports_to": "self",
  "runtime_type": "claude_code",
  "heartbeat_interval_min": 120,
  "monthly_budget_cents": 2500,
  "reason": "We need automated test coverage before the collab feature ships."
}
```

`"reports_to": "self"` means the new agent will report to the requesting agent.

---

### Create Sub-Issue

#### `POST /issues/:issueId/sub-issues`
Agent creates a sub-issue (delegation).

Request:
```json
{
  "title": "Write unit tests for WebSocket reconnection",
  "description": "...",
  "assignee_id": "uuid | null",
  "priority": "high"
}
```

`project_id` is inherited from the parent issue. If `assignee_id` is set to an
agent outside the creating agent's delegation scope, the request fails. Agents
can delegate to peers (same level in the org chart) or downward.

---

### Get Context

#### `GET /context`
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
      "mission": "Build the #1 AI note-taking app"
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
      { "id": "uuid", "doc_type": "tech_spec", "title": "Technical Specification", "project_id": "uuid", "project_name": "Main App", "updated_at": "..." }
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

#### `GET /project-docs?project_id=uuid`
Agent lists project documents for a given project. If `project_id` is omitted,
returns documents for the project of the agent's current issue.

Response: array of doc metadata (same shape as board list, without content).

#### `GET /project-docs/:docId`
Agent reads a full project document.

Response: full doc object including `content`.

#### `POST /project-docs`
Agent creates a project document.

Request:
```json
{
  "project_id": "uuid",
  "doc_type": "tech_spec",
  "title": "Technical Specification",
  "content": "# Technical Specification\n\n## Architecture\n..."
}
```

Response:
```json
{
  "data": {
    "id": "uuid",
    "slug": "technical-specification",
    "created_at": "..."
  }
}
```

Returns 409 if a document of that type already exists for the project (except `other` type).

#### `PATCH /project-docs/:docId`
Agent updates a project document. No approval required. Creates a revision automatically.

Request:
```json
{
  "content": "# Technical Specification\n\n## Updated...",
  "change_summary": "Updated API section to reflect implemented endpoint structure"
}
```

Response:
```json
{
  "data": {
    "id": "uuid",
    "revision_number": 3,
    "updated_at": "..."
  }
}
```

---

### Knowledge Base (agent-side)

#### `GET /kb-docs`
Agent lists all knowledge base documents for its company.

Response: array of doc metadata (same shape as board list, without content).

#### `GET /kb-docs/:docId`
Agent reads a full knowledge base document.

Response: full doc object including `content`.

#### `POST /kb-docs/propose-update`
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
Agent uploads a file attachment to an issue (screenshot, log, diagram, etc.).
Multipart form data, same constraints as the board endpoint.

---

## WebSocket (real-time updates)

### `WS /ws`
Board UI connects to receive real-time updates. Auth via user JWT or agent JWT.

Server pushes events:

```json
{ "type": "comment.created", "company_id": "...", "issue_id": "...", "comment": {...} }
{ "type": "issue.updated", "company_id": "...", "issue": {...} }
{ "type": "agent.status_changed", "company_id": "...", "agent_id": "...", "status": "active" }
{ "type": "approval.created", "company_id": "...", "approval": {...} }
{ "type": "approval.resolved", "company_id": "...", "approval": {...} }
{ "type": "agent.heartbeat", "company_id": "...", "agent_id": "...", "last_heartbeat_at": "..." }
{ "type": "budget.warning", "company_id": "...", "agent_id": "...", "percent_used": 80 }
{ "type": "budget.exceeded", "company_id": "...", "agent_id": "...", "agent_title": "CMO" }
{ "type": "live_chat.message", "company_id": "...", "issue_id": "...", "author": "board:alice", "text": "..." }
{ "type": "kb_doc.updated", "company_id": "...", "doc_id": "...", "title": "..." }
{ "type": "company_preferences.updated", "company_id": "...", "updated_by_agent_id": "..." }
{ "type": "project_doc.created", "company_id": "...", "project_id": "...", "doc_id": "...", "doc_type": "tech_spec", "title": "..." }
{ "type": "project_doc.updated", "company_id": "...", "project_id": "...", "doc_id": "...", "title": "..." }
{ "type": "project_doc.deleted", "company_id": "...", "project_id": "...", "doc_id": "..." }
{ "type": "connection.created", "company_id": "...", "platform": "github", "status": "active" }
{ "type": "connection.expired", "company_id": "...", "platform": "gmail" }
{ "type": "connection.disconnected", "company_id": "...", "platform": "stripe" }
{ "type": "plan_review.submitted", "company_id": "...", "issue_id": "...", "approval_id": "..." }
{ "type": "plan_review.approved", "company_id": "...", "issue_id": "...", "approval_id": "..." }
{ "type": "plan_review.denied", "company_id": "...", "issue_id": "...", "approval_id": "..." }
```

Client can filter by company_id after connecting (send
`{ "subscribe": ["company-uuid-1", "company-uuid-2"] }`).

In addition to system events, the WebSocket delivers row-level diffs for TanStack DB sync. Each diff message contains the table name, row ID, and changed fields, enabling optimistic UI updates without full refetches.

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
| `agent.paused` | agent | Board pauses or budget exceeded |
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

**Authentication:** Same as REST API — user JWT, or API key (`Authorization: Bearer hezo_<key>`).

**Capabilities:**
- `tools` — Hezo registers all operations as MCP tools
- `listChanged` — tool list can change dynamically (e.g. when plugins register new tools)

**Registered tools:**

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_companies` | List all companies | — |
| `create_company` | Create a new company | `name`, `mission` |
| `list_issues` | List issues with filtering | `company_id`, `project_id?`, `status?`, `assignee?` |
| `create_issue` | Create a new issue | `company_id`, `project_id`, `title`, `description?`, `priority?` |
| `update_issue` | Update an issue | `issue_id`, `status?`, `assignee?`, `priority?` |
| `list_agents` | List agents in a company | `company_id` |
| `hire_agent` | Create a new agent | `company_id`, `title`, `role_description`, `reports_to?` |
| `post_comment` | Post a comment on an issue | `issue_id`, `content`, `content_type?` |
| `list_comments` | List comments on an issue | `issue_id` |
| `approve_request` | Approve a pending approval | `approval_id`, `scope?` |
| `deny_request` | Deny a pending approval | `approval_id`, `reason?` |
| `list_approvals` | List pending approvals | `company_id`, `type?` |
| `search_kb` | Search knowledge base documents | `company_id`, `query` |
| `update_kb_doc` | Create or update a KB document | `company_id`, `slug`, `title`, `content` |
| `get_cost_summary` | Get cost breakdown | `company_id`, `group_by?` |
| `list_projects` | List projects in a company | `company_id` |
| `list_secrets` | List secret names (not values) | `company_id`, `project_id?` |

MCP tools call the same business logic layer as REST endpoints. Additional tools are registered dynamically when plugins are activated.

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
