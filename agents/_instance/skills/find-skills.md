---
name: find-skills
description: Discover and install agent skills from the open ecosystem when no existing skill covers the task — search skills.sh with `npx skills`, then persist the chosen skill into Hezo's shared catalog so it sticks for every future run.
---

# Finding and adding skills

You have a shared **skills catalog** (the manifest above) plus this discovery skill. Skills are reusable, *project-independent* know-how (e.g. "how to build with React", "how to use the Stripe API"). Project-specific knowledge belongs in a **project document** (`write_project_doc`), never here.

When a task needs a capability you don't already have:

1. **Check what you already have first.** Re-read the skills manifest above. If a listed skill fits, load it with `get_skill(slug)` and use it — don't go searching when you already have a match.

2. **Search the open ecosystem.** If nothing fits, search skills.sh from inside the container:
   - `npx skills find "<query>"` — search by capability (e.g. `npx skills find "react native"`).
   - Browse https://skills.sh for the leaderboard to compare options.
   Prefer well-adopted skills (higher install counts, reputable sources).

3. **Add it to the shared catalog via the Hezo API — this is the step that makes it stick.** A local `npx skills add … -g` install lives only in *this* container and is discarded when the run ends. To make a skill permanent and available to every agent on every future run, persist it into Hezo's catalog:
   - If you have the skill's raw `SKILL.md` URL (e.g. a GitHub raw link), call `fetch_skill_file({ url })`.
   - Otherwise install it locally to read it (`npx skills add <owner/repo@skill> -g -y`), open the installed `SKILL.md`, and call `create_skill({ name, slug, content, tags })` with its body.
   Re-adding the same slug updates it (idempotent).

4. **That's the record.** Skills you add this way are reported automatically in this run's summary — the same place created tickets and updated docs appear — so you don't need to announce them separately. They appear in the manifest for every future run.

If no suitable skill exists anywhere, do the work directly; if what you learned is reusable team know-how, capture it with `create_skill` so the next agent has it.
