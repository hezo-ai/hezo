# Changelog

## 0.6.0 - 2026-06-25

### Bug Fixes

- **binary:** build agent-base image locally when it can't be pulled ([#389](https://github.com/hezo-ai/hezo/pull/389))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.5.0...0.6.0

## 0.5.0 - 2026-06-25

### Features

- **web:** float update banner at top with one-click Download & Restart ([#386](https://github.com/hezo-ai/hezo/pull/386))

### Bug Fixes

- **seed:** load agent summaries via dynamic import to survive --hot reload

### Other

- add coverage across test tiers and merge into Coveralls ([#385](https://github.com/hezo-ai/hezo/pull/385))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.4.0...0.5.0

## 0.4.0 - 2026-06-25

### Features

- in-app self-update via supervisor process ([#378](https://github.com/hezo-ai/hezo/pull/378))
- redesign AI providers settings list + add modal, settings breadcrumbs ([#377](https://github.com/hezo-ai/hezo/pull/377))
- **web:** restyle settings version line and add feedback link ([#376](https://github.com/hezo-ai/hezo/pull/376))
- let the Captain create hire proposals via MCP ([#373](https://github.com/hezo-ai/hezo/pull/373))
- **projects:** gate coherence auto-run to direct project creation ([#371](https://github.com/hezo-ai/hezo/pull/371))
- modal backdrop for the expanded CEO chat + Escape to close ([#370](https://github.com/hezo-ai/hezo/pull/370))
- expand-to-fullscreen and unread indicator for the CEO chat ([#369](https://github.com/hezo-ai/hezo/pull/369))
- replace embedding search with Postgres full-text search ([#367](https://github.com/hezo-ai/hezo/pull/367))
- **server:** suggest --port when the configured port is already in use ([#366](https://github.com/hezo-ai/hezo/pull/366))

### Bug Fixes

- **dev:** use a project-local data dir for the dev server ([#365](https://github.com/hezo-ai/hezo/pull/365))

### Documentation

- trim README intro and add X social links
- condense README features and clarify how it works
- correct config reference claim that every setting has a CLI flag ([#379](https://github.com/hezo-ai/hezo/pull/379))
- explain the Hezo name in the introduction ([#375](https://github.com/hezo-ai/hezo/pull/375))
- **readme:** add product screenshot to README splash ([#374](https://github.com/hezo-ai/hezo/pull/374))
- move Quickstart section near the top of README ([#372](https://github.com/hezo-ai/hezo/pull/372))

### Tests

- fix chart-format locale failure and quiet test log output ([#382](https://github.com/hezo-ai/hezo/pull/382))

### Chores

- update default GitHub OAuth client_id
- update tagline to 'A whole AI workforce. And you're the boss.'
- add AGPL-3.0 license

### Other

- Add quiet-test-output principle for engineer and qa ([#381](https://github.com/hezo-ai/hezo/pull/381))
- Unify API keys + connected agents into one instance-scoped credential ([#380](https://github.com/hezo-ai/hezo/pull/380))
- Update README with CI badge and remove diagram

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.3.0...0.4.0

## 0.3.0 - 2026-06-24

### Features

- **web:** nest Container and Activity under Settings in the project sidebar ([#360](https://github.com/hezo-ai/hezo/pull/360))
- **web:** show live countdown to an agent's next heartbeat ([#358](https://github.com/hezo-ai/hezo/pull/358))
- **web:** link project names in the instance activity log ([#357](https://github.com/hezo-ai/hezo/pull/357))
- **agents:** default heartbeat interval to 12 hours ([#356](https://github.com/hezo-ai/hezo/pull/356))
- **web:** redesign CEO chat widget to match mockup ([#354](https://github.com/hezo-ai/hezo/pull/354))
- **web:** show current version + release link in settings ([#352](https://github.com/hezo-ai/hezo/pull/352))
- **ceo:** let the CEO retire agents and stop premature provisioning ([#348](https://github.com/hezo-ai/hezo/pull/348))
- bundle docs into CEO chat context; point SKILL.md at live docs ([#345](https://github.com/hezo-ai/hezo/pull/345))
- **projects:** attach a project plan document instead of a PRD ([#344](https://github.com/hezo-ai/hezo/pull/344))
- **agent-runner:** auto-catch-up resumed worktrees to trunk ([#343](https://github.com/hezo-ai/hezo/pull/343))
- **agents:** architect schedules deploy ticket, gate marketing launch on it ([#340](https://github.com/hezo-ai/hezo/pull/340))
- **mcp:** warn agents who backtick an existing entity reference ([#336](https://github.com/hezo-ai/hezo/pull/336))
- **web:** open asset mentions in a new tab instead of the preview panel ([#337](https://github.com/hezo-ai/hezo/pull/337))
- **mcp:** warn agents who address a teammate by bold/bare name ([#335](https://github.com/hezo-ai/hezo/pull/335))
- **hq:** enable the assets library for HQ so the CEO can produce and link files ([#334](https://github.com/hezo-ai/hezo/pull/334))
- **agents:** engineer self-merges each phase and auto-proceeds ([#332](https://github.com/hezo-ai/hezo/pull/332))
- **server:** detect Docker at startup and guide install when missing ([#331](https://github.com/hezo-ai/hezo/pull/331))
- **web:** move run Retry button onto the failed run-entry comment ([#329](https://github.com/hezo-ai/hezo/pull/329))
- **projects:** create project + team on in-thread CEO approval ([#326](https://github.com/hezo-ai/hezo/pull/326))
- **web:** open updated-doc links from run comments in the preview panel ([#323](https://github.com/hezo-ai/hezo/pull/323))
- badge human vs connected-agent admin actions ([#312](https://github.com/hezo-ai/hezo/pull/312))
- scope API keys to MCP and add MCP file upload ([#309](https://github.com/hezo-ai/hezo/pull/309))
- **web:** show per-project inbox count badges on the project rail ([#311](https://github.com/hezo-ai/hezo/pull/311))
- connected agents + llms.txt/SKILL.md for external MCP clients ([#308](https://github.com/hezo-ai/hezo/pull/308))
- **agents:** don't re-engage a ticket already handed off to a teammate ([#306](https://github.com/hezo-ai/hezo/pull/306))
- **runs:** track partial token usage when a run fails mid-flight ([#303](https://github.com/hezo-ai/hezo/pull/303))
- enable GitHub MCP actions toolset so agents fetch CI logs via get_job_logs ([#304](https://github.com/hezo-ai/hezo/pull/304))
- **tasks:** split terminal tickets into a Done section ([#302](https://github.com/hezo-ai/hezo/pull/302))
- **search:** show matched context with highlights in results ([#299](https://github.com/hezo-ai/hezo/pull/299))
- **tasks:** persist task list filters per project ([#298](https://github.com/hezo-ai/hezo/pull/298))
- **agents:** add homepage four-questions checklist to UI Designer prompt ([#296](https://github.com/hezo-ai/hezo/pull/296))
- **search:** embed task comments and add a global Cmd/Ctrl+K palette ([#292](https://github.com/hezo-ai/hezo/pull/292))
- **containers:** surface base-image build progress on project pages and container page ([#291](https://github.com/hezo-ai/hezo/pull/291))
- **web:** Wire task detail (mono header + preview panel) + Mission-control home ([#280](https://github.com/hezo-ai/hezo/pull/280))
- **web:** adopt Wire design system — theme, components, Budget redesign, Inbox restyle ([#269](https://github.com/hezo-ai/hezo/pull/269))
- let agents declare a run as "no work this turn" instead of failing it ([#267](https://github.com/hezo-ai/hezo/pull/267))
- make every timestamped timeline item a self-permalink ([#266](https://github.com/hezo-ai/hezo/pull/266))
- **web:** breadcrumb to parent task in task header ([#263](https://github.com/hezo-ai/hezo/pull/263))
- make create-new the first and default tab in repo setup dialog ([#262](https://github.com/hezo-ai/hezo/pull/262))
- **skills:** skills.sh discovery, manifest-only surfacing, admin search-and-add ([#259](https://github.com/hezo-ai/hezo/pull/259))
- **web:** link comment references in agent runs; comment timestamps as permalinks ([#257](https://github.com/hezo-ai/hezo/pull/257))
- **tasks:** remove per-task spent amount from task detail ([#254](https://github.com/hezo-ai/hezo/pull/254))
- **pricing:** add llm-prices.com feed and dedupe concurrent image builds ([#251](https://github.com/hezo-ai/hezo/pull/251))
- **runtimes:** add OpenCode (+OpenRouter) and Kimi Code CLI runtimes ([#249](https://github.com/hezo-ai/hezo/pull/249))
- **web:** open doc/asset mention names in a new tab like the icon suffix ([#246](https://github.com/hezo-ai/hezo/pull/246))
- timestamp-based public_id for task comments ([#245](https://github.com/hezo-ai/hezo/pull/245))
- **budget:** merge limit editing into spend display; add to project settings ([#238](https://github.com/hezo-ai/hezo/pull/238))
- compute run cost from a runtime model-pricing table ([#234](https://github.com/hezo-ai/hezo/pull/234))
- per-day budget breakdowns by agent and AI adapter; drop team cost tracking ([#233](https://github.com/hezo-ai/hezo/pull/233))
- cross-window budget validation + per-window disable ([#231](https://github.com/hezo-ai/hezo/pull/231))
- **projects:** clone an existing team when creating a project ([#228](https://github.com/hezo-ai/hezo/pull/228))
- **server:** real tracked migrations — safe apply, version guard, code steps ([#224](https://github.com/hezo-ai/hezo/pull/224))
- **tasks:** show run-state dot in Blocked By and sub-task lists ([#223](https://github.com/hezo-ai/hezo/pull/223))
- chatbox memory document + chatbox settings page (HID-194) ([#225](https://github.com/hezo-ai/hezo/pull/225))
- **auth:** challenge-response master-key auth — the mnemonic never leaves the client ([#221](https://github.com/hezo-ai/hezo/pull/221))
- render CEO chat entity references as links with per-channel renderer abstraction ([#219](https://github.com/hezo-ai/hezo/pull/219))
- **repos:** drop short_name — the repository name is the label ([#218](https://github.com/hezo-ai/hezo/pull/218))
- **tasks:** chain batch-created tickets with intra-batch dependency tokens ([#216](https://github.com/hezo-ai/hezo/pull/216))
- render markdown in CEO chat messages ([#213](https://github.com/hezo-ai/hezo/pull/213))
- stamp approved PRDs with a linkback to the approval task + comment ([#211](https://github.com/hezo-ai/hezo/pull/211))
- **ceo-chat:** polish CEO chat widget ([#208](https://github.com/hezo-ai/hezo/pull/208))
- **ceo-chat:** persistent real-time CEO chat in the web app ([#197](https://github.com/hezo-ai/hezo/pull/197))
- **web:** add "Reply" label to comment reply button ([#204](https://github.com/hezo-ai/hezo/pull/204))
- copy task comments and link to specific comments ([#199](https://github.com/hezo-ai/hezo/pull/199))
- **credentials:** require allowed_hosts for HTTP-auth credential requests ([#198](https://github.com/hezo-ai/hezo/pull/198))
- **server:** central config + slug-enriched logs + container debug toggle ([#190](https://github.com/hezo-ai/hezo/pull/190))
- **repos:** elegant handling of GitHub repo-name collision on create ([#185](https://github.com/hezo-ai/hezo/pull/185))
- **server:** auto-restart project containers on server startup ([#183](https://github.com/hezo-ai/hezo/pull/183))
- **server:** container memory observability + lifecycle event logs ([#181](https://github.com/hezo-ai/hezo/pull/181))
- **web:** retry button on the run-failed system comment ([#179](https://github.com/hezo-ai/hezo/pull/179))
- **server:** per-project container memory limit, raise default to 16 GiB, silence 404 race ([#177](https://github.com/hezo-ai/hezo/pull/177))
- **web:** surface last-run-failed on task list and task page ([#173](https://github.com/hezo-ai/hezo/pull/173))
- **agents:** make end-of-run push + draft PR mandatory for Engineer ([#161](https://github.com/hezo-ai/hezo/pull/161))
- **web:** drop "Instance" jargon, prune top nav, add page-title info tooltips ([#144](https://github.com/hezo-ai/hezo/pull/144))
- **web:** replace HQ coordination banner with sidebar info tooltip ([#142](https://github.com/hezo-ai/hezo/pull/142))
- **web:** surface task project on CEO/Coach execution pages ([#141](https://github.com/hezo-ai/hezo/pull/141))
- make HQ agents virtual members of every project team ([#140](https://github.com/hezo-ai/hezo/pull/140))
- **web:** link agent names and avatars to their profile pages ([#139](https://github.com/hezo-ai/hezo/pull/139))
- render the activity log as readable, linked sentences ([#134](https://github.com/hezo-ai/hezo/pull/134))
- make the app project-centric (drop team ids from URLs, API, and query keys) ([#135](https://github.com/hezo-ai/hezo/pull/135))
- replace team rail/sidebar with header bar + project-avatar rail
- expand audit log to instance, team, and per-project scopes ([#133](https://github.com/hezo-ai/hezo/pull/133))
- instance CEO, multi-team foundation, team-type reuse, and board→admin rename ([#118](https://github.com/hezo-ai/hezo/pull/118))
- flag tasks with unseen board mentions in the task list ([#132](https://github.com/hezo-ai/hezo/pull/132))
- add board approvals banner to the task list ([#131](https://github.com/hezo-ai/hezo/pull/131))
- keep an agent run scoped to its own task ([#130](https://github.com/hezo-ai/hezo/pull/130))
- **web:** hide wake-assignee toggle when replying to an agent ([#123](https://github.com/hezo-ai/hezo/pull/123))
- inject the full triggering comment into mention and reply handoffs ([#122](https://github.com/hezo-ai/hezo/pull/122))
- **web:** add formatted view to the execution log viewer ([#120](https://github.com/hezo-ai/hezo/pull/120))
- auto-include description, progress summary, and rules in every run prompt ([#119](https://github.com/hezo-ai/hezo/pull/119))
- host UI mockups in assets library and link GitHub repos ([#117](https://github.com/hezo-ai/hezo/pull/117))

### Bug Fixes

- **tasks:** count cancelled sub-tasks as resolved when closing a parent ([#361](https://github.com/hezo-ai/hezo/pull/361))
- **web:** reword inbox banner to "items need your attention" ([#349](https://github.com/hezo-ai/hezo/pull/349))
- CEO chat — headless-run guidance for agents + clickable backticked doc/asset links ([#347](https://github.com/hezo-ai/hezo/pull/347))
- **realtime:** render agent comments and reactions live without refresh ([#346](https://github.com/hezo-ai/hezo/pull/346))
- **agents:** treat a completion report that hands off as an active mention ([#341](https://github.com/hezo-ai/hezo/pull/341))
- **agents:** require PR out of draft before engineer hands off to QA ([#339](https://github.com/hezo-ai/hezo/pull/339))
- **agents:** phased work converges on one branch + one PR ([#338](https://github.com/hezo-ai/hezo/pull/338))
- **web:** show log-viewer toolbar borders only on active toggles ([#328](https://github.com/hezo-ai/hezo/pull/328))
- **web:** remove Retry button from last-run-failed banner ([#327](https://github.com/hezo-ai/hezo/pull/327))
- **agents:** toolchain discipline, sub-agent write races, doc-status hygiene ([#325](https://github.com/hezo-ai/hezo/pull/325))
- **web:** proxy /llms.txt to the server in dev ([#321](https://github.com/hezo-ai/hezo/pull/321))
- stop project-rail count badge being clipped at the top ([#320](https://github.com/hezo-ai/hezo/pull/320))
- **web:** make the selected team-type card visibly highlighted ([#319](https://github.com/hezo-ai/hezo/pull/319))
- **auth:** let connected agents reach realtime WebSocket rooms ([#317](https://github.com/hezo-ai/hezo/pull/317))
- **agents:** teach agents a status-phrased handoff is an active-@ ask ([#310](https://github.com/hezo-ai/hezo/pull/310))
- **agents:** keep PR fixes on the same branch instead of spawning new ticket/branch/PR ([#307](https://github.com/hezo-ai/hezo/pull/307))
- **budget:** drop redundant Edit caps button and Spend by model section ([#297](https://github.com/hezo-ai/hezo/pull/297))
- keep right sidebar top spacing put on scroll ([#295](https://github.com/hezo-ai/hezo/pull/295))
- **web:** surface run task details above the timing box, more prominently ([#294](https://github.com/hezo-ai/hezo/pull/294))
- **agents:** warn that a bold/plain teammate name with no @ prefix wakes no one
- **egress:** gate server-close teardown on listening-handle release ([#290](https://github.com/hezo-ai/hezo/pull/290))
- **agents:** make routing/triage handoffs an active @-mention ([#289](https://github.com/hezo-ai/hezo/pull/289))
- **egress:** bind per-host MITM servers to explicit ports; pre-install bun+unzip ([#287](https://github.com/hezo-ai/hezo/pull/287))
- **web:** restore colour-coded tint pills in the task header ([#285](https://github.com/hezo-ai/hezo/pull/285))
- **egress:** cross-host cert mis-routing, hop-by-hop relay, and per-run upstream sockets (GitHub MCP failure) ([#283](https://github.com/hezo-ai/hezo/pull/283))
- **web:** restore the agent run log's pre-Wire colours ([#277](https://github.com/hezo-ai/hezo/pull/277))
- **repos:** adopt pre-populated workspace dir instead of failing the clone ([#278](https://github.com/hezo-ai/hezo/pull/278))
- **egress:** make upstream-failure logs diagnosable; widen teardown test ([#276](https://github.com/hezo-ai/hezo/pull/276))
- **agents:** make asking the admin for input an explicit active @admin ([#271](https://github.com/hezo-ai/hezo/pull/271))
- allow mentioning HQ instance agents (CEO/Coach) from any project ([#270](https://github.com/hezo-ai/hezo/pull/270))
- **web:** correct inbox deep-link scroll (alignment, bounce, jump-to-top) ([#265](https://github.com/hezo-ai/hezo/pull/265))
- **agents:** gate implementation tickets on plan/spec/design via blockers ([#264](https://github.com/hezo-ai/hezo/pull/264))
- **runs:** require produced output for a run to count as success ([#260](https://github.com/hezo-ai/hezo/pull/260))
- keep manual retry available after repeated run failures ([#258](https://github.com/hezo-ai/hezo/pull/258))
- **tasks:** require add_task_blocker when a ticket waits on another ticket ([#256](https://github.com/hezo-ai/hezo/pull/256))
- **mentions:** render passive @@ without prefix; sharpen active-mention guidance ([#252](https://github.com/hezo-ai/hezo/pull/252))
- **egress:** sever streamed connections on teardown so MCP sessions don't leak ([#248](https://github.com/hezo-ai/hezo/pull/248))
- **agents:** use the project's designated repo instead of inventing a new one ([#247](https://github.com/hezo-ai/hezo/pull/247))
- **web:** reset scroll position when navigating between pages ([#244](https://github.com/hezo-ai/hezo/pull/244))
- **pricing:** resolve unknown models via nearest segment-prefix match ([#243](https://github.com/hezo-ai/hezo/pull/243))
- **web:** keep agent names on one line in task list + side panel ([#241](https://github.com/hezo-ai/hezo/pull/241))
- **budget:** correct "Invalid Date" on spend charts and redesign the page ([#236](https://github.com/hezo-ai/hezo/pull/236))
- **budget:** auto-resume budget-paused agents + scoped runtime states ([#235](https://github.com/hezo-ai/hezo/pull/235))
- reconcile budgeting schema + unify agent-budget plumbing ([#230](https://github.com/hezo-ai/hezo/pull/230))
- **egress:** unify credential placeholder grammar; validate secret names ([#229](https://github.com/hezo-ai/hezo/pull/229))
- **tasks:** resolve parent_task_id by identifier, not just UUID ([#226](https://github.com/hezo-ai/hezo/pull/226))
- **agents:** keep Coach review summaries passive — no @admin inbox rows ([#217](https://github.com/hezo-ai/hezo/pull/217))
- **runs:** never let post-run teardown strand an agent in 'running' ([#220](https://github.com/hezo-ai/hezo/pull/220))
- **egress:** heal cross-host route when one MITM server is registered under unrelated hosts ([#210](https://github.com/hezo-ai/hezo/pull/210))
- **ceo:** give the CEO cross-team visibility over every project ([#209](https://github.com/hezo-ai/hezo/pull/209))
- **containers:** surface provisioning banner for rebuilds outside the rebuild route ([#207](https://github.com/hezo-ai/hezo/pull/207))
- **egress:** purge per-host cert routes by port ownership, not the listening flag
- **server:** enrich read_project_doc description to steer agents off the filesystem ([#205](https://github.com/hezo-ai/hezo/pull/205))
- **egress:** self-heal stale per-host cert routes to stop cross-host TLS failures ([#202](https://github.com/hezo-ai/hezo/pull/202))
- **egress:** PortAllocator race + cross-host cert detector; human-set credential hosts ([#201](https://github.com/hezo-ai/hezo/pull/201))
- **agents:** keep the review/fix loop continuous via active mentions and blocked_by gating ([#195](https://github.com/hezo-ai/hezo/pull/195))
- **server:** give container names a random suffix so keep-old rebuilds don't 409 ([#194](https://github.com/hezo-ai/hezo/pull/194))
- **test:** give the bun-native egress beforeAll 60s for slow CI ([#180](https://github.com/hezo-ai/hezo/pull/180))
- **server:** heal orphaned task worktrees instead of handing them to agents ([#192](https://github.com/hezo-ai/hezo/pull/192))
- **agents:** give agents the triggering comment UUID in mention handoffs ([#193](https://github.com/hezo-ai/hezo/pull/193))
- **web:** only show run Retry button on the latest run ([#191](https://github.com/hezo-ai/hezo/pull/191))
- **dev:** tolerate excess args so unknown server flags pass through
- **docker:** route apt through per-run egress proxy ([#189](https://github.com/hezo-ai/hezo/pull/189))
- **server:** broadcast full project row on container lifecycle changes ([#188](https://github.com/hezo-ai/hezo/pull/188))
- **server:** bound docker.request timeouts, bump cron-async to 1.2.1 ([#186](https://github.com/hezo-ai/hezo/pull/186))
- **server:** reject non-UUID comment_id in MCP reaction tools ([#182](https://github.com/hezo-ai/hezo/pull/182))
- **web:** global inbox uses project slugs so badge matches the list ([#176](https://github.com/hezo-ai/hezo/pull/176))
- **server:** safer pgdata recovery + auto-stop runaway containers ([#174](https://github.com/hezo-ai/hezo/pull/174))
- **web:** anchor task scroll-to-bottom button to page right edge ([#170](https://github.com/hezo-ai/hezo/pull/170))
- **web:** offset sticky doc-list sidebar so it doesn't slam into the header on scroll ([#172](https://github.com/hezo-ai/hezo/pull/172))
- cool down chain-after-completion to stop ping-pong on parked tasks ([#169](https://github.com/hezo-ai/hezo/pull/169))
- **server:** cap project container memory to surface OOM kills ([#168](https://github.com/hezo-ai/hezo/pull/168))
- **web:** signal failed container in sidebar, soften copy, fix sticky overlap ([#166](https://github.com/hezo-ai/hezo/pull/166))
- **web:** anchor task scroll-to-bottom button to content pane width ([#165](https://github.com/hezo-ai/hezo/pull/165))
- don't immediately retry a failed run ([#164](https://github.com/hezo-ai/hezo/pull/164))
- **scheduler:** raise heartbeat floor + seed values to 60 minutes ([#163](https://github.com/hezo-ai/hezo/pull/163))
- **agents:** stop Architect from absorbing UI Designer deliverables, add universal delegation discipline ([#162](https://github.com/hezo-ai/hezo/pull/162))
- **web:** preserve line breaks for system status lines in formatted log view ([#160](https://github.com/hezo-ai/hezo/pull/160))
- instruct agents to omit `model:` when launching sub-agents ([#159](https://github.com/hezo-ai/hezo/pull/159))
- suppress redundant downstream wakeup on terminal→terminal status flips ([#158](https://github.com/hezo-ai/hezo/pull/158))
- **web:** hide token and cost cards while agent run is active ([#156](https://github.com/hezo-ai/hezo/pull/156))
- wake parent task agent when sub-tasks all reach Closed ([#155](https://github.com/hezo-ai/hezo/pull/155))
- make @@ the default for agent teammate mentions ([#153](https://github.com/hezo-ai/hezo/pull/153))
- **web:** reliably scroll to source comment on inbox deep-link ([#152](https://github.com/hezo-ai/hezo/pull/152))
- suppress redundant assignment-driven agent re-runs ([#151](https://github.com/hezo-ai/hezo/pull/151))
- capture token usage for Codex and Gemini agent runs ([#150](https://github.com/hezo-ai/hezo/pull/150))
- readable container logs, provisioning banner, wake agents after provision ([#149](https://github.com/hezo-ai/hezo/pull/149))
- persist agent git work, provider-aware completeness gate, planning-ticket close ([#148](https://github.com/hezo-ai/hezo/pull/148))
- **agents:** bound captain plan fan-out to direct reports ([#147](https://github.com/hezo-ai/hezo/pull/147))
- **web:** reorder project rail so create-project button is above HQ ([#146](https://github.com/hezo-ai/hezo/pull/146))
- thread CEO layer through seeded team contexts and summaries ([#137](https://github.com/hezo-ai/hezo/pull/137))
- **mcp:** resolve human-readable task identifiers in tool args ([#128](https://github.com/hezo-ai/hezo/pull/128))
- **agent-runtime:** extract reply excerpt from bare-string comment bodies ([#125](https://github.com/hezo-ai/hezo/pull/125))
- **agent-runtime:** unblock in-container git, asset reads, and sudo ([#121](https://github.com/hezo-ai/hezo/pull/121))

### Refactors

- **audit:** scope the activity log to project + instance, drop per-team ([#351](https://github.com/hezo-ai/hezo/pull/351))
- **agents:** run all repo/worktree git inside the container ([#330](https://github.com/hezo-ai/hezo/pull/330))
- remove agent-api orphans (tool_calls, trace, secret_access) ([#313](https://github.com/hezo-ai/hezo/pull/313))
- remove the agent-api surface ([#305](https://github.com/hezo-ai/hezo/pull/305))
- **api:** remove bare team-centric /api/teams routes ([#284](https://github.com/hezo-ai/hezo/pull/284))
- **comments:** remove the options comment type entirely ([#272](https://github.com/hezo-ai/hezo/pull/272))
- **agents:** promote universal partials into SHARED_INSTRUCTIONS ([#268](https://github.com/hezo-ai/hezo/pull/268))
- remove the project task list planning-phase banner ([#239](https://github.com/hezo-ai/hezo/pull/239))
- **projects:** drop team name/slug from the roster agents echo ([#222](https://github.com/hezo-ai/hezo/pull/222))
- **egress:** replace http-mitm-proxy with in-house MITM proxy ([#215](https://github.com/hezo-ai/hezo/pull/215))
- **mcp:** project-centric tool surface; stop exposing team_id ([#214](https://github.com/hezo-ai/hezo/pull/214))
- apply registry/factory patterns across server and web ([#196](https://github.com/hezo-ai/hezo/pull/196))
- **dev:** forward all flags to the server CLI
- **web:** remove Clear button from container logs view ([#187](https://github.com/hezo-ai/hezo/pull/187))
- **web:** fold "started queued run" system comment into the run card ([#184](https://github.com/hezo-ai/hezo/pull/184))
- **web:** drop standalone Terminate button from run detail header ([#178](https://github.com/hezo-ai/hezo/pull/178))
- **server:** inject project docs as metadata manifest, not full bodies ([#171](https://github.com/hezo-ai/hezo/pull/171))

### Documentation

- add generated MCP API reference under docs/reference ([#362](https://github.com/hezo-ai/hezo/pull/362))
- add Search page and feature entry ([#359](https://github.com/hezo-ai/hezo/pull/359))
- make README feature-complete with links to docs pages ([#355](https://github.com/hezo-ai/hezo/pull/355))
- remove "Next" sections from doc pages ([#353](https://github.com/hezo-ai/hezo/pull/353))
- add deferred plan for self-updating binary & restart ([#350](https://github.com/hezo-ai/hezo/pull/350))
- explain CEO, Coach, HQ and realtime CEO chat ([#342](https://github.com/hezo-ai/hezo/pull/342))
- document long-term memory, assets, and HTML previews ([#333](https://github.com/hezo-ai/hezo/pull/333))
- don't imply every Hezo instance listens on port 3100 ([#322](https://github.com/hezo-ai/hezo/pull/322))
- require API/route changes to update docs reference, SKILL.md, and llms.txt ([#318](https://github.com/hezo-ai/hezo/pull/318))
- clarify API keys are MCP-only and document /mcp/assets upload ([#314](https://github.com/hezo-ai/hezo/pull/314))
- launch-ready README and install guide ([#301](https://github.com/hezo-ai/hezo/pull/301))
- consolidate .dev/ into a single architecture.md ([#300](https://github.com/hezo-ai/hezo/pull/300))
- align AGENTS.md with project-centric routing ([#286](https://github.com/hezo-ai/hezo/pull/286))
- sharpen README to be concrete and distinctive ([#288](https://github.com/hezo-ai/hezo/pull/288))
- rewrite docs/ for the real product + add full guides and README ([#282](https://github.com/hezo-ai/hezo/pull/282))
- **agents:** tell engineer to install bun if missing ([#242](https://github.com/hezo-ai/hezo/pull/242))
- make SSH-key output and docs project-centric ([#240](https://github.com/hezo-ai/hezo/pull/240))

### Tests

- **browser:** de-flake comment-attachment, scroll-reset & reply specs ([#316](https://github.com/hezo-ai/hezo/pull/316))
- harden flaky budget + comment-attachment specs ([#273](https://github.com/hezo-ai/hezo/pull/273))
- **mentions:** assert passive @@ceo renders bare in ceo chat ([#255](https://github.com/hezo-ai/hezo/pull/255))
- **repos:** close out Phase 13 with wizard-flow and designation lifecycle coverage ([#206](https://github.com/hezo-ai/hezo/pull/206))
- **browser:** match run-comment deep-link test by task_id, not trigger_source ([#175](https://github.com/hezo-ai/hezo/pull/175))

### Chores

- hide the project task-list progress bar for now ([#281](https://github.com/hezo-ai/hezo/pull/281))
- **server:** demote routine mcp-connection descriptor logs to debug ([#167](https://github.com/hezo-ai/hezo/pull/167))

### Other

- Remove stale peer-Engineers delegation reference from Engineer role ([#324](https://github.com/hezo-ai/hezo/pull/324))
- Collapse migrations into a single v1.0 baseline + data-preservation test policy ([#315](https://github.com/hezo-ai/hezo/pull/315))
- Surface provider errors on runs; let agents use GitHub OAuth token for REST ([#293](https://github.com/hezo-ai/hezo/pull/293))
- Show a status dot instead of idle/running text in the team sidebar ([#279](https://github.com/hezo-ai/hezo/pull/279))
- notify website to bump submodule after CI passes on main ([#275](https://github.com/hezo-ai/hezo/pull/275))
- Add high-level docs/ folder for the marketing website ([#274](https://github.com/hezo-ai/hezo/pull/274))
- Rename task list "To do" section header to "Backlog" ([#261](https://github.com/hezo-ai/hezo/pull/261))
- Add Claude & Kimi subscription auth (and fix Kimi runtime invocation) ([#250](https://github.com/hezo-ai/hezo/pull/250))
- Task list improvements - progress header, split list sections, work-order sort ([#203](https://github.com/hezo-ai/hezo/pull/203))
- shard test-backend and test-integration across runners ([#232](https://github.com/hezo-ai/hezo/pull/232))
- Finalised budgeting system (HID-195) ([#227](https://github.com/hezo-ai/hezo/pull/227))
- build agent-base image and run docker integration suites ([#212](https://github.com/hezo-ai/hezo/pull/212))
- Make credentials, connectors, and skills instance-global ([#200](https://github.com/hezo-ai/hezo/pull/200))
- **web:** consolidate run detail metrics into Timing + Usage cards ([#157](https://github.com/hezo-ai/hezo/pull/157))
- Keep left sidebars pinned while page content scrolls (desktop) ([#154](https://github.com/hezo-ai/hezo/pull/154))
- **web:** restore page padding around project content ([#143](https://github.com/hezo-ai/hezo/pull/143))
- cap content width, remove breadcrumbs, fix page padding ([#138](https://github.com/hezo-ai/hezo/pull/138))
- Unify running + queued agents into one Agent Queue sidebar section ([#129](https://github.com/hezo-ai/hezo/pull/129))
- Fix vertical alignment of run comment inline icon ([#127](https://github.com/hezo-ai/hezo/pull/127))
- Render thinking-stream enumerations as markdown lists ([#126](https://github.com/hezo-ai/hezo/pull/126))
- Add formatted/raw log switcher to task-page run comments ([#124](https://github.com/hezo-ai/hezo/pull/124))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.2.0...0.3.0

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
