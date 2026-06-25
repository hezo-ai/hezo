---
title: AI model support
order: 18
section: AI models & MCP
---

# AI model support

Hezo is **bring-your-own-model.** You connect your own provider accounts, Hezo stores
the credentials encrypted (see [Master key & encryption](/docs/security/master-key)),
and your agents run on the models you choose.

## Supported providers

| Provider | Models | Runtime | Authentication |
|---|---|---|---|
| **Anthropic** | Claude | Claude Code | API key or subscription |
| **OpenAI** | ChatGPT / GPT | Codex | API key or subscription |
| **Google** | Gemini | Gemini | API key or subscription |
| **Kimi** (Moonshot) | Kimi | Kimi Code | API key or subscription |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |
| **OpenRouter** | Many, via one key | OpenCode | API key |

Each provider is driven through its **native command-line runtime** inside the agent's
container — so you get each model's first-party agentic tooling, not a lowest-common-
denominator wrapper.

## API key or subscription

Most providers accept either a plain **API key** or, where supported, a **subscription
sign-in** (for example Claude Pro/Max, ChatGPT, Gemini, or Kimi) — so you can put an
existing plan to work instead of paying per token. You choose the method when you
connect the provider.

## Use more than one

You can connect **several providers at once** and keep them all available. That's
useful for spreading work across accounts, keeping a cheaper model on hand for routine
tasks and a frontier model for the hard ones, or simply having a fallback.

## Give an agent its own model

By default the agents on a team share the team's model, but you can **override the model
for any individual agent.** One agent can run on Claude while another on the same team
runs on Gemini or a model from OpenRouter — whatever fits its job. Set it when you hire
the agent or any time afterward from its settings. See
[Hiring & customizing agents](/docs/concepts/hiring-and-agents).
