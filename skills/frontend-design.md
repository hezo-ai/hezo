---
name: Frontend Design
description: Use when building new UI or reshaping an existing one. Guidance for distinctive, intentional visual design — aesthetic direction, typography, and choices that don't read as templated defaults.
source_url: https://github.com/anthropics/skills/blob/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/frontend-design/SKILL.md
---

# Frontend Design

Approach this as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. The client is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take one real aesthetic risk you can justify.

## Ground it in the subject

If the brief doesn't pin down what the product or subject is, pin it yourself before designing: name one concrete subject, its audience, and the page's single job, and state your choice. The subject's own world — its materials, instruments, artifacts, and vernacular — is where distinctive choices come from. Build with the brief's real content throughout.

## Design principles

**The hero is a thesis.** Open with the most characteristic thing in the subject's world, in whatever form suits it: a headline, an image, an animation, a live demo, an interactive moment. A big number with a small label, supporting stats, and a gradient accent is the template answer — use it only if it's genuinely the best option.

**Typography carries the personality of the page.** Pair the display and body faces deliberately — not the families you'd reach for on any other project — and set a clear type scale with intentional weights, widths, and spacing. Make the type treatment itself memorable, not a neutral delivery vehicle.

**Structure is information.** Numbering, eyebrows, dividers, and labels should encode something true about the content, not decorate it. Numbered markers (01 / 02 / 03) are only appropriate when the content really is a sequence.

**Use motion deliberately.** One orchestrated moment — a page-load sequence, a scroll-triggered reveal — usually lands harder than scattered effects. Sometimes less is more; gratuitous animation is itself a tell of generated design.

**Match complexity to the vision.** Maximalist directions need elaborate execution; minimal directions need precision in spacing, type, and detail. Elegance is executing the chosen vision well.

## Avoid the default looks

Generated design currently clusters around three looks: (1) warm cream background, high-contrast serif display, terracotta accent; (2) near-black background with a single acid-green or vermilion accent; (3) broadsheet-style hairline rules, zero border-radius, dense columns. All three are legitimate for some briefs, but they're defaults, not choices. Where the brief pins a direction, follow it exactly — the brief's words always win. Where an axis is free, don't spend that freedom on a default.

## Process: plan, critique, build, critique again

Work in two passes. First, write a compact design plan: **color** — a 4–6 value named palette; **type** — faces for two or more roles (a characterful display used with restraint, a complementary body face, a utility face if needed); **layout** — a one-sentence concept, sketched as wireframes if useful; **signature** — the single element this page will be remembered by.

Then review the plan against the brief before building: if any part reads like the generic default you'd produce for any similar page, revise it and note what changed. Only then write the code, following the plan exactly and deriving every color and type decision from it.

When writing CSS, watch selector specificity — classes that cancel each other out (a `.section` rule fighting an element rule) commonly break section spacing.

## Restraint and self-critique

Spend your boldness in one place. Let the signature element be the memorable thing, keep everything around it quiet and disciplined, and cut decoration that doesn't serve the brief. Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected. Critique your own work as you build — screenshot it if your environment allows; a picture is worth a thousand tokens. Before calling it done, take one look and remove one accessory.

## Words are design material

Copy exists to make the design easier to understand and use. Write from the user's side of the screen: name things by what people control and recognize, never by how the system is built ("notifications", not "webhook config"). Active voice; controls say exactly what they do ("Save changes", not "Submit"); an action keeps its name through the whole flow. Errors explain what went wrong and how to fix it — never vague, never apologizing. An empty screen is an invitation to act. Plain verbs, sentence case, no filler; each element does exactly one job.
