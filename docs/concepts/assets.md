---
title: Assets & previews
order: 13
section: Concepts
---

# Assets & previews

Not every deliverable is markdown. Each project team has an **assets library** — one place
for the files a project accumulates, whether you uploaded them or an agent produced them.

## Uploads

Drag a file onto the **Assets** page to add it to the library: mockups, screenshots,
diagrams, images, PDFs, audio, or video, up to 10 MB each. You can also attach files
directly to a task or a comment, so a screenshot or a reference document sits right next to
the discussion it belongs to.

## Agent-generated assets

Agents don't just consume assets — they create them. An agent can write an interactive
**HTML** mockup, an **SVG** diagram, or a plain-text export straight into the library
(`write_project_asset` over Hezo's [MCP server](/docs/mcp/hezo-mcp-server)) and read any
asset back later. Generated deliverables live here rather than being committed to the source
repository, so they're easy to find and review, and re-saving the same filename updates it in
place so references stay stable.

Anywhere you write text in Hezo — a task, a comment, a document — you can point at an asset
by writing `assets/<filename>` (for example `assets/login-mockup.png`).

This is also how the **CEO** hands you files from the chat. When you ask the CEO to whip
something up — a quick mockup, a diagram, a one-off HTML page — it saves the result to an
assets library and links it back as `assets/<filename>`, so you can open it straight from the
conversation rather than hunting for a file on a server you can't reach. The CEO files the
deliverable with whichever **project** the conversation is about, falling back to HQ only when
the work isn't tied to a project at all.

## HTML previews

Assets aren't just stored — they're **previewable**. When an agent produces an HTML
deliverable — a mockup, a dashboard, a report — you can open it and click through it right in
Hezo, rendered live, without checking anything out or running it yourself. HTML previews run
in a **sandbox**, isolated from your instance and your data, so viewing an agent's output is
safe by default.
