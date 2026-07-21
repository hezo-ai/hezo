---
title: AI model support
order: 23
section: AI models & connections
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
| **xAI** | Grok | Grok Build | API key |
| **Kimi** (Moonshot) | Kimi | Claude Code | API key |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |

Each provider is driven through a **first-party agentic command-line runtime** inside the
agent's container — not a lowest-common-denominator wrapper. Anthropic, OpenAI, Google, and
xAI each use their own CLI (xAI runs on its **Grok Build** CLI, on the `grok-4.5` model);
Kimi, DeepSeek, and Z.ai run through Claude Code against their Anthropic-compatible
endpoints.

## Local models (on the roadmap)

First-class support for **local, self-hosted models** (for example via Ollama or any
OpenAI-compatible endpoint), so you could run agents entirely on your own hardware with
no per-token cost, is planned. **This isn't available in Hezo yet** — this page will be
updated when it ships.

## API key or subscription

Most providers accept either a plain **API key** or, where supported, a **subscription
sign-in** (for example Claude Pro/Max, ChatGPT, or Gemini) — so you can put an
existing plan to work instead of paying per token. You choose the method when you
connect the provider.

## Where to get an API key

Each provider issues API keys from its own console. When you connect a provider, the
form in Hezo walks you through these same steps inline.

| Provider | Create your key at | Billing |
|---|---|---|
| **Anthropic** | [Claude Console → API keys](https://platform.claude.com/settings/keys) | Prepaid credits, billed per token |
| **OpenAI** | [OpenAI Platform → API keys](https://platform.openai.com/api-keys) | Billed per token; add a payment method first (separate from ChatGPT) |
| **Google** | [Google AI Studio → API keys](https://aistudio.google.com/apikey) | Free tier with strict rate limits; enable billing on the key's Google Cloud project for sustained use |
| **xAI** | [xAI Console → API keys](https://console.x.ai/) | Billed per token; add credits first |
| **Kimi** (Moonshot) | [Kimi Open Platform → API keys](https://platform.kimi.ai/console/api-keys) | Prepaid balance |
| **DeepSeek** | [DeepSeek Platform → API keys](https://platform.deepseek.com/api_keys) | Prepaid balance |
| **Z.ai** | [Z.ai platform → API keys](https://z.ai/manage-apikey/apikey-list) | Prepaid balance ([billing page](https://z.ai/manage-apikey/billing)) |

Most consoles show a newly created key **only once** — copy it right away and paste it
into Hezo, which stores it encrypted. Providers billed per token generally need a
positive balance before agents can run.

## Use more than one

You can connect **several providers at once** and keep them all available. That's
useful for spreading work across accounts, keeping a cheaper model on hand for routine
tasks and a frontier model for the hard ones, or simply having a fallback.

When a key is stored it's checked against the provider and shown as **verified** (the
Verify action re-checks it any time). Mark one provider as the **default** with the star:
that's the single global default every agent uses unless it has its own model override.
Change the default and agents on the default pick up the new provider on their next run.

## Give an agent its own model

By default the agents on a team share the team's model, but you can **override the model
for any individual agent.** One agent can run on Claude while another on the same team
runs on Gemini or DeepSeek — whatever fits its job. Set it when you hire
the agent or any time afterward from its settings. See
[Hiring & customizing agents](/docs/concepts/hiring-and-agents).

Wherever you pick a specific model — a provider's default model, or an agent's override —
Hezo loads the list of choices **live from that provider**, so you always see the models
your key can actually use. Providers you signed in to with a subscription instead of an API
key use the model their CLI selects, so there's no list to choose from there.
