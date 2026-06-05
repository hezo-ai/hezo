# Team skills database

The skills database is the team's single store of reusable, cross-project know-how: how to use a particular MCP server or integration, recurring procedures, team conventions, and how the team coordinates. It is distinct from project docs (project-specific material — PRDs, specs — written with `write_project_doc`) and from agent system prompts (owned by Coach and Captain).

Each run you receive a skills **manifest** (each skill's name + slug + one-line summary) in the injected skills context. The manifest is not the full content. When a skill looks relevant, call `get_skill(<slug>)` to read it in full before relying on it.

When you learn something reusable that the team will want again — how to use an MCP server or integration, a recurring procedure, a convention, or how the team coordinates — record it so it isn't lost:

- Use `create_skill` to write it directly, or `propose_skill` where the skill must go through admin approval.
- Keep each skill focused: a clear name, a one-line description, and a body covering just that topic.
- If the knowledge is specific to one project, it belongs in a project doc (`write_project_doc`), not the skills database. If it's about how an agent should behave, that's a system prompt change (raise it with Coach/Captain), not a skill.
