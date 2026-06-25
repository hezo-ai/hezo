---
title: Search
order: 16
section: Concepts
---

# Search

As a team's work piles up — tasks, long threads of comments, documents, the skills your
agents can run — you need one fast way back to any of it. Hezo has a **global search
palette**: open it from anywhere, type, and jump straight to the result.

Open it with the **search box in the top bar**, or the keyboard shortcut **⌘K**
(**Ctrl+K** on Windows and Linux), from any page.

![Global search palette showing results for "todo" grouped into Tasks, Comments, Docs, and Skills tabs](../assets/global-search.png)

## What it searches

One query covers four kinds of content, and the results are split into a tab per kind
with a count — so you can see at a glance where the matches are and switch between them:

- **Tasks** — by title and description.
- **Comments** — the discussion threaded on every task.
- **Docs** — your project [documents](/docs/concepts/documents-and-memory).
- **Skills** — the reusable skills your agents can run.

Pick a result to go straight to it: a task or comment opens that task (a comment match
scrolls to the exact comment), a doc opens the document, and a skill opens its settings.
The palette closes and you land where you needed to be.

## One search, every team

The palette searches **across all the teams you can access** at once — you don't pick a
project first, and [HQ](/docs/concepts/projects-and-teams#hq--the-home-team) is included
like any other team. Skills are instance-wide, so they turn up wherever you search.
Scoping is enforced on the server: content from a team you can't see never appears in
your results.

## Keyword search, with highlighting

Hezo runs a **full-text** search over your content: it matches the words you type — and
their grammatical variants, so "logins" finds "login" — and ranks the strongest matches
first, with titles weighted above body text. Where your words appear they're
**highlighted** in the snippet. Type at least two characters to begin, and results refine
as you type.

## Indexed on your own server

Search runs **entirely on your own server** — your tasks, comments, and documents are
never handed to an outside search service, in keeping with the rest of Hezo. The index is
built right into your database and kept in sync automatically, so new or edited content is
findable the instant you save it: there's no model to download and nothing to wait for.
