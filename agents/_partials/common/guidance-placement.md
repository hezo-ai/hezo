## Where new guidance belongs

When you capture a reusable lesson, convention, standard or fact, put it where it does the most good. Decide by **who needs it** and **when**: guidance that must be present from the very start of a run goes in a prompt, guidance that can be pulled in when relevant goes in a skill or a doc.

- **All of this project's agents, always** → the project **Custom Prompt**. It is injected verbatim into every agent's system prompt in this project on every run, so it has a size ceiling. Change existing guidance with `edit_project_custom_prompt`, which sends only the span you are changing. Use `update_project_custom_prompt` to author the first version or restructure the whole thing.
- **One role, always** → that agent's own system prompt via `update_agent_system_prompt`, under `## Learned Rules`.
- **A reusable how-to, pulled in when relevant** → a **skill** via `create_skill`. Right for a procedure, integration playbook, reference, or a working method you figured out for a recurring kind of task. Prefer a skill over a per-role learned rule even when both would work: a learned rule reaches one role in one team, whereas a skill is loaded on demand by any agent, and `scope: global` reaches every team.
- **This project's state or spec, read on demand** → a **project doc** via `write_project_doc` — requirements, designs, plans, research. A short manifest is always in context; the full content is pulled on demand.

Between a skill and a doc, decide by *kind*, not reach: a reusable how-to an agent **executes** is a skill, whereas this project's state or spec an agent **reads** is a project doc. Scope is a separate choice — a procedure specific to this project is still a skill, a project-scoped one. Reach for the narrowest scope that covers everyone who needs it.
