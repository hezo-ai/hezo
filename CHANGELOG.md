# Changelog

## 0.2.0 - 2026-06-02

### Features

- **release:** always cut a release on manual dispatch ([#113](https://github.com/hezo-ai/hezo/pull/113))

### Tests

- **server:** assert status version against HEZO_VERSION, not a literal ([#115](https://github.com/hezo-ai/hezo/pull/115))

### Other

- Add update notifications and self-contained binary support ([#112](https://github.com/hezo-ai/hezo/pull/112))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.1.0...0.2.0

## 0.1.0 - 2026-06-02

### Features

- **release:** add manual GitHub release workflow ([#106](https://github.com/hezo-ai/hezo/pull/106))
- **projects:** add Assets library, make project docs markdown-only ([#105](https://github.com/hezo-ai/hezo/pull/105))
- replace Work sidebar menu with All Tasks and remove the Goals feature ([#104](https://github.com/hezo-ai/hezo/pull/104))
- **docs:** pop out document previews into a standalone tab ([#102](https://github.com/hezo-ai/hezo/pull/102))
- HTML project doc previews + per-agent busy flag on queued wakeups ([#100](https://github.com/hezo-ai/hezo/pull/100))
- **concurrency:** cap concurrent agent runs per project ([#98](https://github.com/hezo-ai/hezo/pull/98))
- **master-key:** use 12-word BIP39 phrase instead of raw hex ([#94](https://github.com/hezo-ai/hezo/pull/94))
- **run-summary:** per-item linked rows for docs, skills, tickets ([#96](https://github.com/hezo-ai/hezo/pull/96))
- run a queued agent immediately from the task sidebar ([#95](https://github.com/hezo-ai/hezo/pull/95))
- unify knowledge base into team skills database ([#88](https://github.com/hezo-ai/hezo/pull/88))
- connector-driven MCP integration with UI-mediated OAuth ([#86](https://github.com/hezo-ai/hezo/pull/86))
- queued agent runs display and cancel on task sidebar ([#87](https://github.com/hezo-ai/hezo/pull/87))
- @board mention notifies board users via inbox ([#85](https://github.com/hezo-ai/hezo/pull/85))
- captain can update agent prompts; web log toolbar + tooltip polish ([#75](https://github.com/hezo-ai/hezo/pull/75))
- gate every claude code run with a Stop-hook completeness check ([#74](https://github.com/hezo-ai/hezo/pull/74))
- remove "general help" escape hatch from onboarding choice ([#71](https://github.com/hezo-ai/hezo/pull/71))
- scope agent runs to their project, allow cross-project parallelism ([#70](https://github.com/hezo-ai/hezo/pull/70))
- hide multi-team UI and pin to a seeded default team ([#66](https://github.com/hezo-ai/hezo/pull/66))
- comment attachments and agent run-failure handling ([#65](https://github.com/hezo-ai/hezo/pull/65))
- **ai:** add z.ai (GLM-4.7) as a Claude Code provider ([#62](https://github.com/hezo-ai/hezo/pull/62))
- surface DeepSeek as the first AI provider option ([#56](https://github.com/hezo-ai/hezo/pull/56))
- add DeepSeek as an AI provider, decouple provider from runtime ([#55](https://github.com/hezo-ai/hezo/pull/55))
- restrict agent issue assignment to direct subordinates ([#52](https://github.com/hezo-ai/hezo/pull/52))
- record status changes and first cross-issue links on the timeline ([#50](https://github.com/hezo-ai/hezo/pull/50))
- serialise agent runs per issue and scope ticket creation to role ([#49](https://github.com/hezo-ai/hezo/pull/49))
- auto-close ticket once Coach finishes its review ([#43](https://github.com/hezo-ai/hezo/pull/43))
- skip ticket comments when an agent run adds nothing new ([#46](https://github.com/hezo-ai/hezo/pull/46))
- float ticket sidebar on scroll and relocate effort/wake-assignee controls ([#45](https://github.com/hezo-ai/hezo/pull/45))
- paginate sub-issues with configurable per-company page size ([#44](https://github.com/hezo-ai/hezo/pull/44))
- Coach posts review-summary comment on each reviewed ticket ([#40](https://github.com/hezo-ai/hezo/pull/40))
- cap sub-issue depth at 2 and surface parent chain in breadcrumbs ([#42](https://github.com/hezo-ai/hezo/pull/42))
- PRD/tech-spec approval gates, responsive shell, open-issue badges, non-terminal default filter ([#38](https://github.com/hezo-ai/hezo/pull/38))
- user-friendly inbox messages with entity links ([#36](https://github.com/hezo-ai/hezo/pull/36))
- allow uploading initial PRD when creating a project ([#35](https://github.com/hezo-ai/hezo/pull/35))
- per-run reasoning effort for agents (ultrathink by default for planners) ([#33](https://github.com/hezo-ai/hezo/pull/33))
- add execution locks, skills DB, semantic search, and project docs migration ([#29](https://github.com/hezo-ai/hezo/pull/29))
- agent autonomy & knowledge maintenance ([#28](https://github.com/hezo-ai/hezo/pull/28))
- add AI adapter auth setup with multi-provider support ([#27](https://github.com/hezo-ai/hezo/pull/27))
- add company skills with filesystem storage and Docker mounts ([#20](https://github.com/hezo-ai/hezo/pull/20))
- add Coach agent for automated system prompt improvement ([#19](https://github.com/hezo-ai/hezo/pull/19))
- replace HeartbeatEngine with JobManager and add audit log route
- support multiple team types per company ([#18](https://github.com/hezo-ai/hezo/pull/18))
- add e2e tests for KB, settings, agent hire and refactor shared helpers ([#17](https://github.com/hezo-ai/hezo/pull/17))
- expand QA role to full codebase review and add architect triage workflow
- overhaul UI with screen mockups and light/dark theme
- implement main phases with UI ([#12](https://github.com/hezo-ai/hezo/pull/12))
- add slugs to companies/projects and replace mission/email with description
- **web:** add web UI package with Phase 3.5 foundation
- **server:** implement Phase 3 GitHub integration
- **test:** add per-file test isolation and duration-based scheduling
- **server:** implement Phase 2 Core CRUD REST API ([#10](https://github.com/hezo-ai/hezo/pull/10))
- **server:** auto-open browser on startup, add root route, consolidate config
- **connect:** add env-var config validation and monorepo build scripts
- **connect:** implement Hezo Connect OAuth gateway ([#8](https://github.com/hezo-ai/hezo/pull/8))
- **server:** add startup orchestration and test infrastructure ([#7](https://github.com/hezo-ai/hezo/pull/7))
- **server:** add CLI argument parser ([#6](https://github.com/hezo-ai/hezo/pull/6))
- **server:** add PGlite database, migration system, and initial schema ([#5](https://github.com/hezo-ai/hezo/pull/5))
- **server:** add master key encryption and canary lifecycle ([#4](https://github.com/hezo-ai/hezo/pull/4))
- add Biome for linting/formatting and CI workflow
- **shared:** add shared types and constants
- scaffold monorepo with server, connect, and shared packages
- add company preferences, project docs, and shared container model

### Bug Fixes

- **egress:** drop forceSNI (broken under Bun) and add a Bun-native te… ([#103](https://github.com/hezo-ai/hezo/pull/103))
- **egress:** force SNI to stop per-host MITM server churn ([#101](https://github.com/hezo-ai/hezo/pull/101))
- **dispatch:** prevent leaked execution lock when an agent is already… ([#99](https://github.com/hezo-ai/hezo/pull/99))
- **oauth:** restore GitHub auth via a generalized device flow ([#97](https://github.com/hezo-ai/hezo/pull/97))
- **wakeups:** collapse duplicate queued runs per agent+task ([#93](https://github.com/hezo-ai/hezo/pull/93))
- **wakeups:** dedupe queued agent runs per task regardless of timing ([#92](https://github.com/hezo-ai/hezo/pull/92))
- **projects:** key container and workspace identity on immutable ids ([#90](https://github.com/hezo-ai/hezo/pull/90))
- **agents:** unbreak web access in agent runs ([#89](https://github.com/hezo-ai/hezo/pull/89))
- **server:** keep MCP tool results under the harness payload cap ([#59](https://github.com/hezo-ai/hezo/pull/59))
- **web:** make UI mobile-first across pages, dialogs, forms, and tables ([#57](https://github.com/hezo-ai/hezo/pull/57))
- skip repo-setup nudge for conversational wakeups ([#48](https://github.com/hezo-ai/hezo/pull/48))
- container issues ([#23](https://github.com/hezo-ai/hezo/pull/23))
- resolve CI test timeouts in startup and agent-api tests
- stabilize flaky e2e tests with explicit sequential config and page load waits
- return 404 for unmatched API paths instead of SPA fallback
- update e2e test selectors and add navigation wait
- stabilize e2e tests and update schema/config

### Refactors

- **web:** finish splitting task detail route (#82) ([#84](https://github.com/hezo-ai/hezo/pull/84))
- **web:** split task detail route, move URL canonicalization to beforeLoad ([#81](https://github.com/hezo-ai/hezo/pull/81))
- **web:** split comment-renderers into per-content-type files ([#78](https://github.com/hezo-ai/hezo/pull/78))
- **server:** consolidate requireTeamAccess into Hono middleware ([#80](https://github.com/hezo-ai/hezo/pull/80))
- **web:** split settings/general.tsx into per-section components ([#79](https://github.com/hezo-ai/hezo/pull/79))
- consolidate transactions, fix cache-key bugs, shared onboarding types ([#76](https://github.com/hezo-ai/hezo/pull/76))
- rename companies to teams across the stack ([#64](https://github.com/hezo-ai/hezo/pull/64))
- various improvements
- remove hezo-connect and replace with secure proxy ([#61](https://github.com/hezo-ai/hezo/pull/61))
- rename Agents to Team, merge org chart into Team page ([#21](https://github.com/hezo-ai/hezo/pull/21))
- **test:** move e2e tests to root and integrate into test runner

### Documentation

- emphasize mobile-first responsive UI requirement in AGENTS.md ([#58](https://github.com/hezo-ai/hezo/pull/58))
- update api.md to match implemented codebase ([#30](https://github.com/hezo-ai/hezo/pull/30))
- add Phase 3.5 UI foundation and integrate UI into all phases
- add comprehensive READMEs for root and shared package
- unify members model, replace Better Auth with custom JWT auth, and refine agent workflow
- add board/member roles, OAuth-only auth, messaging integrations, and migration bundling
- replace QuickDapp with Hono/Bun, add PGlite live queries, MCP endpoint, skill file, and migration system ([#1](https://github.com/hezo-ai/hezo/pull/1))
- refine OAuth flow to use browser redirects and move Hezo Connect to Phase 1

### Build System

- **web:** declare @hezo/shared path mapping explicitly in web tsconfig ([#77](https://github.com/hezo-ai/hezo/pull/77))

### Tests

- **browser:** de-flake the attachment-hint tooltip assertion ([#110](https://github.com/hezo-ai/hezo/pull/110))
- add web component tier, migrate browser specs, plus agent fixes & polish ([#72](https://github.com/hezo-ai/hezo/pull/72))
- consolidate e2e specs and mock out long polling waits ([#47](https://github.com/hezo-ai/hezo/pull/47))
- add tier 1 & 2 tests covering search, embeddings, MCP tools, e2e gaps ([#31](https://github.com/hezo-ai/hezo/pull/31))

### Chores

- update test run order timings
- gitignore test-results directory

### Other

- **release:** wait for in-flight CI in the release guard ([#109](https://github.com/hezo-ai/hezo/pull/109))
- **release:** supersede a stale release PR on re-run ([#108](https://github.com/hezo-ai/hezo/pull/108))
- Codify code quality principles and heartbeat review process (#83) ([#83](https://github.com/hezo-ai/hezo/pull/83))
- Onboarding ux improvements (#67) ([#67](https://github.com/hezo-ai/hezo/pull/67))
- Claude/fix ci failure vdpx r (#60) ([#60](https://github.com/hezo-ai/hezo/pull/60))
- Update AI adapter authentication (#51) ([#51](https://github.com/hezo-ai/hezo/pull/51))
- Refactor mention handoff and coach review prompts to use shared partials (#41) ([#41](https://github.com/hezo-ai/hezo/pull/41))
- Replace project tabs/header with contextual breadcrumbs (#39) ([#39](https://github.com/hezo-ai/hezo/pull/39))
- Basic agent flow testing (#37) ([#37](https://github.com/hezo-ai/hezo/pull/37))
- Basic working version (#32) ([#32](https://github.com/hezo-ai/hezo/pull/32))
- Add comprehensive test suite for auth, agent runner, and isolation (#22) ([#22](https://github.com/hezo-ai/hezo/pull/22))
- remove Claude code review workflow
- trigger code review workflow on push to main
- enable full output in Claude code review workflow
- UI fixes (#16) ([#16](https://github.com/hezo-ai/hezo/pull/16))
- Add authorization checks to MCP tools and refactor token verification (#14) ([#14](https://github.com/hezo-ai/hezo/pull/14))
- UI fixes (#15) ([#15](https://github.com/hezo-ai/hezo/pull/15))
- Add KB docs, project docs, and company preferences APIs (#11) ([#11](https://github.com/hezo-ai/hezo/pull/11))
- Add Claude Code GitHub Workflow (#9) ([#9](https://github.com/hezo-ai/hezo/pull/9))
- Add .gitignore for Bun monorepo
- Initial commit: Hezo project specs and documentation

**Full Changelog**: https://github.com/hezo-ai/hezo/commits/0.1.0
