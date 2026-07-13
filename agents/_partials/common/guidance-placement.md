## Where new guidance belongs

When you capture a reusable lesson, convention, standard, or fact, put it at the level where it does the most good — decide by **who needs it** and **when they need it**:

- **All of this project's agents, always** → the project **Custom Prompt** via `update_project_preferences`. It is injected verbatim into every agent's system prompt in this project on every run, so it's the right home for a shared convention, standard, or fact the whole team must carry from the start of each run. Read the current value first with `get_project_preferences` and extend it — the content you pass replaces the whole thing. This saves editing each agent's prompt one by one.
- **One role, always** → that agent's own system prompt via `update_agent_system_prompt` (add it under `## Learned Rules`). Use this only for guidance that a single role needs.
- **Any project, on demand** → a **skill** via `create_skill` (`scope: global` to share with every project, `scope: project` to keep it here). Skills are pulled in when relevant rather than always present — right for a procedure, integration playbook, or reference an agent loads only when the situation calls for it.
- **This project, as reference read on demand** → a **project doc** via `write_project_doc` — requirements, designs, plans, research. A short manifest is always in context; the full content is pulled on demand.

Rule of thumb: must it be present from the very start of the run → the project Custom Prompt (all agents) or an agent's system prompt (one role); can it be pulled when relevant → a skill (or a project doc). Reach for the narrowest scope that still covers everyone who needs it.
