---
name: Web Design Guidelines
description: Use when reviewing or auditing UI code for design quality, accessibility, and interaction polish — "review my UI", "check accessibility", "audit this page". A concrete rule checklist with findings reported per file and line.
---

# Web Design Guidelines

Audit UI code against the checklist below. Report findings tersely — `file:line — rule — fix` — ordered by severity, so each one is actionable on its own. When building UI rather than reviewing it, treat the same rules as the quality floor.

## Accessibility

- Every interactive element is keyboard-reachable, in a logical tab order, with a **visible focus state** — never `outline: none` without a replacement.
- Images carry meaningful `alt` text (or empty `alt` when decorative); icon-only buttons carry `aria-label`.
- Text contrast meets WCAG AA: 4.5:1 for body text, 3:1 for large text and UI boundaries. Don't convey state by color alone.
- Semantic elements over div-soup: real `<button>`, `<a>`, `<label>`, headings in order (`h1` → `h2` → `h3`, no skips).
- Form inputs have associated labels — placeholder text is not a label.
- Motion respects `prefers-reduced-motion`; nothing flashes more than three times per second.

## Forms

- Submit works with Enter; the primary action is a real submit button.
- Validation errors appear next to the field, say what's wrong and how to fix it, and never clear the user's input.
- Disabled states explain themselves (tooltip or helper text) — a mysteriously disabled button is a dead end.
- Destructive actions require confirmation and are never the default-focused choice.
- Inputs use the right type (`email`, `number`, `date`) and autocomplete attributes so mobile keyboards and password managers work.

## Layout & responsiveness

- Build mobile-first; verify at ~375px, tablet, and desktop. No horizontal page scroll at any width — wide content (tables, code) scrolls inside its own container.
- Touch targets ≥ 44×44px with adequate spacing; hover-only affordances have a touch/keyboard equivalent.
- Spacing comes from a consistent scale, not ad-hoc pixel values; alignment is intentional (things that look almost aligned are worse than clearly not aligned).
- Text truncates or wraps deliberately: long names, translations, and empty/overflow states are all designed, not accidents.
- Layout doesn't shift as content loads — reserve space for images and async content.

## Feedback & state

- Every async action shows a pending state; anything slower than ~400ms gets a spinner or skeleton.
- Errors are specific and recoverable — what failed, why, what to do next. Never a bare "Something went wrong" when the cause is known.
- Empty states invite action (what this area is for + how to fill it), not just a blank region.
- Optimistic updates roll back visibly on failure; success is shown by the change itself, not a redundant toast.

## Typography & color

- A deliberate type scale (not a dozen arbitrary sizes); line length ~45–90 characters; line height ≥ 1.4 for body text.
- System font stack or properly loaded webfonts with `font-display: swap`; no invisible-text flash.
- Colors come from a defined palette with semantic roles (background, surface, border, accent, danger); check both light and dark themes if the app has them.
- Numbers in tables use tabular figures and right alignment.

## Interaction details

- Links are links (navigations) and buttons are buttons (actions) — never a `div` with an `onClick`.
- Scroll position, focus, and selection survive re-renders; focus moves into opened dialogs and returns on close.
- Dialogs close on Escape; clicks outside behave predictably; nothing traps the user.
- `title`/tooltips are additive, never the only way to discover a function.

## Output format

For a review, list findings as:

```
src/components/Form.tsx:82 — focus state removed without replacement — restore :focus-visible outline
src/pages/Pricing.tsx:14 — 3 heading levels skipped (h1 → h4) — use h2
```

Group by severity (**blocker / should fix / polish**) and end with the two or three highest-leverage improvements overall.
