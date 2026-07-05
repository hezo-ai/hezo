---
title: Assets & previews
order: 14
section: Concepts
---

# Assets & previews

Not every deliverable is markdown. Each project team has an **assets library** — one place
for the files a project accumulates, whether you uploaded them or an agent produced them.

## Folders

The library supports **folders up to two levels deep** (a folder, and one level of
subfolders inside it). Navigating into a folder shows a **breadcrumb trail** at the top of
the Assets page — click any crumb to jump back up, or the root crumb to return to the whole
library. Uploads land in the folder you currently have open, and **New folder** starts a
fresh one (it persists once the first file lands in it; a folder disappears when its last
asset is removed).

There's no fixed convention for how to organize — each agent team decides what fits the
project, and agents are instructed to organize proactively so the library stays easy for you
to navigate: related files for one deliverable grouped in a well-named folder, date-prefixed
names where order matters, and a dedicated folder (such as `scripts/`) for reusable helper
scripts that future agent runs can pick up and reuse. Script and text files (`.sh`, `.py`,
`.js`, `.ts`, `.json`, `.csv`, `.yaml`/`.yml`) are storable assets, kept and served as plain
text.

Agents can also **move and copy** assets between folders, and you can move one yourself from
its card's **Move to folder** action. Note that moving an asset changes its `assets/<path>`
reference — older comments citing the old path show it as plain text.

## Uploads

Drag files onto the **Assets** page to add them to the library: mockups, screenshots,
diagrams, images, PDFs, scripts, audio, or video, up to 10 MB each. Uploads are always
individual files — folders can't be uploaded from your computer; files simply land in
whichever library folder is open. You can also attach files directly to a task or a comment,
so a screenshot or a reference document sits right next to the discussion it belongs to —
those attachments are filed in the library under an **uploads** folder, in a subfolder named
after the task, so each task's files stay grouped without any manual sorting.

## Agent-generated assets

Agents don't just consume assets — they create them. An agent can write an interactive
**HTML** mockup, an **SVG** diagram, a plain-text export, a **script**, or a **markdown**
deliverable such as a blog post or report straight into the library (`write_project_asset`
over Hezo's [MCP server](/docs/mcp/hezo-mcp-server)) and read any asset back later — folder
paths included (`scripts/deploy-check.sh`). Generated deliverables live here rather than
being committed to the source repository, so they're easy to find and review, and re-saving
the same path updates it in place so references stay stable.

Markdown belongs in the assets library when it's a standalone deliverable you want to open and
read — a blog post, a one-off report. Project **docs** (specs, PRDs, research that gives agents
ongoing context) live in their own store via `write_project_doc` instead.

Anywhere you write text in Hezo — a task, a comment, a document — you can point at an asset
by writing `assets/<path>` (for example `assets/login-mockup.png`, or
`assets/launch/images/hero.png` for one inside folders). You don't have to type it out: each
asset card has a **Copy link** action that copies its exact `assets/<path>` reference to your
clipboard, ready to paste. Opening a link to a foldered asset takes you straight to its folder
with the file highlighted.

This is also how the **CEO** hands you files from the chat. When you ask the CEO to whip
something up — a quick mockup, a diagram, a one-off HTML page — it saves the result to an
assets library and links it back as `assets/<path>`, so you can open it straight from the
conversation rather than hunting for a file on a server you can't reach. The CEO files the
deliverable with whichever **project** the conversation is about, falling back to HQ only when
the work isn't tied to a project at all.

## Where asset files live

Asset files are stored by the server in its configured **asset storage**: the local data
directory by default, or any **S3-compatible bucket** when one is configured (see
[Storing assets in S3-compatible object storage](/docs/deployment/configuration)). Either
way, everyone — you in the browser, and agents through their tools — reads assets through
Hezo's signed URLs, so a bucket never needs to be publicly accessible and agents never
depend on server disk paths. The active backend is shown under **Settings → General →
Asset storage**.

## Archiving & deleting assets

Assets are retired by **archiving** — a reversible soft delete. An archived asset drops out
of the default view, agents' listings, and new-reference suggestions, but it keeps its path
reserved and any existing `assets/<path>` links keep resolving. Agents archive self-serve
(it's the only way they can "delete" — asking an agent to delete an asset means it archives
it), and you can archive one yourself from its card's **Archive** action. Nothing is lost:
restore it at any time.

The Assets page shows **active** items by default. The filter button (funnel icon) next to
"Showing active items" switches the view to **Archived** or **All** — archived cards render
dimmed with an "Archived" badge, and offer **Restore** plus **Delete**.

**Deletion is permanent and admin-only.** Agents can never delete. The Delete action lives
only on archived cards, so removing an asset for good is a deliberate two-step: archive it,
then delete it from the Archived view (with a confirmation, since attachments referencing it
are removed too).

## Previews

Assets aren't just stored — they're **previewable**. When an agent produces an HTML
deliverable — a mockup, a dashboard, a report — you can open it and click through it right in
Hezo, rendered live, without checking anything out or running it yourself. HTML previews run
in a **sandbox**, isolated from your instance and your data, so viewing an agent's output is
safe by default.

Markdown assets open the same way: click one and it renders as formatted prose right in Hezo,
with a **view-source** toggle to flip to the raw markdown whenever you want it.
