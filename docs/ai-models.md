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
| **Google** | Gemini | Gemini CLI | API key or subscription |
| **xAI** | Grok | Grok Build | API key |
| **Kimi** (Moonshot) | Kimi | Claude Code or Kimi Code | API key |
| **DeepSeek** | DeepSeek | Claude Code | API key |
| **Z.ai** | GLM | Claude Code | API key |
| **OpenRouter** | Many, via one account | OpenCode | API key |
| **Ollama** | Whatever you run locally | Claude Code | Server URL (key optional) |
| **LM Studio** | Whatever you run locally | Claude Code | Server URL (key optional) |

Each provider is driven through a **first-party agentic command-line runtime** inside the
agent's container - not a lowest-common-denominator wrapper. Anthropic, OpenAI, Google, and
xAI each use their own CLI (xAI runs on its **Grok Build** CLI, on the `grok-4.5` model);
Kimi, DeepSeek, and Z.ai run through Claude Code against their Anthropic-compatible
endpoints; OpenRouter runs through the **OpenCode** CLI; and Ollama and LM Studio run
through Claude Code against your own machine.

Where the Runtime column lists more than one, you choose which one that credential runs on.
The first is the default, and you never have to pick: adding a key without touching the
setting runs it on the default.

### Choosing the agent CLI

When a provider can be run by more than one command-line agent, the choice lives under
**Advanced** in the add-provider form, below the API key. A provider that offers only one CLI
shows no picker there.

You can also change it later without re-entering the key: on **Settings > AI providers**,
click the CLI name next to the provider and pick another. Existing agents pick up the change
on their next run.

Nothing about a provider you have already added changes unless you change it. The account,
key and models are the same whichever CLI you pick - only the harness differs. Pick per
credential (the Advanced setting), per agent (in the agent's settings) or per task (by
pinning the task's runtime).

### Two ways to run Kimi

Moonshot's models can be run by either of two command-line agents, on one credential:

- **Claude Code**, pointed at Moonshot's Anthropic-compatible endpoint. This is the default.
- **Kimi Code**, Moonshot's own command-line agent.

Hezo used to list these as two separate providers. They are now one **Kimi** entry with the
choice under Advanced; an existing Kimi Code credential keeps running on Kimi Code, and you
no longer need a second credential to try the other harness.

## Local models

You can run agents **entirely on your own hardware**, with no per-token cost and no
prompt or code leaving your machine. Hezo supports two local model servers:

| Server | Default address | Notes |
|---|---|---|
| **Ollama** | `http://localhost:11434` | Start it with `ollama serve` |
| **LM Studio** | `http://localhost:1234` | Start the server from the **Developer** tab |

Both serve Anthropic's Messages API directly, so agents run on the same **Claude Code**
runtime the hosted Anthropic-compatible providers use. There is nothing to translate and
no extra proxy to run.

To connect one, pick it in **Add AI provider** and fill in the **Server URL**. That is the
only field: Ollama ignores an API key, and LM Studio only checks one if you turned on
**Require Authentication** - if you did, put the key under **Advanced**.

### Use an address the agents can reach

This is the one thing that catches people out. Agents run inside a container, so
`localhost` there means *the container itself*, not the machine running your model
server. A URL that works in your browser will fail at run time.

Use one of these instead:

- `http://host.docker.internal:11434` - a server on the same machine as Hezo.
- `http://192.168.1.50:11434` - a server elsewhere on your network, by its LAN address.

Both only resolve while the container is on the same machine as the server - that is, on
[local Docker](/docs/containers/local-docker), the default. On a
[managed sandbox service](/docs/containers/remote/overview) the container runs on the
provider's machines, where these addresses mean nothing - use a model endpoint reachable
over the internet instead.

Hezo warns you in the connect form if you enter a `localhost` address.

### Cost and model choice

Local runs record **$0**, because nothing is billed per token. That is a real zero, not a
missing price - but it does mean [budgets](/docs/concepts/budgets-and-costs) do not
constrain local agents, since there is no spend to cap.

Pick a model with strong **tool-calling** ability. Agents work by calling tools in a loop,
and smaller local models are noticeably weaker at it than the hosted frontier models. Some
capabilities the hosted providers offer are also unavailable locally, including prompt
caching and token counting.

## API key or subscription

Most providers accept either a plain **API key** or, where supported, a **subscription
sign-in** (for example Claude Pro/Max, ChatGPT, or Gemini) - so you can put an
existing plan to work instead of paying per token. You choose the method when you
connect the provider.

### Signing in to a subscription

For **OpenAI** and **Anthropic**, Hezo runs the sign-in for you. Choose the subscription
option, select **Sign in**, and Hezo shows you a link and a short one-time code. Open the
link on any device - your phone is fine - sign in to that account, and enter the code.

- **OpenAI (Codex)** finishes on its own once you complete the sign-in. Nothing to bring
  back.
- **Anthropic (Claude Code)** shows you a code at the end of its sign-in page. Paste that
  code into Hezo to finish.

Your credential is created inside the sandbox and stored encrypted without passing
through your browser, so you never copy an auth file around.

For **Google (Gemini)**, and for any instance where the sandbox cannot reach the
provider's sign-in page, use **Paste credential manually** instead and follow the steps
the form shows. The Gemini CLI offers no sign-in Hezo can drive, so that is the only
option there.

Codex rotates its credential each time Hezo runs it. Two consequences follow.

Once Hezo holds a Codex subscription, avoid using the same login on your own machine -
pick one or the other, or the two will fall out of step.

And **runs on a Codex subscription go one at a time.** The credential is rewritten
mid-run, so a second run using it would invalidate the first; Hezo queues them instead,
and a waiting run shows as queued with its reason rather than as an error. Nothing is
lost, but the agents on that credential take turns. To run more at once, add a second
Codex subscription, or use an OpenAI API key - a key is not rewritten by anything, so
runs on it go in parallel. Subscriptions for other providers are unaffected.

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
| **OpenRouter** | [OpenRouter → Keys](https://openrouter.ai/keys) | Prepaid credits, billed per token |
| **Ollama** | Not required | Runs on your hardware, no per-token cost |
| **LM Studio** | Not required | Runs on your hardware, no per-token cost |

Most consoles show a newly created key **only once** - copy it right away and paste it
into Hezo, which stores it encrypted. Providers billed per token generally need a
positive balance before agents can run. The local servers need no key at all - you give
them a [server URL](#local-models) instead.

## Use more than one

You can connect **several providers at once** and keep them all available. That's
useful for spreading work across accounts, keeping a cheaper model on hand for routine
tasks and a frontier model for the hard ones, or simply having a fallback.

When a key is stored it's checked against the provider and shown as **verified** (the
Verify action re-checks it any time). Mark one provider as the **default** with the star:
that's the single global default every agent uses unless it has its own model override.

Adding a connection does **not** make it the default - use the star for that. Once you do,
every agent on the default runs on the new provider from its next run, including a live
CEO chat, which restarts itself onto it.

The default is a choice, not a preference. If the credential you designated stops being
usable - the key gets revoked and shows as **invalid**, say - runs on the default fail and
say so, naming the connection. Hezo will not quietly move them onto one of your other
connections: a run billing a provider you didn't pick, while the star still sits on the one
you did, is the kind of thing that goes unnoticed for weeks. Re-verify the connection, or
move the star, and runs resume.

## Change a stored key

Keys expire, get rotated, or get revoked at the provider. When that happens the connection
shows as **invalid** and agents on it stop running, because Hezo only picks up verified
credentials.

Use the **pencil** at the end of the row to fix it in place. The Edit panel holds the
connection's name, its credential, and - for the providers that offer more than one - the
agent CLI it runs on. Paste the new key and save: Hezo checks it against the provider before
storing it, and a key that passes clears the invalid state on the spot, so there's no
separate Verify step and nothing else about the connection is lost. A key the provider
rejects is refused, leaving the stored one exactly as it was.

Leave the credential field **blank** to keep the key you already have - that's how you rename
a connection or switch its CLI without re-pasting anything.

## Give an agent its own model

By default the agents on a team share the team's model, but you can **override the model
for any individual agent.** One agent can run on Claude while another on the same team
runs on Gemini or DeepSeek - whatever fits its job. Set it when you hire
the agent or any time afterward from its settings. See
[Hiring & customizing agents](/docs/concepts/hiring-and-agents).

Wherever you pick a specific model - a provider's default model, or an agent's override -
Hezo loads the list of choices **live from that provider**, so you always see the models
your key can actually use. Providers you signed in to with a subscription instead of an API
key use the model their CLI selects, so there's no list to choose from there.

## How the starting model is chosen

A connection you add starts on a sensible current model for that provider rather than on
nothing, so a key you paste and leave alone still runs. Hezo keeps that starting point
fresh by re-reading each connected provider's catalog once a day and following the
provider's own naming, so a new generation becomes the starting model without an update to
Hezo. It stays within the same class of model, so the choice never jumps to a different
price tier or to an image model.

**Connections you already have are never changed.** The model on a stored connection is
yours until you change it, and a refresh only moves the default offered to the *next*
connection you add. If a provider is unreachable when the refresh runs, its previous
default stands.

Local model servers have no pinned default: the catalog is whatever you have pulled, so
the CLI's own choice applies until you pick one.
