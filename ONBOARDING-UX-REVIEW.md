# Onboarding UX — code review follow-ups

Review of commit `cf3b035` (`feat: add home onboarding flow and rename CEO to Captain`) on branch `onboarding-ux-improvements`.

**Status:** Addressed in follow-up commits on this branch (see implementation order below).

---

## High priority

### 1. MCP `resolve_approval` does not run side effects — **Done**

Shared `resolveApproval()` in `packages/server/src/services/approval-resolve.ts`; MCP and REST both call it with the same side-effect broadcasts.

### 2. Inbox UI has no `team_template` approval copy — **Done**

`ApprovalCard` includes `ApprovalType.TeamTemplate` with template name, rationale, roles, and hire-ticket link.

### 3. `confirmProjectExecutionStart` does not broadcast project updates — **Done**

Broadcasts `projects` UPDATE via WebSocket when execution starts.

### 4. Template provisioning is not transactional — **Done**

`provisionTeamTemplate` wraps agent inserts, `reports_to`, assignments, and KB docs in `BEGIN`/`COMMIT`.

### 5. Denied template approval after “setting up” ack — **Done**

Ack comment runs after successful provision; deny posts Captain note on hire ticket via `postHireTeamTemplateDeniedNote`.

---

## Medium priority

### 6. Duplicated intake / team context helpers — **Done**

`packages/server/src/services/operations-intake.ts` with `loadCaptainOpsContext` and `findOpenLabeledIssue`.

### 7. `onboarding.agents` is unused on the client — **Done**

Removed from API response and `useOnboarding` types.

### 8. Home page is single-team only — **Done**

`useRailTeamId` persists last visited team slug in `sessionStorage`; home uses it instead of `teams[0]` only.

### 9. `.dev/api.md` missing new endpoints — **Done**

“Board onboarding (home)” section documents stages and routes.

### 10. No E2E for onboarding UX — **Done**

`test/e2e/onboarding-home.spec.ts` (mobile viewport): new team → progress bar + requirements intake panel.

### 11. Org chart UI duplicated — **Done**

Shared `OrgChartTree` in `packages/web/src/components/org-chart-tree.tsx` (agents page + onboarding).

---

## Low priority / polish

| Item | Status |
|------|--------|
| **`isFirstUserFacingProject` race** | **Done** — count checked inside `createProjectWithPlanningIssue` transaction (`deferCaptainPlanningWake`). |
| **Coach slug** | N/A (agents field removed). |
| **Tooltip on mobile** | **Done** — hint text: “Tap or hover a role…”. |
| **Hook lint suppressions** | Open (acceptable short-term). |
| **Monolithic commit** | N/A (process note). |
| **`implementation-phases.md`** | Open (verify dates separately). |

---

## What’s working well (unchanged)

- Stage logic, deferred planning wakeup, hire-team completion, realtime broadcasts, CEO → Captain rename.
