# Changelog

## 0.60.0 - 2026-09-07

### Features

- **ui:** a tone as a paragraph, a confirmation that can withhold, a field with a ref and a suffix ([#1086](https://github.com/hezo-ai/hezo/pull/1086))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.59.2...0.60.0

## 0.59.2 - 2026-09-06

### Bug Fixes

- **providers:** ask the provider whether a subscription credential is real ([#1081](https://github.com/hezo-ai/hezo/pull/1081))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.59.1...0.59.2

## 0.59.1 - 2026-09-04

### Bug Fixes

- **providers:** submit a guided sign-in code as a framed paste ([#1079](https://github.com/hezo-ai/hezo/pull/1079))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.59.0...0.59.1

## 0.59.0 - 2026-09-04

### Features

- **ui:** widen every interactive primitive for touch ([#1077](https://github.com/hezo-ai/hezo/pull/1077))

### Bug Fixes

- **web:** render agent-error inbox notices with a task link and Dismiss ([#1075](https://github.com/hezo-ai/hezo/pull/1075))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.58.0...0.59.0

## 0.58.0 - 2026-09-04

### Features

- **models:** default OpenRouter connections to openrouter/auto ([#1069](https://github.com/hezo-ai/hezo/pull/1069))
- **ui:** a package the primitives can be drawn from twice (H21) ([#1070](https://github.com/hezo-ai/hezo/pull/1070))

### Bug Fixes

- harden deployment config migration and restart lifecycle ([#1004](https://github.com/hezo-ai/hezo/pull/1004))
- **ui:** harden @hezo/ui for a second consumer ([#1073](https://github.com/hezo-ai/hezo/pull/1073))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.57.0...0.58.0

## 0.57.0 - 2026-09-01

### Features

- **runs:** requeue a run the model provider refused before it got a turn ([#1065](https://github.com/hezo-ai/hezo/pull/1065))

### Bug Fixes

- canonicalize audited docs links ([#1064](https://github.com/hezo-ai/hezo/pull/1064))
- **deploy:** serialize provisioned config safely ([#1063](https://github.com/hezo-ai/hezo/pull/1063))
- audit agent task updates ([#1059](https://github.com/hezo-ai/hezo/pull/1059))

### Tests

- **container-hours:** seed the ledger against the window it is billed in ([#1067](https://github.com/hezo-ai/hezo/pull/1067))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.56.0...0.57.0

## 0.56.0 - 2026-08-28

### Features

- **assets:** add a sortable list view to the asset library ([#1060](https://github.com/hezo-ai/hezo/pull/1060))
- **web:** lead with the subscription when a provider has one ([#1058](https://github.com/hezo-ai/hezo/pull/1058))
- **web:** sort the inbox newest or oldest first ([#1054](https://github.com/hezo-ai/hezo/pull/1054))

### Bug Fixes

- **providers:** submit the guided sign-in code with a carriage return ([#1055](https://github.com/hezo-ai/hezo/pull/1055))
- **connectors:** report an unverifiable probe as a notice, not a failure ([#1056](https://github.com/hezo-ai/hezo/pull/1056))

### Tests

- **browser:** read a moving layout in one pass, not several ([#1057](https://github.com/hezo-ai/hezo/pull/1057))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.55.0...0.56.0

## 0.55.0 - 2026-08-28

### Features

- **web:** animate the side panel open and closed ([#1052](https://github.com/hezo-ai/hezo/pull/1052))
- **agents:** review a teammate's work with adversarial sub-agents ([#1051](https://github.com/hezo-ai/hezo/pull/1051))
- **connectors:** test any connector on demand, and fix MCP OAuth reconnect ([#1050](https://github.com/hezo-ai/hezo/pull/1050))

### Bug Fixes

- **web:** keep the task's created date relative, however old it is ([#1049](https://github.com/hezo-ai/hezo/pull/1049))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.54.1...0.55.0

## 0.54.1 - 2026-08-26

### Documentation

- **agents:** cut AGENTS.md to principles, move the specifics to .dev/ guides ([#1045](https://github.com/hezo-ai/hezo/pull/1045))

### Other

- Track H: what Hezo Cloud needs from this repo ([#1047](https://github.com/hezo-ai/hezo/pull/1047))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.54.0...0.54.1

## 0.54.0 - 2026-08-24

### Features

- **mcp-cli:** reach connector tools on demand, validated end to end ([#1035](https://github.com/hezo-ai/hezo/pull/1035))
- **web:** one device sign-in component, with the steps made visible ([#1041](https://github.com/hezo-ai/hezo/pull/1041))

### Tests

- **web:** cover the broker form's device-flow view ([#1042](https://github.com/hezo-ai/hezo/pull/1042))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.53.1...0.54.0

## 0.53.1 - 2026-08-23

### Bug Fixes

- **egress:** forward quoted body placeholders, pinpoint the refusals that remain ([#1039](https://github.com/hezo-ai/hezo/pull/1039))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.53.0...0.53.1

## 0.53.0 - 2026-08-22

### Features

- **mcp:** send the registry conventions as initialize instructions ([#1029](https://github.com/hezo-ai/hezo/pull/1029))
- **web:** one revision-history viewer for every versioned surface ([#1030](https://github.com/hezo-ai/hezo/pull/1030))
- **web:** crumb takes the task name only once the heading leaves, and scrolls sideways ([#1026](https://github.com/hezo-ai/hezo/pull/1026))
- **git-state:** start the container from Refresh, not a dead-end notice ([#1025](https://github.com/hezo-ai/hezo/pull/1025))

### Bug Fixes

- **ci:** pin the Antigravity CLI per architecture so the arm64 release build works ([#1037](https://github.com/hezo-ai/hezo/pull/1037))
- **connectors:** stop removal silently orphaning repos, and tell Codex which GitHub tools are ours ([#1032](https://github.com/hezo-ai/hezo/pull/1032))
- **egress:** tell a literal body placeholder apart from a credential ([#1027](https://github.com/hezo-ai/hezo/pull/1027))
- **runs:** drop Claude Code's unrecognized-model noise on gateway providers ([#1024](https://github.com/hezo-ai/hezo/pull/1024))

### Documentation

- **readme:** rework for star conversion, and correct the runtime table ([#1033](https://github.com/hezo-ai/hezo/pull/1033))
- **mcp:** record that Claude Code does surface initialize instructions ([#1034](https://github.com/hezo-ai/hezo/pull/1034))

### Other

- Update README by removing subtext and pronunciation
- bound the docs manifest, span-edit the Custom Prompt, version chat memory, cap what reaches every run ([#1031](https://github.com/hezo-ai/hezo/pull/1031))
- move the container tier off the backend shards ([#1028](https://github.com/hezo-ai/hezo/pull/1028))
- Bill every container-uptime stretch, and re-queue a run the shutdown drain killed ([#1023](https://github.com/hezo-ai/hezo/pull/1023))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.52.0...0.53.0

## 0.53.0 - 2026-08-21

### Features

- **mcp:** send the registry conventions as initialize instructions ([#1029](https://github.com/hezo-ai/hezo/pull/1029))
- **web:** one revision-history viewer for every versioned surface ([#1030](https://github.com/hezo-ai/hezo/pull/1030))
- **web:** crumb takes the task name only once the heading leaves, and scrolls sideways ([#1026](https://github.com/hezo-ai/hezo/pull/1026))
- **git-state:** start the container from Refresh, not a dead-end notice ([#1025](https://github.com/hezo-ai/hezo/pull/1025))

### Bug Fixes

- **connectors:** stop removal silently orphaning repos, and tell Codex which GitHub tools are ours ([#1032](https://github.com/hezo-ai/hezo/pull/1032))
- **egress:** tell a literal body placeholder apart from a credential ([#1027](https://github.com/hezo-ai/hezo/pull/1027))
- **runs:** drop Claude Code's unrecognized-model noise on gateway providers ([#1024](https://github.com/hezo-ai/hezo/pull/1024))

### Documentation

- **readme:** rework for star conversion, and correct the runtime table ([#1033](https://github.com/hezo-ai/hezo/pull/1033))
- **mcp:** record that Claude Code does surface initialize instructions ([#1034](https://github.com/hezo-ai/hezo/pull/1034))

### Other

- bound the docs manifest, span-edit the Custom Prompt, version chat memory, cap what reaches every run ([#1031](https://github.com/hezo-ai/hezo/pull/1031))
- move the container tier off the backend shards ([#1028](https://github.com/hezo-ai/hezo/pull/1028))
- Bill every container-uptime stretch, and re-queue a run the shutdown drain killed ([#1023](https://github.com/hezo-ai/hezo/pull/1023))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.52.0...0.53.0

## 0.52.0 - 2026-08-20

### Breaking Changes

- **tasks:** remove the review task status ([#1018](https://github.com/hezo-ai/hezo/pull/1018))

### Features

- **web:** autolink URLs in CSV cells and plain-text assets ([#1021](https://github.com/hezo-ai/hezo/pull/1021))
- **prompts:** compose agent identity and live context instead of requiring variables ([#1019](https://github.com/hezo-ai/hezo/pull/1019))

### Bug Fixes

- **web:** pin blocked tasks to the In progress section ([#1017](https://github.com/hezo-ai/hezo/pull/1017))
- **inbox:** strip markdown from inbox and search preview text ([#1016](https://github.com/hezo-ai/hezo/pull/1016))
- **web:** cut the boot and restart screens back to a spinner and a status line ([#1015](https://github.com/hezo-ai/hezo/pull/1015))

### Refactors

- **tasks:** remove the review task status ([#1018](https://github.com/hezo-ai/hezo/pull/1018))

### Other

- accurate spend, container hours, and uncapped agents ([#1020](https://github.com/hezo-ai/hezo/pull/1020))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.51.0...0.52.0

## 0.51.0 - 2026-08-19

### Breaking Changes

- **intake:** stop the CEO running before the admin replies, and rename the App Team slug to app-dev ([#1011](https://github.com/hezo-ai/hezo/pull/1011))

### Features

- parallel Codex subscription runs + Gemini→Antigravity runtime ([#1010](https://github.com/hezo-ai/hezo/pull/1010))
- **web:** explain progress update runs behind a help dialog ([#1009](https://github.com/hezo-ai/hezo/pull/1009))
- **tasks:** carry the task name in the pinned breadcrumb, on one line ([#1006](https://github.com/hezo-ai/hezo/pull/1006))
- **web:** render CSV assets readably - table in the viewer, mini table on the card ([#1002](https://github.com/hezo-ai/hezo/pull/1002))

### Bug Fixes

- **intake:** stop the CEO running before the admin replies, and rename the App Team slug to app-dev ([#1011](https://github.com/hezo-ai/hezo/pull/1011))
- **runs:** stop a container stop killing a run that only waits for its credential ([#1007](https://github.com/hezo-ai/hezo/pull/1007))
- **web:** make settings group headings read as labels, not menu links ([#1005](https://github.com/hezo-ai/hezo/pull/1005))
- **connectors:** send hosted MCP headers to Codex, and report a connector refusing a run ([#1003](https://github.com/hezo-ai/hezo/pull/1003))

### Other

- clean up two things #1012 left behind in test-browser ([#1013](https://github.com/hezo-ai/hezo/pull/1013))
- run browser tests in Playwright's image instead of installing deps per run ([#1012](https://github.com/hezo-ai/hezo/pull/1012))
- bound package-install time so a stalled apt can't burn the job cap ([#1008](https://github.com/hezo-ai/hezo/pull/1008))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.50.1...0.51.0

## 0.50.1 - 2026-08-18

### Bug Fixes

- **config:** refuse to start when a removed env var still selects the data dir ([#1000](https://github.com/hezo-ai/hezo/pull/1000))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.50.0...0.50.1

## 0.50.0 - 2026-08-18

### Breaking Changes

- configure the hezo binary with a .cjs config file instead of env vars ([#995](https://github.com/hezo-ai/hezo/pull/995))

### Features

- **web:** searchable default-model picker on the AI providers page ([#997](https://github.com/hezo-ai/hezo/pull/997))
- configure the hezo binary with a .cjs config file instead of env vars ([#995](https://github.com/hezo-ai/hezo/pull/995))
- **opencode:** pair tool results, one run summary, always-on reasoning ([#993](https://github.com/hezo-ai/hezo/pull/993))
- **tasks:** pin the task breadcrumb to the top on desktop ([#994](https://github.com/hezo-ai/hezo/pull/994))
- **tasks:** make the progress summary agent-owned and read-only for humans ([#991](https://github.com/hezo-ai/hezo/pull/991))

### Bug Fixes

- **runs:** stop a cancelled run silently dropping the work it was woken for ([#996](https://github.com/hezo-ai/hezo/pull/996))
- **runs:** say why a run failed instead of leaving the reason blank ([#998](https://github.com/hezo-ai/hezo/pull/998))
- **runs:** resolve Codex tool calls in the run log instead of leaving them pending ([#992](https://github.com/hezo-ai/hezo/pull/992))
- **startup:** explain the missing container runtime on Windows before exiting ([#989](https://github.com/hezo-ai/hezo/pull/989))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.49.0...0.50.0

## 0.49.0 - 2026-08-17

### Features

- **runs:** explain what a queued run is waiting for ([#987](https://github.com/hezo-ai/hezo/pull/987))

### Bug Fixes

- **runs:** thread-read cost, false handoff warning, and dead connector descriptors ([#985](https://github.com/hezo-ai/hezo/pull/985))
- **runs:** stop the credential-lock wedge stranding runs and pinning containers ([#986](https://github.com/hezo-ai/hezo/pull/986))
- **web:** scope task-detail panel state to the task being viewed ([#984](https://github.com/hezo-ai/hezo/pull/984))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.48.2...0.49.0

## 0.48.2 - 2026-08-17

### Bug Fixes

- **runs:** stop a config error becoming an unbounded retry storm ([#982](https://github.com/hezo-ai/hezo/pull/982))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.48.1...0.48.2

## 0.48.1 - 2026-08-16

### Bug Fixes

- **connectors:** update the row live once a reconnect completes ([#978](https://github.com/hezo-ai/hezo/pull/978))
- **runs:** show every run by default, and stop calling a never-started run a failure ([#980](https://github.com/hezo-ai/hezo/pull/980))
- **threads:** count every failed run in a collapsed group chip ([#979](https://github.com/hezo-ai/hezo/pull/979))
- **web:** drop the subscription hint under the agent model override ([#977](https://github.com/hezo-ai/hezo/pull/977))

### Documentation

- **dev:** compare container backend costs against Daytona ([#976](https://github.com/hezo-ai/hezo/pull/976))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.48.0...0.48.1

## 0.48.0 - 2026-08-16

### Features

- **hiring:** ask for the heartbeat cadence instead of assuming a default ([#973](https://github.com/hezo-ai/hezo/pull/973))
- **web:** stack the agent run list into readable bands on mobile ([#972](https://github.com/hezo-ai/hezo/pull/972))
- **web:** make the dashboard metric tiles link to their pages ([#971](https://github.com/hezo-ai/hezo/pull/971))

### Bug Fixes

- **runs:** stop idle agents re-running themselves every container start ([#974](https://github.com/hezo-ai/hezo/pull/974))
- **ai-providers:** make the instance default decide, and reach live sessions ([#970](https://github.com/hezo-ai/hezo/pull/970))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.47.0...0.48.0

## 0.47.0 - 2026-08-15

### Features

- **activity:** promote Activity to a top-level page with Log and Hours tabs ([#967](https://github.com/hezo-ai/hezo/pull/967))
- **ai-providers:** expose guided subscription sign-in in the UI ([#966](https://github.com/hezo-ai/hezo/pull/966))
- **web:** make dashboard action-item rows whole-row links ([#965](https://github.com/hezo-ai/hezo/pull/965))

### Other

- Fold Progress into the project dashboard, promote Goals to top-level ([#968](https://github.com/hezo-ai/hezo/pull/968))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.46.0...0.47.0

## 0.46.0 - 2026-08-14

### Features

- **ai-providers:** guided subscription sign-in driven from inside a container ([#962](https://github.com/hezo-ai/hezo/pull/962))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.45.0...0.46.0

## 0.45.0 - 2026-08-13

### Features

- **tasks:** fold the task thread into a conversation, and regroup global settings ([#960](https://github.com/hezo-ai/hezo/pull/960))
- **tasks:** order the task list running, then waiting-on-admin, then the rest ([#951](https://github.com/hezo-ai/hezo/pull/951))
- **agents:** gate a new agent's tasks on its team setup review ([#953](https://github.com/hezo-ai/hezo/pull/953))

### Bug Fixes

- **runtimes:** stop losing every Grok, OpenCode and Kimi run to E2BIG ([#957](https://github.com/hezo-ai/hezo/pull/957))
- **mentions:** a non-addressing active @slug no longer excuses a passive address ([#959](https://github.com/hezo-ai/hezo/pull/959))
- **runs:** park a capacity-blocked run instead of failing it, filter errored runs ([#956](https://github.com/hezo-ai/hezo/pull/956))
- **tasks:** let an agent hand off the task its own run is executing ([#955](https://github.com/hezo-ai/hezo/pull/955))
- **web:** make the whole assignee option the identity-card trigger ([#954](https://github.com/hezo-ai/hezo/pull/954))
- **web:** fit the org chart to its column, scroll below the readable floor ([#952](https://github.com/hezo-ai/hezo/pull/952))

### Refactors

- **prompts:** rewrite agent-facing prose to a Simplified Technical English register ([#958](https://github.com/hezo-ai/hezo/pull/958))

### Other

- Agent identity: role on the team page, name + tooltip everywhere ([#949](https://github.com/hezo-ai/hezo/pull/949))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.44.0...0.45.0

## 0.44.0 - 2026-08-12

### Features

- **marketplace:** fold live-team learnings into the Investment Portfolio team ([#947](https://github.com/hezo-ai/hezo/pull/947))
- surface the team setup task first after creating a project ([#948](https://github.com/hezo-ai/hezo/pull/948))
- **web:** render team and agent summaries as markdown ([#946](https://github.com/hezo-ai/hezo/pull/946))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.43.0...0.44.0

## 0.43.0 - 2026-08-11

### Breaking Changes

- **providers:** remove Prime Agent; matrix the live agent-CLI suite over every provider × CLI ([#926](https://github.com/hezo-ai/hezo/pull/926))

### Features

- **web:** ask how to hire before opening the hire form ([#943](https://github.com/hezo-ai/hezo/pull/943))
- **chat:** drop the task judge from CEO chat turns, catch stranded handoffs structurally ([#944](https://github.com/hezo-ai/hezo/pull/944))
- **providers:** pin default models from each provider's catalog; fix four broken runtimes ([#941](https://github.com/hezo-ai/hezo/pull/941))
- **chat:** convert a conversation into a task assigned to the CEO ([#940](https://github.com/hezo-ai/hezo/pull/940))
- **inbox:** credential requests are inbox rows; dashboards list the inbox's unread set ([#937](https://github.com/hezo-ai/hezo/pull/937))
- **providers:** remove Prime Agent; matrix the live agent-CLI suite over every provider × CLI ([#926](https://github.com/hezo-ai/hezo/pull/926))
- **mcp:** tell an agent how many tools each connector gave its run ([#935](https://github.com/hezo-ai/hezo/pull/935))

### Bug Fixes

- **web:** stop the dashboard reporting container state, and reorder its widgets ([#939](https://github.com/hezo-ai/hezo/pull/939))
- **web:** name each teammate on the team roster instead of listing roles alone ([#938](https://github.com/hezo-ai/hezo/pull/938))
- **connectors:** classify vendor-namespaced MCP tools by their real verb ([#931](https://github.com/hezo-ai/hezo/pull/931))

### Performance

- **mcp:** project tools/list per caller, and declare per-tool facts on the registration ([#932](https://github.com/hezo-ai/hezo/pull/932))

### Tests

- **shared:** cover sanitizeWidgetOrder in the tier that now owns it ([#942](https://github.com/hezo-ai/hezo/pull/942))

### Other

- Say task, not ticket, and close three gaps in the docs ([#936](https://github.com/hezo-ai/hezo/pull/936))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.42.0...0.43.0

## 0.42.0 - 2026-08-11

### Features

- **web:** add per-project Dashboard as the default landing page ([#786](https://github.com/hezo-ai/hezo/pull/786))
- **runner:** count each MCP server's tools in the session banner ([#930](https://github.com/hezo-ai/hezo/pull/930))
- **search:** find assets by name and, for text formats, by their contents ([#929](https://github.com/hezo-ai/hezo/pull/929))
- **providers:** key the per-run config home by runtime, add Prime Agent, collapse kimi_code ([#925](https://github.com/hezo-ai/hezo/pull/925))

### Bug Fixes

- **web:** open dropdown panels above their anchor when there is no room below ([#927](https://github.com/hezo-ai/hezo/pull/927))

### Documentation

- refresh the README for 0.41.1 ([#923](https://github.com/hezo-ai/hezo/pull/923))

### Other

- Human names and generated pixel avatars for agents ([#924](https://github.com/hezo-ai/hezo/pull/924))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.41.1...0.42.0

## 0.41.1 - 2026-08-09

### Bug Fixes

- **mentions:** render passive mentions muted, and judge no-wake per task ([#921](https://github.com/hezo-ai/hezo/pull/921))
- **web:** reconnect on foreground instead of flashing "Connection lost" ([#920](https://github.com/hezo-ai/hezo/pull/920))
- **projects:** make archiving a project actually retire it ([#919](https://github.com/hezo-ai/hezo/pull/919))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.41.0...0.41.1

## 0.41.0 - 2026-08-08

### Features

- **providers:** let an operator replace a stored provider credential ([#915](https://github.com/hezo-ai/hezo/pull/915))

### Bug Fixes

- **containers:** stop one project's idle containers starving every other ([#917](https://github.com/hezo-ai/hezo/pull/917))

### Documentation

- realign container docs with the two-backend architecture, guard doc links at commit time ([#916](https://github.com/hezo-ai/hezo/pull/916))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.40.0...0.41.0

## 0.40.0 - 2026-08-08

### Features

- **providers:** let a credential choose which agent CLI runs it ([#909](https://github.com/hezo-ai/hezo/pull/909))
- **containers:** run agents on a third-party sandbox service, behind one seam
- **web:** remove the All tasks links from the progress columns ([#908](https://github.com/hezo-ai/hezo/pull/908))
- **mcp:** stop agents writing project docs to disk, and fix adjacent defects ([#907](https://github.com/hezo-ai/hezo/pull/907))
- **web:** copy button on rendered markdown code blocks ([#904](https://github.com/hezo-ai/hezo/pull/904))
- **tasks:** raise the sub-task nesting cap from two levels to three ([#905](https://github.com/hezo-ai/hezo/pull/905))
- **mcp:** expose reporting lines on list_agents, batch the team-context tools ([#898](https://github.com/hezo-ai/hezo/pull/898))
- **mcp:** make paging a convention, and teach agents to split oversized work ([#895](https://github.com/hezo-ai/hezo/pull/895))
- **web:** use the globe glyph for the pinned HQ project entry ([#894](https://github.com/hezo-ai/hezo/pull/894))
- **docker:** support Colima and other Docker-compatible runtimes ([#892](https://github.com/hezo-ai/hezo/pull/892))
- **nav:** promote Connectors and Skills to top-level project menu items ([#890](https://github.com/hezo-ai/hezo/pull/890))
- **locale:** preview the picked language in the picker, plus a glyph on its label ([#889](https://github.com/hezo-ai/hezo/pull/889))
- **progress:** make progress a first-class page, with goals as its optional layer ([#888](https://github.com/hezo-ai/hezo/pull/888))

### Bug Fixes

- **git:** stop a merged-and-deleted branch reading as stranded commits ([#911](https://github.com/hezo-ai/hezo/pull/911))
- **connectors:** surface broken connectors, and deliver replies agents strand ([#910](https://github.com/hezo-ai/hezo/pull/910))
- **mentions:** report the wake instead of guessing the ask ([#902](https://github.com/hezo-ai/hezo/pull/902))
- **tasks:** name the cancel control what it does ([#906](https://github.com/hezo-ai/hezo/pull/906))
- **web:** keep the task ID on one line in the task list ([#903](https://github.com/hezo-ai/hezo/pull/903))
- **security:** stop an agent re-pointing a credentialed connector ([#900](https://github.com/hezo-ai/hezo/pull/900))
- **web:** put the run-row expand chevron beside the timestamp ([#897](https://github.com/hezo-ai/hezo/pull/897))
- **progress:** let the activity-column summaries finish instead of clipping them ([#896](https://github.com/hezo-ai/hezo/pull/896))
- **web:** suffix the project info icon to its name, keep the expand tab visible ([#893](https://github.com/hezo-ai/hezo/pull/893))
- **web:** close shell-hosted overlays when the app navigates ([#891](https://github.com/hezo-ai/hezo/pull/891))
- **pwa:** fix the Android home-screen launch - icon, splash and cold-start ([#887](https://github.com/hezo-ai/hezo/pull/887))
- **mentions:** warn on a passive @@slug bound to a sign-off gate ([#886](https://github.com/hezo-ai/hezo/pull/886))
- **archival:** freeze archived assets and docs against every writer ([#885](https://github.com/hezo-ai/hezo/pull/885))

### Documentation

- realign AGENTS.md with the codebase and the .dev docs ([#899](https://github.com/hezo-ai/hezo/pull/899))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.39.0...0.40.0

## 0.39.0 - 2026-07-31

### Features

- **attachments:** accept archive files on comments and in the asset library ([#881](https://github.com/hezo-ai/hezo/pull/881))
- **tasks:** name the comment a task link came from, and translate system events ([#879](https://github.com/hezo-ai/hezo/pull/879))
- **tasks:** edit a task's title and description in place ([#877](https://github.com/hezo-ai/hezo/pull/877))
- **concurrency:** reserve 1GB of host memory from the automatic container limit ([#875](https://github.com/hezo-ai/hezo/pull/875))
- **goals:** confirm before archiving a goal ([#876](https://github.com/hezo-ai/hezo/pull/876))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.38.0...0.39.0

## 0.38.0 - 2026-07-30

### Features

- **i18n:** fail the catalog guard on keys that never reach a screen ([#872](https://github.com/hezo-ai/hezo/pull/872))
- **agents:** file recurring asks as standing tasks with a child per round ([#873](https://github.com/hezo-ai/hezo/pull/873))
- run containers on demand with a global container limit and RAM caps ([#871](https://github.com/hezo-ai/hezo/pull/871))
- **runtimes:** add Kimi Code as a runtime alongside Kimi on Claude Code ([#869](https://github.com/hezo-ai/hezo/pull/869))
- make Hezo locale-aware (language, date format, currency format) ([#862](https://github.com/hezo-ai/hezo/pull/862))
- **tasks:** let a task's parent be changed or cleared ([#866](https://github.com/hezo-ai/hezo/pull/866))
- **prompts:** route post-delegation feedback to the delegate instead of absorbing it ([#865](https://github.com/hezo-ai/hezo/pull/865))
- **marketplace:** add individual roles from a team to a project ([#864](https://github.com/hezo-ai/hezo/pull/864))

### Bug Fixes

- **web:** let users dismiss the reconnecting toast, with a 20s snooze ([#870](https://github.com/hezo-ai/hezo/pull/870))
- **web:** drop inline Model pricing blurb duplicated by the help dialog ([#867](https://github.com/hezo-ai/hezo/pull/867))

### Other

- Remove duplicate deploy badges from README header ([#868](https://github.com/hezo-ai/hezo/pull/868))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.37.0...0.38.0

## 0.37.0 - 2026-07-29

### Features

- **agents:** check cross-task impact before acting ([#860](https://github.com/hezo-ai/hezo/pull/860))

### Bug Fixes

- stop the MCP endpoint stalling under concurrent agent requests ([#859](https://github.com/hezo-ai/hezo/pull/859))
- **startup:** stop the OOM crash-loop on upgrade, and stream backup/restore both ways ([#858](https://github.com/hezo-ai/hezo/pull/858))
- **web:** show the HQ menu on /home before the first project exists ([#857](https://github.com/hezo-ai/hezo/pull/857))

### Performance

- server stack review - memory, DB throughput, egress and control-plane load at 10 concurrent agents ([#861](https://github.com/hezo-ai/hezo/pull/861))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.36.0...0.37.0

## 0.36.0 - 2026-07-28

### Features

- **ai-providers:** add Ollama + LM Studio, surface OpenRouter in the add dialog ([#852](https://github.com/hezo-ai/hezo/pull/852))
- **marketplace:** export a live team as a downloadable bundle ([#850](https://github.com/hezo-ai/hezo/pull/850))

### Bug Fixes

- **web:** repair the truncated PWA icons and give the maskable one a safe zone ([#855](https://github.com/hezo-ai/hezo/pull/855))
- **deploy:** stop unattended upgrades restarting Hezo into a locked state ([#854](https://github.com/hezo-ai/hezo/pull/854))
- **deploy:** provision swap so low-RAM VPSes don't OOM-kill Hezo ([#853](https://github.com/hezo-ai/hezo/pull/853))
- **web:** sort the Done task list by last-updated, newest first ([#851](https://github.com/hezo-ai/hezo/pull/851))
- **agents:** wake the approver on a stranded "awaiting sign-off" handoff ([#849](https://github.com/hezo-ai/hezo/pull/849))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.35.0...0.36.0

## 0.35.0 - 2026-07-27

### Features

- **mcp:** page large project docs via read_project_doc byte windows ([#846](https://github.com/hezo-ai/hezo/pull/846))
- **chat:** queue messages while the CEO replies, hold to interrupt ([#842](https://github.com/hezo-ai/hezo/pull/842))
- **web:** show project icons and agent avatars across dashboard and inbox ([#843](https://github.com/hezo-ai/hezo/pull/843))

### Bug Fixes

- **mentions:** reserve the line-leading address shape for active mentions ([#841](https://github.com/hezo-ai/hezo/pull/841))
- **oauth,egress:** stop MCP token-refresh log flood and demote SSE teardown noise ([#844](https://github.com/hezo-ai/hezo/pull/844))
- **web:** wrap long links in chat bubbles; remember the last chat thread ([#840](https://github.com/hezo-ai/hezo/pull/840))

### Documentation

- make project doc description an overall summary, not a content inventory ([#847](https://github.com/hezo-ai/hezo/pull/847))

### Other

- Update product headline to "Built to deliver." ([#845](https://github.com/hezo-ai/hezo/pull/845))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.34.0...0.35.0

## 0.34.0 - 2026-07-27

### Features

- **connectors:** granular method access for MCP connectors ([#836](https://github.com/hezo-ai/hezo/pull/836))
- **web:** demote the GitHub connector on teams that don't touch code ([#835](https://github.com/hezo-ai/hezo/pull/835))
- **web:** drag to re-order projects in the project rail ([#830](https://github.com/hezo-ai/hezo/pull/830))
- **mentions:** catch baton-passing passive handoffs and narrated live mentions ([#829](https://github.com/hezo-ai/hezo/pull/829))
- **web:** offer document download on the preview panel and preview tab ([#826](https://github.com/hezo-ai/hezo/pull/826))
- **restore:** show progress while restoring large databases and asset bundles ([#824](https://github.com/hezo-ai/hezo/pull/824))
- extend the headline with "Built to ship." ([#822](https://github.com/hezo-ai/hezo/pull/822))
- suggest shippable-MVP goal when App Team builds an app ([#821](https://github.com/hezo-ai/hezo/pull/821))
- **web:** beautify the "can't reach the server" screen ([#819](https://github.com/hezo-ai/hezo/pull/819))

### Bug Fixes

- **repos:** make repo push access visible instead of silently denied ([#837](https://github.com/hezo-ai/hezo/pull/837))
- **ci:** keep fork pull requests green when GHCR isn't writable ([#833](https://github.com/hezo-ai/hezo/pull/833))
- **db:** honour libpq sslmode semantics for external Postgres ([#832](https://github.com/hezo-ai/hezo/pull/832))
- **tasks:** stop the assignee reading "Running" when no agent is running ([#831](https://github.com/hezo-ai/hezo/pull/831))
- **web:** make the New Project team list fill the dialog, and open teams in it ([#827](https://github.com/hezo-ai/hezo/pull/827))
- **marketplace:** team suggestions match whole words, ranked on team-authored keywords ([#825](https://github.com/hezo-ai/hezo/pull/825))
- **web:** deliver the container-provisioning-complete signal in situ ([#823](https://github.com/hezo-ai/hezo/pull/823))

### Documentation

- ban em and en dashes from user-facing prose ([#838](https://github.com/hezo-ai/hezo/pull/838))

### Other

- Rebrand tagline; rename marketplace teams to Social Media Marketing and Investment Portfolio ([#820](https://github.com/hezo-ai/hezo/pull/820))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.33.0...0.34.0

## 0.33.0 - 2026-07-23

### Features

- append-only run-log chunk storage to eliminate TOAST write-amplification ([#817](https://github.com/hezo-ai/hezo/pull/817))
- run-log compaction to reclaim database size ([#815](https://github.com/hezo-ai/hezo/pull/815))
- prune control for old embedded-DB snapshots ([#813](https://github.com/hezo-ai/hezo/pull/813))

### Bug Fixes

- **goals:** goals are admin-owned outcomes; recurring work runs as standing tasks ([#816](https://github.com/hezo-ai/hezo/pull/816))
- **backup:** page logical dump/restore by bytes to survive large-log tables ([#814](https://github.com/hezo-ai/hezo/pull/814))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.32.0...0.33.0

## 0.32.0 - 2026-07-22

### Features

- **mentions:** warn on action-assignment passive asks + verdict-report mention guidance ([#809](https://github.com/hezo-ai/hezo/pull/809))

### Bug Fixes

- **prompts:** stop agents delegating the done-transition to the admin ([#808](https://github.com/hezo-ai/hezo/pull/808))
- **goals:** steer agents away from suggesting one-off deliverables as goals ([#807](https://github.com/hezo-ai/hezo/pull/807))
- **web:** heal stale goal-suggestion cards on version skew + explain goals ([#805](https://github.com/hezo-ai/hezo/pull/805))
- **mcp:** accept human identifiers (not only UUIDs) across reference params ([#803](https://github.com/hezo-ai/hezo/pull/803))
- **coherence:** title the first-run setup ticket "Set up the team" ([#802](https://github.com/hezo-ai/hezo/pull/802))
- **project-intake:** stop echoing the project description in the CEO greeting ([#801](https://github.com/hezo-ai/hezo/pull/801))

### Refactors

- **web:** progressive suggestion-first New Project dialog ([#806](https://github.com/hezo-ai/hezo/pull/806))

### Documentation

- **readme:** surface Slack, Telegram, and Discord chat integrations ([#804](https://github.com/hezo-ai/hezo/pull/804))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.31.0...0.32.0

## 0.31.0 - 2026-07-22

### Breaking Changes

- **chat:** per-surface chat threads with the web as the hub — Slack, Telegram & Discord in assistant + coworker modes ([#794](https://github.com/hezo-ai/hezo/pull/794))

### Features

- **chat:** per-surface chat threads with the web as the hub — Slack, Telegram & Discord in assistant + coworker modes ([#794](https://github.com/hezo-ai/hezo/pull/794))
- **marketplace:** add Influencer Marketing + Investment teams, goal suggestions, App Team rename ([#713](https://github.com/hezo-ai/hezo/pull/713))

### Bug Fixes

- **release:** never auto-bump the major version from breaking changes ([#799](https://github.com/hezo-ai/hezo/pull/799))
- **marketplace:** wire roster reporting lines to the Captain on provisioning ([#796](https://github.com/hezo-ai/hezo/pull/796))
- **agents:** load skills only via get_skill, never the CLI's own skill feature ([#795](https://github.com/hezo-ai/hezo/pull/795))
- **cli:** add `hezo uninstall` to cleanly remove the data directory ([#793](https://github.com/hezo-ai/hezo/pull/793))

### Documentation

- dedicated "Chat & messaging apps" section; sync website docs on release publish ([#797](https://github.com/hezo-ai/hezo/pull/797))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.30.1...0.31.0

## 0.30.1 - 2026-07-21

### Bug Fixes

- **runtime:** never strand in-container process trees; sweep leftovers at boot ([#790](https://github.com/hezo-ai/hezo/pull/790))
- **cli:** honor HEZO_DATA_DIR in `hezo backup` / `hezo restore` ([#788](https://github.com/hezo-ai/hezo/pull/788))

### Documentation

- accuracy audit + enforced docs-alignment acknowledgment on commits ([#789](https://github.com/hezo-ai/hezo/pull/789))
- **deploy:** step-by-step managed Postgres + object storage for cloud deploys ([#787](https://github.com/hezo-ai/hezo/pull/787))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.30.0...0.30.1

## 0.30.0 - 2026-07-20

### Features

- **avatars:** built-in CEO/Coach defaults + show agent avatars everywhere ([#784](https://github.com/hezo-ai/hezo/pull/784))
- **chat:** title new chat threads from the first message, in parallel with the reply ([#783](https://github.com/hezo-ai/hezo/pull/783))
- **documents:** give project docs a description ("what this is") ([#781](https://github.com/hezo-ai/hezo/pull/781))
- restyle mobile top-nav Add Task button as outlined icon ([#777](https://github.com/hezo-ai/hezo/pull/777))
- **logs:** preserve thinking line breaks in the formatted log view ([#778](https://github.com/hezo-ai/hezo/pull/778))

### Bug Fixes

- move PWA install banner to top of viewport ([#782](https://github.com/hezo-ai/hezo/pull/782))
- **comments:** show the author's avatar in the task thread ([#779](https://github.com/hezo-ai/hezo/pull/779))

### Documentation

- define skills vs docs by kind, not scope ([#780](https://github.com/hezo-ai/hezo/pull/780))

### Chores

- update images

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.29.0...0.30.0

## 0.29.0 - 2026-07-19

### Features

- **assets:** give agents image dimensions + inline image, and surface the run container toolset ([#774](https://github.com/hezo-ai/hezo/pull/774))
- **agents:** capture discovered techniques as reusable skills ([#775](https://github.com/hezo-ai/hezo/pull/775))
- **web:** add reconnecting connection toast and move toasts to top-right ([#772](https://github.com/hezo-ai/hezo/pull/772))
- **web:** relative "X ago" timestamps via date-fns with date tooltip ([#765](https://github.com/hezo-ai/hezo/pull/765))
- **web:** infinite scroll for skills, connectors, credentials & runs lists ([#766](https://github.com/hezo-ai/hezo/pull/766))

### Bug Fixes

- **assets:** stream large binary uploads to an exact path in one call ([#773](https://github.com/hezo-ai/hezo/pull/773))
- **mcp:** warn on backticked asset links that drop the assets/ prefix ([#771](https://github.com/hezo-ai/hezo/pull/771))
- **runner:** deliver a stranded direct answer to a human's reply/mention as a comment ([#770](https://github.com/hezo-ai/hezo/pull/770))
- **mentions:** warn on routing-label handoffs like "Next step: captain —" ([#769](https://github.com/hezo-ai/hezo/pull/769))
- **web:** dim the page behind the mobile chat panel ([#767](https://github.com/hezo-ai/hezo/pull/767))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.28.0...0.29.0

## 0.28.0 - 2026-07-19

### Features

- **comments:** lazy-load comment bodies on scroll-dwell ([#763](https://github.com/hezo-ai/hezo/pull/763))
- **web:** show keyboard shortcuts as inset keycaps on buttons ([#761](https://github.com/hezo-ai/hezo/pull/761))
- **web:** render markdown text preview in asset thumbnails ([#760](https://github.com/hezo-ai/hezo/pull/760))

### Bug Fixes

- **runs:** actually kill the agent process on terminate/timeout ([#762](https://github.com/hezo-ai/hezo/pull/762))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.27.0...0.28.0

## 0.27.0 - 2026-07-18

### Features

- **agents:** make loading relevant skills mandatory before any write/edit ([#758](https://github.com/hezo-ai/hezo/pull/758))
- **avatars:** custom avatars for agents and the admin user ([#756](https://github.com/hezo-ai/hezo/pull/756))
- show updated time on asset cards with hover timestamp ([#755](https://github.com/hezo-ai/hezo/pull/755))
- use a dropdown chevron for the in-viewer name switcher ([#754](https://github.com/hezo-ai/hezo/pull/754))
- **chat:** "New thread" naming, CEO auto-titling, and expanded thread sidebar ([#753](https://github.com/hezo-ai/hezo/pull/753))
- switch viewed document/asset via in-viewer name search ([#752](https://github.com/hezo-ai/hezo/pull/752))

### Bug Fixes

- rank exact identifier/number matches first in task search ([#757](https://github.com/hezo-ai/hezo/pull/757))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.26.0...0.27.0

## 0.26.0 - 2026-07-17

### Features

- **runtime:** derive Claude Code judge + subagent models from the run's model ([#746](https://github.com/hezo-ai/hezo/pull/746))
- load models dynamically on every model-selection surface ([#745](https://github.com/hezo-ai/hezo/pull/745))

### Bug Fixes

- let the per-project skill viewer read global skills by id ([#750](https://github.com/hezo-ai/hezo/pull/750))
- prevent asset viewer scroll jump when adding a review comment ([#749](https://github.com/hezo-ai/hezo/pull/749))
- warn on backticked asset paths even before the asset exists ([#747](https://github.com/hezo-ai/hezo/pull/747))
- **web:** centre scroll pills over the scrolled content column ([#744](https://github.com/hezo-ai/hezo/pull/744))
- **logs:** record whole agent run log without per-line truncation ([#743](https://github.com/hezo-ai/hezo/pull/743))

### Other

- Warn on stranded bold-name handoffs in a run's final message ([#748](https://github.com/hezo-ai/hezo/pull/748))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.25.1...0.26.0

## 0.25.1 - 2026-07-15

### Bug Fixes

- make asset PNG downloads work and reject truncated binary uploads ([#741](https://github.com/hezo-ai/hezo/pull/741))

### Documentation

- **deployment:** add real one-click buttons to the one-click deploy page ([#740](https://github.com/hezo-ai/hezo/pull/740))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.25.0...0.25.1

## 0.25.0 - 2026-07-15

### Features

- **chat:** mirror conversation threads across channels (create/message/close parity) ([#737](https://github.com/hezo-ai/hezo/pull/737))
- load default teams from a marketplace instead of the binary ([#733](https://github.com/hezo-ai/hezo/pull/733))
- **deploy:** add AWS and GCP one-click deploy buttons ([#723](https://github.com/hezo-ai/hezo/pull/723))
- **assets:** add sort control to the project Assets page ([#728](https://github.com/hezo-ai/hezo/pull/728))
- mark an inbox notification read when its comment is viewed ([#727](https://github.com/hezo-ai/hezo/pull/727))

### Bug Fixes

- **deploy:** use ASCII in AWS CloudFormation template ([#731](https://github.com/hezo-ai/hezo/pull/731))

### Documentation

- **agents:** add worked example against backticking doc/asset references ([#735](https://github.com/hezo-ai/hezo/pull/735))
- **readme:** wire the AWS Launch Stack button to the hosted template ([#732](https://github.com/hezo-ai/hezo/pull/732))
- **readme:** add deploy buttons to the top and make GCP one-click ([#729](https://github.com/hezo-ai/hezo/pull/729))

### Other

- **release:** auto-publish the AWS CloudFormation template to S3 ([#734](https://github.com/hezo-ai/hezo/pull/734))
- launch via the standard create-project dialog, count the Captain, drop bundled skills/MCP/MPP ([#738](https://github.com/hezo-ai/hezo/pull/738))
- Fix mobile keyboard gap below the comment composer ([#736](https://github.com/hezo-ai/hezo/pull/736))
- Telegram chat channel + multi-threaded CEO conversations (Discord deferred) ([#730](https://github.com/hezo-ai/hezo/pull/730))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.24.1...0.25.0

## 0.24.1 - 2026-07-14

### Features

- **assets:** frame the assets library as a shared store agents reuse ([#725](https://github.com/hezo-ai/hezo/pull/725))
- **assets:** let agents write binary assets and upload generated deliverables ([#724](https://github.com/hezo-ai/hezo/pull/724))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.24.0...0.24.1

## 0.24.0 - 2026-07-14

### Features

- allow removing a pending connector from the project Connectors page ([#721](https://github.com/hezo-ai/hezo/pull/721))
- teach agents there is no cron; recurring work uses heartbeats and goals ([#719](https://github.com/hezo-ai/hezo/pull/719))
- audit carried-over project specifics in team coherence review ([#717](https://github.com/hezo-ai/hezo/pull/717))

### Bug Fixes

- **oauth:** re-register a DCR client when the callback origin changed ([#720](https://github.com/hezo-ai/hezo/pull/720))
- **web:** surface the PWA install banner when beforeinstallprompt fires before mount ([#718](https://github.com/hezo-ai/hezo/pull/718))
- improve global skills page row readability ([#716](https://github.com/hezo-ai/hezo/pull/716))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.23.0...0.24.0

## 0.23.0 - 2026-07-13

### Features

- assign reactive team-coherence reviews to the Captain ([#714](https://github.com/hezo-ai/hezo/pull/714))
- project Custom Prompt tools, run-log MCP access, and a settings page ([#711](https://github.com/hezo-ai/hezo/pull/711))
- **skills:** auto-install default skills on a fresh instance ([#712](https://github.com/hezo-ai/hezo/pull/712))
- **egress:** stop logging egress requests to the activity feed ([#709](https://github.com/hezo-ai/hezo/pull/709))
- **skills:** install default skills via opt-in button, not at boot ([#710](https://github.com/hezo-ai/hezo/pull/710))
- **skills:** ship 15 default global skills with hash-gated seeding ([#708](https://github.com/hezo-ai/hezo/pull/708))
- **backup:** carry asset blobs in hezo backup/restore bundles ([#707](https://github.com/hezo-ai/hezo/pull/707))
- **web:** show scroll pills only while actively scrolling that direction ([#706](https://github.com/hezo-ai/hezo/pull/706))
- **connectors:** first-class read-only YouTube via API key ([#705](https://github.com/hezo-ai/hezo/pull/705))

### Bug Fixes

- **web:** stop Formatted-view tooltip opening when log viewer expands ([#704](https://github.com/hezo-ai/hezo/pull/704))
- **web:** move project menu collapse button into the top-right corner ([#703](https://github.com/hezo-ai/hezo/pull/703))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.22.1...0.23.0

## 0.22.1 - 2026-07-12

### Bug Fixes

- **ci:** merge shard coverage in JSON space so branch totals survive sharding ([#701](https://github.com/hezo-ai/hezo/pull/701))
- **oauth:** accept Google's verification_url in the device flow ([#700](https://github.com/hezo-ai/hezo/pull/700))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.22.0...0.22.1

## 0.22.0 - 2026-07-12

### Features

- **skills:** add view modal for all skills; show connector-recipes on project pages ([#697](https://github.com/hezo-ai/hezo/pull/697))
- **connectors:** complete agent-requested connections in place ([#698](https://github.com/hezo-ai/hezo/pull/698))

### Bug Fixes

- stack connector row header on mobile ([#696](https://github.com/hezo-ai/hezo/pull/696))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.21.0...0.22.0

## 0.21.0 - 2026-07-12

### Features

- **agents:** guide agents to author and maintain skills for connected services ([#693](https://github.com/hezo-ai/hezo/pull/693))
- **connectors:** curate, expand, and consolidate the connector registry ([#691](https://github.com/hezo-ai/hezo/pull/691))
- **connectors:** generic OAuth credential broker (device flow + host-side refresh) ([#690](https://github.com/hezo-ai/hezo/pull/690))
- **connectors:** add connector registry and virtual recipes skill ([#689](https://github.com/hezo-ai/hezo/pull/689))
- **connectors:** add direct-API connector transport ([#688](https://github.com/hezo-ai/hezo/pull/688))
- **web:** collapsible project side menu ([#686](https://github.com/hezo-ai/hezo/pull/686))

### Refactors

- **connectors:** rename MCP-connection surface to generic connector surface ([#687](https://github.com/hezo-ai/hezo/pull/687))

### Documentation

- reflect the connector architecture beyond MCP ([#694](https://github.com/hezo-ai/hezo/pull/694))

### Other

- fan test-backend and test-integration out to 5 shards ([#692](https://github.com/hezo-ai/hezo/pull/692))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.20.0...0.21.0

## 0.20.0 - 2026-07-11

### Features

- prefix task-mention tooltip title with bold task identifier ([#684](https://github.com/hezo-ai/hezo/pull/684))
- **web:** rework master-key onboarding and auth panes UI ([#682](https://github.com/hezo-ai/hezo/pull/682))
- **projects:** add archive/unarchive ([#678](https://github.com/hezo-ai/hezo/pull/678))
- **server:** authenticate the egress proxy and harden agent containers ([#675](https://github.com/hezo-ai/hezo/pull/675))
- **web:** combine database + asset storage into a split-view Storage section ([#674](https://github.com/hezo-ai/hezo/pull/674))

### Bug Fixes

- scroll-to-top stalling partway on mobile ([#681](https://github.com/hezo-ai/hezo/pull/681))
- keep mobile comment header on one row via truncated timestamp ([#679](https://github.com/hezo-ai/hezo/pull/679))
- **web:** show mobile review dialogs above the preview panel; tidy inbox mark-all button ([#677](https://github.com/hezo-ai/hezo/pull/677))
- fail runs that abandon background work; relax premature CLI timeouts ([#676](https://github.com/hezo-ai/hezo/pull/676))

### Refactors

- remove the document status field ([#680](https://github.com/hezo-ai/hezo/pull/680))

### Other

- Update product tagline to "Built to ship" ([#683](https://github.com/hezo-ai/hezo/pull/683))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.19.0...0.20.0

## 0.19.0 - 2026-07-10

### Features

- request in-container tool credentials via project-scoped MCP connections ([#668](https://github.com/hezo-ai/hezo/pull/668))
- add Log out button to the settings menu ([#665](https://github.com/hezo-ai/hezo/pull/665))
- clarify master-key onboarding with confirm step and masked words ([#666](https://github.com/hezo-ai/hezo/pull/666))

### Bug Fixes

- remove Claude Code headless background-task wait ceiling ([#672](https://github.com/hezo-ai/hezo/pull/672))
- **web:** collapse run entries by default; add a scroll-to-top button ([#669](https://github.com/hezo-ai/hezo/pull/669))

### Other

- Review comments for assets + split-pane asset viewer ([#667](https://github.com/hezo-ai/hezo/pull/667))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.18.0...0.19.0

## 0.18.0 - 2026-07-10

### Features

- **server:** warn agents when a passive @@mention was meant as an active ask ([#663](https://github.com/hezo-ai/hezo/pull/663))
- add "Mark all as read" button to inbox toolbar ([#661](https://github.com/hezo-ai/hezo/pull/661))
- auto-prune worktrees for closed tasks and in admin prune button ([#656](https://github.com/hezo-ai/hezo/pull/656))

### Bug Fixes

- let admins react to comments in teams they aren't a member of ([#662](https://github.com/hezo-ai/hezo/pull/662))
- shorten docs library button label to "New" ([#660](https://github.com/hezo-ai/hezo/pull/660))
- **web:** link project-scoped "Added skill" to the project Skills page ([#659](https://github.com/hezo-ai/hezo/pull/659))
- **web:** make the active folder tab's bottom border !important ([#657](https://github.com/hezo-ai/hezo/pull/657))
- **web:** strip redundant backticks so inline code renders as clean chips ([#658](https://github.com/hezo-ai/hezo/pull/658))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.17.0...0.18.0

## 0.17.0 - 2026-07-09

### Features

- **ai:** add xAI Grok Build as a provider + runtime ([#652](https://github.com/hezo-ai/hezo/pull/652))
- **connectors:** restore revoked connectors in place + add-connector on project page ([#651](https://github.com/hezo-ai/hezo/pull/651))
- **web:** brand logos for OpenAI, DeepSeek, z.ai, and Kimi in the AI provider picker ([#650](https://github.com/hezo-ai/hezo/pull/650))
- expandable, auto-growing task comment input ([#647](https://github.com/hezo-ai/hezo/pull/647))
- show connector↔credential relationships with project-aware naming ([#645](https://github.com/hezo-ai/hezo/pull/645))

### Bug Fixes

- make agents post a comment when they act on, or answer, a mention ([#654](https://github.com/hezo-ai/hezo/pull/654))
- deliver stranded final-message handoffs as comments ([#653](https://github.com/hezo-ai/hezo/pull/653))
- **web:** remove stray bottom border on the active folder tab ([#649](https://github.com/hezo-ai/hezo/pull/649))

### Documentation

- **dev:** Grok Build support design & feasibility assessment ([#648](https://github.com/hezo-ai/hezo/pull/648))

### Other

- Scope skills per-project or global (like Connectors) ([#646](https://github.com/hezo-ai/hezo/pull/646))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.16.0...0.17.0

## 0.16.0 - 2026-07-08

### Features

- **web:** label icon-only add-item buttons on desktop ([#642](https://github.com/hezo-ai/hezo/pull/642))
- **web:** status pill + terminal strikethrough in task-mention tooltip ([#641](https://github.com/hezo-ai/hezo/pull/641))
- remove CEO onboarding phase banner ([#640](https://github.com/hezo-ai/hezo/pull/640))
- **concurrency:** raise default max concurrent runs per project to 10 ([#638](https://github.com/hezo-ai/hezo/pull/638))
- **chat:** realtime chatbox file uploads + generalize chat schema and naming ([#639](https://github.com/hezo-ai/hezo/pull/639))
- **ai-providers:** "verified" status and a single global default ([#637](https://github.com/hezo-ai/hezo/pull/637))
- **connectors:** api-key auth via egress placeholders; stop token materialization ([#636](https://github.com/hezo-ai/hezo/pull/636))
- **web:** add Upload button to comment composer, extract reusable file-attachment kit ([#634](https://github.com/hezo-ai/hezo/pull/634))

### Bug Fixes

- **stop-hook:** block final-message-only handoffs the judge wrongly allowed ([#643](https://github.com/hezo-ai/hezo/pull/643))
- **assets:** name comment upload folders after task ID, not title ([#633](https://github.com/hezo-ai/hezo/pull/633))
- **updates:** unstick restart overlay and correct its master-key copy ([#632](https://github.com/hezo-ai/hezo/pull/632))

### Refactors

- **web:** folder-style tab bars via a reusable Tabs component ([#635](https://github.com/hezo-ai/hezo/pull/635))

### Documentation

- **dev:** add Docker→microVM feasibility assessment ([#631](https://github.com/hezo-ai/hezo/pull/631))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.15.4...0.16.0

## 0.15.4 - 2026-07-07

### Features

- standardize comment wakeups on active @-mentions ([#624](https://github.com/hezo-ai/hezo/pull/624))
- surface waking comment and recent comments in agent run prompts ([#623](https://github.com/hezo-ai/hezo/pull/623))
- surface Edit and History on all document views ([#621](https://github.com/hezo-ai/hezo/pull/621))
- **agents:** track the full approval chain before closing a ticket ([#617](https://github.com/hezo-ai/hezo/pull/617))
- **web:** default inbox to unread and reorder tab pills ([#616](https://github.com/hezo-ai/hezo/pull/616))

### Bug Fixes

- point agents at on-disk worktrees for connected repos ([#629](https://github.com/hezo-ai/hezo/pull/629))
- **web:** relabel repo button to "Add repo" above the repo list ([#628](https://github.com/hezo-ai/hezo/pull/628))
- **connectors:** show local (credential-auth) connectors as Connected ([#626](https://github.com/hezo-ai/hezo/pull/626))
- keep document preview panel top pinned on scroll ([#622](https://github.com/hezo-ai/hezo/pull/622))
- restore clipped bottom border on org-chart bottom-row agent cards ([#620](https://github.com/hezo-ai/hezo/pull/620))
- gate repo git reset on active runs and surface real API errors ([#619](https://github.com/hezo-ai/hezo/pull/619))
- **git:** recover a stranded initial commit when the seed push fails ([#615](https://github.com/hezo-ai/hezo/pull/615))

### Other

- **release:** grant actions:write so agent-base cache export can't fail the release ([#627](https://github.com/hezo-ai/hezo/pull/627))
- Simplify README Features section ([#618](https://github.com/hezo-ai/hezo/pull/618))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.15.3...0.15.4

## 0.16.0 - 2026-07-07

### Features

- standardize comment wakeups on active @-mentions ([#624](https://github.com/hezo-ai/hezo/pull/624))
- surface waking comment and recent comments in agent run prompts ([#623](https://github.com/hezo-ai/hezo/pull/623))
- surface Edit and History on all document views ([#621](https://github.com/hezo-ai/hezo/pull/621))
- **agents:** track the full approval chain before closing a ticket ([#617](https://github.com/hezo-ai/hezo/pull/617))
- **web:** default inbox to unread and reorder tab pills ([#616](https://github.com/hezo-ai/hezo/pull/616))

### Bug Fixes

- keep document preview panel top pinned on scroll ([#622](https://github.com/hezo-ai/hezo/pull/622))
- restore clipped bottom border on org-chart bottom-row agent cards ([#620](https://github.com/hezo-ai/hezo/pull/620))
- gate repo git reset on active runs and surface real API errors ([#619](https://github.com/hezo-ai/hezo/pull/619))
- **git:** recover a stranded initial commit when the seed push fails ([#615](https://github.com/hezo-ai/hezo/pull/615))

### Other

- Simplify README Features section ([#618](https://github.com/hezo-ai/hezo/pull/618))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.15.3...0.16.0

## 0.15.3 - 2026-07-06

### Features

- admin git repository state panel with recovery actions ([#611](https://github.com/hezo-ai/hezo/pull/611))
- **git:** seed an initial commit for empty connected repos at runtime ([#613](https://github.com/hezo-ai/hezo/pull/613))
- **web:** edit connector scope inline instead of a top filter ([#610](https://github.com/hezo-ai/hezo/pull/610))

### Bug Fixes

- stop agents spinning while awaiting admin approval ([#612](https://github.com/hezo-ai/hezo/pull/612))
- **web:** keep the version-update UI polling so it advances without a reload ([#609](https://github.com/hezo-ai/hezo/pull/609))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.15.2...0.15.3

## 0.15.2 - 2026-07-06

### Features

- scope OAuth accounts and MCP connectors per project ([#607](https://github.com/hezo-ai/hezo/pull/607))
- **web:** drag to resize the document preview panel ([#606](https://github.com/hezo-ai/hezo/pull/606))
- **web:** show task status in the task meta panel ([#605](https://github.com/hezo-ai/hezo/pull/605))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.15.1...0.15.2

## 0.15.1 - 2026-07-06

### Bug Fixes

- **git:** repair a clone stuck at git clone's .invalid HEAD sentinel ([#603](https://github.com/hezo-ai/hezo/pull/603))

### Other

- **release:** gate GitHub Release on agent-base image publish ([#602](https://github.com/hezo-ai/hezo/pull/602))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.15.0...0.15.1

## 0.15.0 - 2026-07-06

### Features

- **updates:** auto-install staged updates via --auto-install-updates / HEZO_AUTO_INSTALL_UPDATES ([#596](https://github.com/hezo-ai/hezo/pull/596))

### Bug Fixes

- **containers:** pin container MTU to the host egress MTU on VPN/mesh hosts ([#600](https://github.com/hezo-ai/hezo/pull/600))
- **runs:** stop a stalled git fetch from hanging a run forever ([#599](https://github.com/hezo-ai/hezo/pull/599))
- **repos:** run repo checkout setup in the background instead of inside POST /repos ([#595](https://github.com/hezo-ai/hezo/pull/595))
- **web:** wrap container controls on mobile and add confirm-dialog close button ([#593](https://github.com/hezo-ai/hezo/pull/593))

### Documentation

- **dev:** consolidate hosted-architecture into the full hosted design ([#594](https://github.com/hezo-ai/hezo/pull/594))

### Build System

- **docker:** use Debian-packaged git in agent-base image ([#592](https://github.com/hezo-ai/hezo/pull/592))

### Tests

- raise combined line coverage from 84.6% to 96.1% ([#597](https://github.com/hezo-ai/hezo/pull/597))

### Other

- **web:** strengthen read/unread styling on inbox mention cards ([#598](https://github.com/hezo-ai/hezo/pull/598))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.14.0...0.15.0

## 0.14.0 - 2026-07-05

### Features

- **web:** filterable Add-to-task picker in the action review dialog ([#585](https://github.com/hezo-ai/hezo/pull/585))

### Bug Fixes

- **server:** self-heal broken cached repo clones during repo sync ([#588](https://github.com/hezo-ai/hezo/pull/588))
- **web:** render reaction picker above adjacent comments ([#587](https://github.com/hezo-ai/hezo/pull/587))
- **web:** use "Install & restart" label and readable overlay copy ([#584](https://github.com/hezo-ai/hezo/pull/584))

### Documentation

- reflect the abstracted asset storage layer in README, introduction, and meta-harness ([#590](https://github.com/hezo-ai/hezo/pull/590))
- **readme:** note optional hosted Postgres in the storage feature ([#586](https://github.com/hezo-ai/hezo/pull/586))

### Chores

- relicense from MIT to GPL-3.0-or-later ([#583](https://github.com/hezo-ai/hezo/pull/583))

### Other

- Asset storage abstraction: local filesystem + S3-compatible object storage ([#589](https://github.com/hezo-ai/hezo/pull/589))
- Database storage abstraction: embedded PGlite + external hosted Postgres ([#577](https://github.com/hezo-ai/hezo/pull/577))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.13.0...0.14.0

## 0.13.0 - 2026-07-05

### Features

- **web:** rename AI provider configs in place ([#580](https://github.com/hezo-ai/hezo/pull/580))
- archive (soft delete) for project docs and assets ([#579](https://github.com/hezo-ai/hezo/pull/579))
- **web:** add-to-task button in the action-review dialog ([#578](https://github.com/hezo-ai/hezo/pull/578))
- **web:** standardize in-place add/edit forms behind a shared InPlaceForm panel ([#574](https://github.com/hezo-ai/hezo/pull/574))
- **web:** collapsible document list on the Documents page ([#566](https://github.com/hezo-ai/hezo/pull/566))
- **web:** add Tasks root breadcrumb on task detail page ([#570](https://github.com/hezo-ai/hezo/pull/570))
- **coherence:** audit verification coverage in team coherence reviews ([#569](https://github.com/hezo-ai/hezo/pull/569))
- **docs:** document status (planning/approved) in the metadata banner ([#565](https://github.com/hezo-ai/hezo/pull/565))
- **web:** documents sidebar search with fixed header ([#567](https://github.com/hezo-ai/hezo/pull/567))
- **goals:** keep checking goals after they reach 100% ([#563](https://github.com/hezo-ai/hezo/pull/563))
- **auth:** password show/hide toggle + Admin password settings page ([#562](https://github.com/hezo-ai/hezo/pull/562))
- **web:** make the scroll-to-bottom button global to all long-form pages ([#561](https://github.com/hezo-ai/hezo/pull/561))
- **web:** icon-only open-in-new-tab button in preview panel header ([#559](https://github.com/hezo-ai/hezo/pull/559))

### Bug Fixes

- **web:** open a tailored dialog for sub-task creation ([#581](https://github.com/hezo-ai/hezo/pull/581))
- **web:** use canonical terminate button for running agents in the agent queue ([#576](https://github.com/hezo-ai/hezo/pull/576))
- **web:** flow the rail create button after the project list until it overflows ([#575](https://github.com/hezo-ai/hezo/pull/575))
- **web:** align comment-card action rows and fix the connect-required Connectors link ([#572](https://github.com/hezo-ai/hezo/pull/572))
- **runner:** stop Bun's 5-min fetch idle timeout from killing quiet agent runs ([#571](https://github.com/hezo-ai/hezo/pull/571))
- **agents:** steer delegated fan-out tasks to be sub-tasks of the current task ([#568](https://github.com/hezo-ai/hezo/pull/568))
- **web:** refresh budget-status after agent cap edits; drop the hero sparkline ([#564](https://github.com/hezo-ai/hezo/pull/564))
- **web:** move mobile new-task button to top nav; wrap run header to stop page overflow ([#560](https://github.com/hezo-ai/hezo/pull/560))

### Documentation

- make HTTPS the baseline for all deployment and hosting instructions ([#573](https://github.com/hezo-ai/hezo/pull/573))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.12.0...0.13.0

## 0.12.0 - 2026-07-04

### Features

- **assets:** file task-thread uploads under uploads/<task-name> ([#556](https://github.com/hezo-ai/hezo/pull/556))
- **web:** draggable floating buttons on portrait mobile screens ([#554](https://github.com/hezo-ai/hezo/pull/554))
- **runs:** stop-hook rule 10 blocks handoffs left only in the final message ([#553](https://github.com/hezo-ai/hezo/pull/553))
- **deploy:** add digitalocean marketplace packer image ([#548](https://github.com/hezo-ai/hezo/pull/548))
- **deploy:** one-click / cloud-init deploy for VPS providers ([#547](https://github.com/hezo-ai/hezo/pull/547))
- **web:** single Edit button for project and per-agent budgets ([#544](https://github.com/hezo-ai/hezo/pull/544))
- **pricing:** single price source = pricepertoken.com MCP catalog ([#543](https://github.com/hezo-ai/hezo/pull/543))
- **connectors:** OAuth connect popup for manually-added instance connectors ([#542](https://github.com/hezo-ai/hezo/pull/542))
- **web:** surface staged-update lifecycle in Settings Version section ([#539](https://github.com/hezo-ai/hezo/pull/539))
- add fullscreen toggle to create-task dialog ([#538](https://github.com/hezo-ai/hezo/pull/538))
- **web:** add per-provider API-key instructions to the provider connect form ([#537](https://github.com/hezo-ai/hezo/pull/537))
- **web:** float document action buttons and jump to first review comment ([#535](https://github.com/hezo-ai/hezo/pull/535))
- **runner:** re-queue a run after a hard timeout; drop universal run-limits block ([#533](https://github.com/hezo-ai/hezo/pull/533))
- **auth:** admin password authentication + master-key vault UI ([#531](https://github.com/hezo-ai/hezo/pull/531))
- **documents:** add revision changelogs, metadata banner, and history viewer ([#532](https://github.com/hezo-ai/hezo/pull/532))
- **runner:** protect agent work at run limits — auto-push commits + anticipatory run-time/budget awareness ([#530](https://github.com/hezo-ai/hezo/pull/530))

### Bug Fixes

- **web:** remove gap after AI providers in settings nav ([#557](https://github.com/hezo-ai/hezo/pull/557))
- **web:** hide run status text on mobile in run comment top bar ([#552](https://github.com/hezo-ai/hezo/pull/552))
- **web:** size the app shell with dvh so the mobile top nav can't scroll off-screen ([#555](https://github.com/hezo-ai/hezo/pull/555))
- **web:** bake a close button into the shared DialogContent base ([#549](https://github.com/hezo-ai/hezo/pull/549))
- **web:** pre-fill the goal editor Deadline field from target_date ([#534](https://github.com/hezo-ai/hezo/pull/534))

### Performance

- **test:** cache migrated DB snapshot and lower test scrypt cost ([#545](https://github.com/hezo-ai/hezo/pull/545))

### Refactors

- **mcp:** rename semantic_search tool to full_text_search ([#546](https://github.com/hezo-ai/hezo/pull/546))
- remove the cost probe; always price runs from the pricing table ([#541](https://github.com/hezo-ai/hezo/pull/541))

### Documentation

- stop encouraging on-disk master key storage; enforce in AGENTS.md ([#550](https://github.com/hezo-ai/hezo/pull/550))
- **readme:** reflect the past week's features ([#551](https://github.com/hezo-ai/hezo/pull/551))

### Other

- Require green CI before QA approves a PR for merge ([#536](https://github.com/hezo-ai/hezo/pull/536))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.11.0...0.12.0

## 0.11.0 - 2026-07-03

### Features

- **web:** add version display to General settings; move base URL blurb to tooltip ([#528](https://github.com/hezo-ai/hezo/pull/528))
- **web:** searchable folder dropdown in the asset move dialog ([#523](https://github.com/hezo-ai/hezo/pull/523))
- **web:** head team chart with CEO, fix connector lines, add hover affordance ([#520](https://github.com/hezo-ai/hezo/pull/520))
- **agents:** gate tech spec + implementation on UI design first (software team) ([#521](https://github.com/hezo-ai/hezo/pull/521))
- **assets:** breadcrumb-only header in subfolders, per-asset copy-link + tooltips ([#522](https://github.com/hezo-ai/hezo/pull/522))
- **web:** widen the task doc preview panel on xl/2xl screens ([#518](https://github.com/hezo-ai/hezo/pull/518))
- **docs:** add review comments on project documents ([#514](https://github.com/hezo-ai/hezo/pull/514))
- asset folders, agent copy/move, and admin-approved deletion ([#512](https://github.com/hezo-ai/hezo/pull/512))
- **web:** mobile scroll-to-bottom button as bottom-centre rectangle ([#511](https://github.com/hezo-ai/hezo/pull/511))
- **agents:** lock structurally-fixed reporting lines (CEO, Captain, Coach) ([#510](https://github.com/hezo-ai/hezo/pull/510))
- **goals:** link tasks and PRs in goal status blurbs ([#503](https://github.com/hezo-ai/hezo/pull/503))
- **tasks:** gate done on unanswered @admin asks and notify superusers of @admin mentions ([#505](https://github.com/hezo-ai/hezo/pull/505))
- **agents:** require reconciling announced plans before closing a task ([#504](https://github.com/hezo-ai/hezo/pull/504))
- **goals:** queue manual progress-update run when the Captain is busy ([#501](https://github.com/hezo-ai/hezo/pull/501))
- **agents:** require verifying a wake before assuming a teammate hand-off ([#499](https://github.com/hezo-ai/hezo/pull/499))
- **web:** move new-goal affordance to a right-aligned + button in the header ([#497](https://github.com/hezo-ai/hezo/pull/497))

### Bug Fixes

- **web:** strip @@ prefix from unresolved passive mentions ([#526](https://github.com/hezo-ai/hezo/pull/526))
- **web:** render review-comment highlights on markdown tables ([#525](https://github.com/hezo-ai/hezo/pull/525))
- **assets:** equal-size cards, folder reads as a labelled stack ([#524](https://github.com/hezo-ai/hezo/pull/524))
- prevent disabling the HQ instance agents (CEO/Coach) ([#519](https://github.com/hezo-ai/hezo/pull/519))
- group document review controls into a distinct toolbar cluster ([#517](https://github.com/hezo-ai/hezo/pull/517))
- **web:** stop logo-less provider wordmark from overflowing the picker header ([#516](https://github.com/hezo-ai/hezo/pull/516))
- **web:** keep documents page within the viewport for wide doc content ([#513](https://github.com/hezo-ai/hezo/pull/513))
- link a doc/asset mention that ends a sentence ([#508](https://github.com/hezo-ai/hezo/pull/508))
- **web:** make mobile document panel its own layer above task sidebar ([#509](https://github.com/hezo-ai/hezo/pull/509))
- **web:** hide project-menu "+" chips on mobile ([#500](https://github.com/hezo-ai/hezo/pull/500))
- **web:** stop mobile shell from remounting on background status refetch ([#498](https://github.com/hezo-ai/hezo/pull/498))
- **web:** relabel misleading "Open tasks" task filter summary ([#496](https://github.com/hezo-ai/hezo/pull/496))

### Refactors

- remove the project task-progress-bar feature ([#515](https://github.com/hezo-ai/hezo/pull/515))

### Chores

- relicense from AGPL-3.0 to MIT ([#502](https://github.com/hezo-ai/hezo/pull/502))

### Other

- Update tagline to "Your own AI workforce. Self-hosted and secure." ([#507](https://github.com/hezo-ai/hezo/pull/507))
- Fix cross-commit defects found reviewing the last three days of main ([#506](https://github.com/hezo-ai/hezo/pull/506))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.10.0...0.11.0

## 0.10.0 - 2026-07-01

### Features

- **goals:** rename goal-check heartbeat to "progress update", add manual Run now ([#492](https://github.com/hezo-ai/hezo/pull/492))
- **agents:** let agents edit their own run comments; stop duplicate wrap-ups ([#491](https://github.com/hezo-ai/hezo/pull/491))
- **web:** global mobile create-task button with project selector ([#486](https://github.com/hezo-ai/hezo/pull/486))
- **web:** collapse goal-run + project-progress summaries, add progress help ([#485](https://github.com/hezo-ai/hezo/pull/485))
- **web:** offer mobile PWA install prompt ([#484](https://github.com/hezo-ai/hezo/pull/484))
- **web:** move GitHub to a dedicated Git settings subpage ([#474](https://github.com/hezo-ai/hezo/pull/474))
- **web:** refine goals UI, run trigger labels, and sidebar add buttons ([#475](https://github.com/hezo-ai/hezo/pull/475))
- **web:** add goal-form field tooltips and a reusable help dialog ([#473](https://github.com/hezo-ai/hezo/pull/473))
- redesign settings nav and drop All Tasks/Skills top-nav shortcuts ([#471](https://github.com/hezo-ai/hezo/pull/471))
- **web:** redesign AI provider setup as a logo card grid ([#469](https://github.com/hezo-ai/hezo/pull/469))
- remove mobile sidemenu close button and homepage time display ([#470](https://github.com/hezo-ai/hezo/pull/470))
- link update banner version to its GitHub release page ([#467](https://github.com/hezo-ai/hezo/pull/467))
- add anonymous daily usage telemetry (opt-out) ([#468](https://github.com/hezo-ai/hezo/pull/468))

### Bug Fixes

- prevent spurious failed run on dev-server restart from worktree mount race ([#494](https://github.com/hezo-ai/hezo/pull/494))
- **agents:** wait for deployment readiness before verifying a deployed URL ([#493](https://github.com/hezo-ai/hezo/pull/493))
- **agents:** remove deferred-continuation auto-queue that re-ran agents needlessly ([#490](https://github.com/hezo-ai/hezo/pull/490))
- **agents:** hand back active tasks before cancelling; never leave a PR/branch orphaned ([#489](https://github.com/hezo-ai/hezo/pull/489))
- **test:** scope container cleanup to test containers; harden worktree prep ([#488](https://github.com/hezo-ai/hezo/pull/488))
- **server:** strip NUL bytes from container output before persisting ([#487](https://github.com/hezo-ai/hezo/pull/487))
- **agents:** resume deferred in-progress work in seconds, not the heartbeat interval ([#480](https://github.com/hezo-ai/hezo/pull/480))
- **web:** make full Tasks/Team rows clickable and pin the team menu open ([#479](https://github.com/hezo-ai/hezo/pull/479))
- **web:** make running-agent trash a terminate button without waiting on run comment ([#478](https://github.com/hezo-ai/hezo/pull/478))
- **web:** clear the Progress "no goals yet" dot once a project has a goal ([#476](https://github.com/hezo-ai/hezo/pull/476))

### Documentation

- note that sharded CI jobs gate branch protection via their *-complete rollup ([#483](https://github.com/hezo-ai/hezo/pull/483))

### Other

- Prefer runtime-reported cost; add cost-source probe; switch Kimi to Claude Code, drop xAI/Grok, hide OpenRouter ([#481](https://github.com/hezo-ai/hezo/pull/481))
- Automatic agent-driven chat memory with byte-bounded compaction ([#482](https://github.com/hezo-ai/hezo/pull/482))
- Narrow collapsed project progress to header + first line ([#477](https://github.com/hezo-ai/hezo/pull/477))
- Merge model pricing into AI providers settings page ([#472](https://github.com/hezo-ai/hezo/pull/472))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.9.0...0.10.0

## 0.9.0 - 2026-06-29

### Features

- **goals:** skip by deadline as well as cadence in Captain heartbeat ([#462](https://github.com/hezo-ai/hezo/pull/462))
- **ai:** add xAI Grok Build as a runtime + provider, redesign provider form as logo cards ([#460](https://github.com/hezo-ai/hezo/pull/460))
- **goals:** add Progress page with project summary, goal detail page, and per-goal run feed ([#459](https://github.com/hezo-ai/hezo/pull/459))

### Bug Fixes

- **updater:** self-heal stuck staging and lengthen download timeout ([#461](https://github.com/hezo-ai/hezo/pull/461))

### Documentation

- add Team shapes concept page ([#465](https://github.com/hezo-ai/hezo/pull/465))

### Tests

- raise coverage above 90% and add Coveralls badge ([#464](https://github.com/hezo-ai/hezo/pull/464))

### Other

- Fix project rail active ring and reposition mobile nav close button ([#463](https://github.com/hezo-ai/hezo/pull/463))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.8.0...0.9.0

## 0.8.0 - 2026-06-27

### Features

- **goals:** reintroduce project goals tracked by the Captain ([#453](https://github.com/hezo-ai/hezo/pull/453))
- **tasks:** remove `closed` status, default-show Done, infinite-scroll task list ([#451](https://github.com/hezo-ai/hezo/pull/451))
- **agents:** delegate before defaulting to doing it yourself ([#452](https://github.com/hezo-ai/hezo/pull/452))
- **web:** refine task filter bar and add floating/sidebar new-task buttons ([#450](https://github.com/hezo-ai/hezo/pull/450))
- **web:** improve task detail mobile layout ([#449](https://github.com/hezo-ai/hezo/pull/449))

### Bug Fixes

- **test:** de-flake browser CI by serving the built web bundle ([#454](https://github.com/hezo-ai/hezo/pull/454))

### Refactors

- safe code-review cleanups (enums, defensive wakeup, dependency toasts) ([#456](https://github.com/hezo-ai/hezo/pull/456))

### Documentation

- lead with the meta-harness concept ([#457](https://github.com/hezo-ai/hezo/pull/457))
- surface goals as a first-class concept in overview pages ([#455](https://github.com/hezo-ai/hezo/pull/455))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.7.0...0.8.0

## 0.7.0 - 2026-06-26

### Features

- **egress:** gated request-body secret substitution for credential-in-body logins ([#445](https://github.com/hezo-ai/hezo/pull/445))
- **assets:** allow markdown as a project asset with rendered viewer ([#442](https://github.com/hezo-ai/hezo/pull/442))
- enforce required system-prompt vars, remove {{team_mission}} ([#436](https://github.com/hezo-ai/hezo/pull/436))
- **credentials:** auto-fill suggested allowed hosts on credential requests ([#437](https://github.com/hezo-ai/hezo/pull/437))
- add project icon upload ([#435](https://github.com/hezo-ai/hezo/pull/435))
- **hire:** show hire proposals as task comments; stop auto-closing the ticket ([#434](https://github.com/hezo-ai/hezo/pull/434))
- **web:** reusable markdown edit/preview component ([#432](https://github.com/hezo-ai/hezo/pull/432))
- live CEO processing dots in header + project rail updates on create ([#429](https://github.com/hezo-ai/hezo/pull/429))
- add copy buttons to the CEO chat ([#423](https://github.com/hezo-ai/hezo/pull/423))
- auto-grow the CEO chat composer with multi-line input ([#422](https://github.com/hezo-ai/hezo/pull/422))
- add a --version argument to the CLI ([#420](https://github.com/hezo-ai/hezo/pull/420))

### Bug Fixes

- fast egress preflight + CEO chat reliability (pending UI, no duplicate/stuck turns) ([#447](https://github.com/hezo-ai/hezo/pull/447))
- re-openable tickets + agent approval before external-service writes ([#446](https://github.com/hezo-ai/hezo/pull/446))
- self-heal the egress connectivity gate (unblock CEO/agents) + surface CEO send errors as a toast ([#444](https://github.com/hezo-ai/hezo/pull/444))
- only log final connectivity outcome so successful auto-rebind is silent ([#443](https://github.com/hezo-ai/hezo/pull/443))
- auto-detect bridge gateway for egress/SSH bind + fail-fast on unreachable proxy ([#441](https://github.com/hezo-ai/hezo/pull/441))
- drop avatar border for image project icons so the rail ring isn't mis-spaced ([#439](https://github.com/hezo-ai/hezo/pull/439))
- re-fit the CEO chat composer when its width changes ([#433](https://github.com/hezo-ai/hezo/pull/433))
- accept user-facing IDs (task identifier / agent slug) in ID-accepting MCP tools ([#430](https://github.com/hezo-ai/hezo/pull/430))
- log egress/SSH bind degradation at warn, not error ([#428](https://github.com/hezo-ai/hezo/pull/428))
- **web:** brighten raw agent-run log text ([#427](https://github.com/hezo-ai/hezo/pull/427))
- native-Linux container-to-host connectivity for MCP and egress ([#426](https://github.com/hezo-ai/hezo/pull/426))
- **web:** keep latest CEO chat message visible after expand/collapse ([#424](https://github.com/hezo-ai/hezo/pull/424))

### Documentation

- expand the long-term memory model for agents ([#425](https://github.com/hezo-ai/hezo/pull/425))

### Chores

- tell agents to edit project docs via write_project_doc, not Edit/Write ([#438](https://github.com/hezo-ai/hezo/pull/438))
- strengthen guidance that Hezo entities live in the DB, not on disk ([#431](https://github.com/hezo-ai/hezo/pull/431))
- update tagline to "Self-hosted and secure" ([#421](https://github.com/hezo-ai/hezo/pull/421))

### Other

- shard backend tests across 3 runners ([#440](https://github.com/hezo-ai/hezo/pull/440))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.6...0.7.0

## 0.6.6 - 2026-06-25

### Bug Fixes

- verify container liveness before agent exec; gate Retry on health ([#418](https://github.com/hezo-ai/hezo/pull/418))
- **runtime:** force per-run config dirs traversable past a strict umask ([#416](https://github.com/hezo-ai/hezo/pull/416))

### Documentation

- merge meta-harness into "How Hezo works"; drop "Where to next" ([#415](https://github.com/hezo-ai/hezo/pull/415))

### Tests

- de-flake task-comment-attachments browser specs ([#417](https://github.com/hezo-ai/hezo/pull/417))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.5...0.6.6

## 0.6.5 - 2026-06-25

### Bug Fixes

- **containers:** chown bind-mounted files to the detected container run-user ([#409](https://github.com/hezo-ai/hezo/pull/409))

### Documentation

- add "Meta-harness" Overview page; frame coding harnesses as general-purpose ([#413](https://github.com/hezo-ai/hezo/pull/413))
- surface Hezo's selling points (+ skill revision history feature) ([#411](https://github.com/hezo-ai/hezo/pull/411))
- note local-model support via OpenCode is on the roadmap ([#412](https://github.com/hezo-ai/hezo/pull/412))
- guide CEO and Captain to design output verification into rosters ([#410](https://github.com/hezo-ai/hezo/pull/410))

### Tests

- drive line coverage from ~86% toward ≥92% ([#404](https://github.com/hezo-ai/hezo/pull/404))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.4...0.6.5

## 0.6.4 - 2026-06-25

### Bug Fixes

- **startup:** serve web UI during boot; stop agent-base pull blocking readiness ([#407](https://github.com/hezo-ai/hezo/pull/407))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.3...0.6.4

## 0.6.3 - 2026-06-25

### Features

- **docker:** fetch agent-base :latest (refreshed at startup) instead of the version tag ([#405](https://github.com/hezo-ai/hezo/pull/405))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.2...0.6.3

## 0.6.2 - 2026-06-25

### Features

- **docker:** publish agent-base image per release, pull it for matching versions ([#402](https://github.com/hezo-ai/hezo/pull/402))
- warm HQ container at startup; gate CEO chat + project creation on it ([#401](https://github.com/hezo-ai/hezo/pull/401))
- **updates:** background-download before showing "Install & restart" ([#400](https://github.com/hezo-ai/hezo/pull/400))
- auto-open the browser on startup, skipping headless environments ([#399](https://github.com/hezo-ai/hezo/pull/399))

### Bug Fixes

- **server:** provision HQ container on demand for CEO chat ([#398](https://github.com/hezo-ai/hezo/pull/398))

### Documentation

- hosted Hezo architecture recommendation ([#397](https://github.com/hezo-ai/hezo/pull/397))
- align all docs with the current codebase + add a docs-sync check to AGENTS.md ([#394](https://github.com/hezo-ai/hezo/pull/394))

### Other

- Require removing superseded code as changes are made (engineer + QA) ([#395](https://github.com/hezo-ai/hezo/pull/395))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.1...0.6.2

## 0.6.1 - 2026-06-25

### Bug Fixes

- **web:** make clipboard copy work in insecure contexts ([#392](https://github.com/hezo-ai/hezo/pull/392))

### Documentation

- add systemd service example for self-hosting on Linux ([#391](https://github.com/hezo-ai/hezo/pull/391))

**Full Changelog**: https://github.com/hezo-ai/hezo/compare/0.6.0...0.6.1

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
