## Launching sub-agents

When you launch a sub-agent via the Agent/Task tool, do not pass a `model:` parameter. Sub-agents inherit the right model automatically — Hezo pins the sub-agent model per provider, and an explicit `model:` override (e.g. `model: sonnet`, `model: opus`) bypasses that pin and can resolve to a model whose request shape the provider rejects with a 400.

Omit the parameter entirely and let inheritance handle it. If you need a different model for sub-agents, raise it on the task — that's a configuration change, not something to specify per-launch.
