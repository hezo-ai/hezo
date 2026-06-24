---
title: Roles & the CEO
order: 7
section: Concepts
---

# Roles & the CEO

Hezo organises agents like a company. A few roles coordinate; the rest do the work.

## The CEO

The **CEO** is the instance-wide executive, and your main point of contact. There is
exactly one CEO, and it lives in [HQ](/docs/concepts/projects-and-teams#hq--the-home-team) —
so it can see and act across every project. You chat with the CEO to get things done
across the whole instance:

- **Intake** — describe a new project and the CEO scopes it with you, then provisions the
  team once you've confirmed the plan (see
  [Your first project](/docs/getting-started/first-project)). It won't create anything
  until you give the go-ahead.
- **Coordination** — ask about any project's status, tickets, or roster; the CEO
  works across every team.
- **Setup review** — before a new team starts planning, the CEO aligns its roster with the
  goal. When the CEO creates a project with you, it sets the team up according to the plan
  you agreed — the roles to hire and how they fit together — then starts it; a project
  created directly from the form gets an automatic coherence check instead.
- **Actioning changes** — hire new agents, retire ones a team no longer needs, adjust
  system prompts, and change settings, all through the conversation. See
  [Hiring & customizing agents](/docs/concepts/hiring-and-agents).

Because the CEO can make consequential changes, significant actions surface as
**approvals** for you to confirm.

The CEO's behaviour comes from its
[system prompt](https://github.com/hezo-ai/hezo/blob/main/agents/_instance/ceo.md).

## The Coach

The **Coach** is the second instance-wide role that lives in HQ. Whenever a ticket is
completed — in any project — the Coach automatically reviews how it went: it reads the
whole thread, notices where an agent struggled, got pushback, or needed several attempts,
and captures what went well and what to improve. It then writes those lessons back as
durable **learned rules** on the agents that need them (and sometimes updates a project
document or skill), so the same mistake doesn't happen twice. The teams get better the
more they ship, without you having to tune prompts by hand.

The Coach's behaviour comes from its
[system prompt](https://github.com/hezo-ai/hezo/blob/main/agents/_instance/coach.md).

Both the CEO and the Coach are instance-wide singletons that live in
[HQ](/docs/concepts/projects-and-teams#hq--the-home-team) — the one special team — and
act across every project's team. They are never part of a project template.

## The Captain

Each project team has a **Captain** — the lead agent for that team. The Captain breaks
the goal down into tasks, coordinates the worker agents, keeps the work moving, and
escalates to the CEO when needed.

## Worker agents

The rest of the roster are **workers** — domain specialists such as engineers,
designers, QA, or researchers, depending on the team template. They pick up tasks,
do the work, and report up to the Captain. For the full roster of each built-in
template — and a link to every role's system prompt — see
[Team templates](/docs/concepts/projects-and-teams#team-templates).

## Chatting with the CEO

The CEO is always one click away. A chat opens from any page in the app, and there's a
single ongoing conversation — pick up where you left off rather than starting a new
thread each time. As the CEO works, its reply **streams back in real time**, so you can
follow its thinking instead of waiting for a finished block of text.

Keep working alongside it: **minimize** the chat to the corner button and a badge appears
there when a CEO reply lands while you're away — the same unread indicator the inbox uses
— clearing the moment you reopen it. When you want more room, **expand** the chat to fill
the screen below the top navigation bar; expanding dims the rest of the page into a focused,
modal view. Collapse it back to the anchored panel when you're done, or press **Escape**
(or click the dimmed area) to close the chat.

Because the CEO works across the whole instance, you can ask about anything without
opening a project first: "how's the marketing site coming along?", "what's the engineering
team stuck on?", "spin up a team to research competitors". It answers with knowledge of
every project, ticket, and roster.

The chat is also the control surface for the things that are awkward to click through:
scoping work, reorganising a team, or changing how an agent behaves. State what you want
in plain language; the CEO proposes the change and asks you to approve anything that
matters. Standing preferences you ask it to remember persist in the CEO's
[chatbox memory](/docs/concepts/documents-and-memory#chatbox-memory), so you don't repeat
yourself.
