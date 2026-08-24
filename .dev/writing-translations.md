# Writing translations

The contributor guide for the twelve locale catalogs: what the catalog guard checks, how to
carry a sentence containing a link, and the register each language settled on. The rules that
bind before you start - a string is not changed until it is changed in all twelve, "task"
never "ticket" in any language, no em or en dash anywhere, one term per concept - are in
`AGENTS.md`; this is the how.

## The catalogs
`packages/web/src/lib/i18n/catalog/*.json` are hand-authored source files. `en.json` is the source of truth; the other eleven are written against it and reviewed like any other code.

## Carrying a sentence that contains a node

**A sentence containing a link or other node still goes through the catalog — use `<Trans>`, not a literal.** `t()` can't carry a `ReactNode`; `<Trans k="..." vars={{ source: <Link …/> }} />` splits the same `{name}` template and interleaves nodes, keeping the whole sentence as one entry. **Do not split a sentence into a key per fragment** — that hard-codes English word order into all twelve languages. See the `task_link`, `status_change`, `parent_change`, `run_failed` and `repo_designated` branches in `comment-renderers/system-comment.tsx`. Branches still reading a server-baked `content.text` (`title_change`, `assignee_change`, `description_change`) are not translated — localizing those means rebuilding each sentence from its structured payload first. `TASK_STATUS_LABELS` (`@hezo/shared`) is not localized, so a translated status sentence still reads its status words in English.

## What the guard checks

`i18n-catalog.test.ts` fails on a key missing from a catalog, an empty value, a value identical to its English source outside the `IDENTICAL_TO_ENGLISH_OK` allowlist, a dropped `{placeholder}`, an em/en dash, the word "ticket", a value carrying another language's script (hangul outside `ko`, kana outside `ja`), and **a key referenced nowhere in `packages/web/src/`**.

- **Adding an allowlist entry to quiet the identical-to-English check is the mistake it exists to prevent** — every entry claims the two really are the same word.
- **The unreferenced-key check has no allowlist, deliberately.** An unreferenced key almost always means the component still renders the English word inline. Wire the key up, or delete it from all twelve catalogs.
- A typo'd `t()` key is already a compile error (`MessageKey = keyof typeof en`), so `bun run typecheck` covers that direction.

**`Translations-Checked:` is enforced at commit time.** Any commit staging `packages/web/src/` or `packages/shared/src/` is rejected without the trailer. Bare values under 10 characters are rejected:

```
Translations-Checked: added settings.locale.* to all 12 catalogs
Translations-Checked: reworded onboarding.language.subtitle; retranslated in all 11 non-English catalogs
Translations-Checked: no user-facing strings added or changed; catalogs untouched
```

The trailer must be true. **Never bypass the hook with `--no-verify`.** Server-only, test-only, docs-only, merge, revert and fixup commits are exempt. Classification is tested in `translations-ack-hook.test.ts`; a new string-bearing path goes into `STRING_BEARING_PATTERNS` in the same change.

Rules for any catalog edit:

- **Never translated:** `Hezo`, `Captain`, `CEO`, `Coach`, `HQ`, `MCP`, agent role names, marketplace team names, any CLI/command text. Role and team names must match `marketplace/teams/*.json`.
- **"task", never "ticket" — in every language.** `Aufgabe` not `Ticket`, `tâche` not `ticket`, `タスク` not `チケット`. The test only catches the English-shaped mistake.
- **The em/en dash ban applies to every language.**
- **`{placeholder}` tokens are copied verbatim.**
- **One term per concept per language** — check the existing catalog before inventing a second word.
- **Watch for repetition the English doesn't have.** Recast rather than accepting it.

**Register is a per-language decision, already made. Do not "fix" one language to match another.**

| | Address |
|---|---|
| de | formal (Sie) |
| fr | formal (vous) |
| es / it | informal (tú / tu) |
| nl | informal (je) |
| pt-BR | você |
| pl | informal 2nd person |
| sv | informal (du) — formal address is archaic there |
| zh-Hans / ja / ko | polite-neutral (您 / です・ます / 해요체) |

These are unreviewed by native speakers and deserve a native pass before a release that markets the translations.

