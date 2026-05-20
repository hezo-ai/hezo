# Onboarding UX — code review follow-ups

Review of commit `cf3b035` (`feat: add home onboarding flow and rename CEO to Captain`) on branch `onboarding-ux-improvements`. Items are ordered by priority.

---

## High priority

### 1. MCP `resolve_approval` does not run side effects

REST `POST /approvals/:approvalId/resolve` calls `applyApprovalSideEffect` (provision agents, close hire ticket, etc.). MCP `resolve_approval` only updates the approval row and broadcasts the approval — **no provisioning, no hire-team close**.

**Location:** `packages/server/src/mcp/tools.ts` (`resolve_approval` handler)

**Suggestion:** Extract shared `resolveApproval(db, approvalId, status, …)` used by REST and MCP, or call `applyApprovalSideEffect` from MCP when status is `approved` (with the same side-effect broadcasts as the REST route).

---

### 2. Inbox UI has no `team_template` approval copy

`ApprovalCard` has no `ApprovalType.TeamTemplate` branch; it falls through to the default label (`team template`). Stage 2 depends on inbox approval, so this should be explicit.

**Location:** `packages/web/src/components/approval-card.tsx`

**Suggestion:** Add a dedicated case similar to hire:

- Template name and rationale from payload
- Link to hire-team Operations issue when `issue_id` / identifier is available
- List roles from `payload.roles`

Also add `team_template` to `typeColors` for consistent badge styling.

---

### 3. `confirmProjectExecutionStart` does not broadcast project updates

`POST /api/teams/:teamId/onboarding/start-project` sets `execution_started_at` but does not broadcast a `projects` UPDATE. Home onboarding progress relies on WebSocket invalidation of `['teams', slug, 'onboarding']`, which only happens when a `projects` row change is observed (or the client refetches).

**Location:** `packages/server/src/services/onboarding.ts`, `packages/server/src/routes/teams.ts`

**Suggestion:** Broadcast `projects` UPDATE from the route (or pass `wsManager` into `confirmProjectExecutionStart`) so the progress bar and project list update immediately after **Start project**.

---

### 4. Template provisioning is not transactional

`provisionTeamTemplate` inserts many agents in a loop without `BEGIN`/`COMMIT`. A mid-loop failure can leave a **partial team** while the approval is already resolved.

**Location:** `packages/server/src/services/team-template-provision.ts`

**Suggestion:** Wrap provisioning, `reports_to` updates, and `team_template_assignments` in one transaction. On failure, return an error and avoid leaving the approval in an inconsistent resolved state (or roll back resolution in the route).

---

### 5. Denied template approval after “setting up” ack

On the approve path, `postHireTeamTemplateApprovedAck` runs **before** provisioning. If resolution fails or the board denies in an edge case, the hire ticket may already say “I'm setting up the team.”

**Location:** `packages/server/src/routes/approvals.ts`, `packages/server/src/services/hire-team-intake.ts`

**Suggestion:** Either move the ack comment to after successful provision, or post a follow-up comment on deny (“Template approval was not applied”) and leave the hire issue open for the Captain to recover.

---

## Medium priority

### 6. Duplicated intake / team context helpers

`loadTeamContext`, open-intake queries (terminal-status SQL), and Captain lookups are duplicated across `requirements-intake.ts`, `hire-team-intake.ts`, and `goal-tickets.ts`.

**Suggestion:** Introduce a small shared module (e.g. `operations-intake.ts`) with `loadCaptainOpsContext`, `findOpenLabeledIssue`, and use `terminalStatusParams` consistently.

---

### 7. `onboarding.agents` is unused on the client

`getOnboardingStatus` still queries agents (excluding Captain/Coach), but the start panel uses `useOrgChart` instead.

**Location:** `packages/server/src/services/onboarding.ts`, `packages/web/src/components/onboarding-start-panel.tsx`

**Suggestion:** Remove `agents` from the API response, or use it as a fallback when the org chart is empty, to avoid extra queries and API surface drift.

---

### 8. Home page is single-team only

`primaryTeamSlug = teams[0]?.slug` drives onboarding, intake panels, and the start-project panel. Users in multiple teams always see the first team’s onboarding state.

**Location:** `packages/web/src/routes/home/index.tsx`

**Suggestion:** Tie onboarding to the active team (rail selection or last-used team), or document explicitly that onboarding is first-team-only until multi-team onboarding exists.

---

### 9. `.dev/api.md` missing new endpoints

New routes are not documented:

- `GET /api/teams/:teamId/onboarding`
- `POST /api/teams/:teamId/onboarding/start-project`
- `GET /api/teams/:teamId/requirements-intake` (`?ensure=true`)
- `GET /api/teams/:teamId/hire-team-intake`
- `projects.execution_started_at` semantics

**Suggestion:** Add a “Board onboarding” section describing stage semantics and each endpoint (per AGENTS.md: `.dev/` describes what the system does).

---

### 10. No E2E for onboarding UX

Integration tests cover stage machine, deferred planning wakeup, and template approval. There are no Playwright specs for the home progress bar, Captain chat panels, org chart tooltips, or **Start project**.

**Suggestion:** Add at least one mobile e2e: new team → requirements panel visible → (seed/mock) stage 3 → confirm start → projects list appears.

---

### 11. Org chart UI duplicated

`OnboardingOrgChart` and `packages/web/src/routes/teams/$teamId/agents/index.tsx` share tree layout and `useAutoFit`.

**Suggestion:** Extract `OrgChartTree` with props such as `interactive` (links vs tooltips), `showBoardRoot`, and `renderNode`.

---

## Low priority / polish

| Item | Note |
|------|------|
| **`isFirstUserFacingProject` race** | Two concurrent first `create_project` calls could both see count `0` and both defer planning wakeups. Rare; fix with transactional count or an explicit onboarding flag on the team/project. |
| **Coach slug** | `onboarding.ts` uses literal `'coach'`; prefer `COACH_AGENT_SLUG` from `@hezo/shared`. |
| **Tooltip on mobile** | Org chart copy says “hover a role”; touch devices need tap-to-open or always-visible hints on small screens. |
| **Hook lint suppressions** | `biome-ignore` on `useExhaustiveDependencies` in `captain-intake-chat.tsx` and `use-websocket.ts` is acceptable short-term; prefer `lastMessageId` / stable keys for scroll and room subscription long-term. |
| **Monolithic commit** | Fine for local WIP; for GitHub review, stacked PRs (rename → backend onboarding → UI) would be easier to review. |
| **`implementation-phases.md`** | Confirm phase completion dates and scope match what this branch actually ships. |

---

## What’s working well (no change required)

- **Stage logic** — Hire stage stays pending until requirements intake is done.
- **`createProjectWithPlanningIssue`** — Transaction for project + planning issue.
- **Deferred planning wakeup** — `isFirstUserFacingProject` + `confirmProjectExecutionStart` with tests.
- **Hire-team completion** — Server posts completion comment, marks issue `done`, broadcasts updates.
- **Realtime** — Approval broadcasts, MCP insert broadcasts, `invalidateTeamAgentCaches` for rail/org chart.
- **CEO → Captain rename** — Constants, seeds, tests, and docs are largely aligned.

---

## Suggested implementation order

1. MCP `resolve_approval` side effects (functional gap for agent-resolved approvals).
2. `ApprovalType.TeamTemplate` inbox copy.
3. WebSocket broadcast on `start-project`.
4. Document onboarding APIs in `.dev/api.md`.
5. Transactional `provisionTeamTemplate`.
6. Shared operations-intake helpers + org chart component extraction.
7. E2E happy path (mobile home onboarding).
