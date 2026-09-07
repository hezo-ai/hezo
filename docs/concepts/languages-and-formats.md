---
title: Languages & formats
order: 16.5
section: Concepts
---

# Languages & formats

Hezo's web app runs in twelve languages. The very first screen is already in yours: Hezo
reads it from your browser, and a language button in the top right lets you pick another
one before anything else is set up.

## Supported languages

English, Deutsch (German), Français (French), Español (Spanish), Italiano (Italian),
Português do Brasil (Brazilian Portuguese), Nederlands (Dutch), Polski (Polish),
Svenska (Swedish), 简体中文 (Simplified Chinese), 日本語 (Japanese), and 한국어 (Korean).

European Portuguese falls back to the Brazilian catalog, and traditional-script Chinese
falls back to Simplified - closer than English in both cases, but not a perfect match.

## Where you set it

**On first run**, with your master key. The language showing when you create the key
becomes the instance's language, together with the date format and currency format that
usually go with it, so every screen after that - for you and for anyone else who signs in -
reads the same way. The button in the top right of the master-key screen is where you
change it first. See [First-run setup](/docs/getting-started/first-run).

**After that**, in **Settings -> Languages & formats**, where you can also change the date
and currency formats on their own.

While you are signed out - at the unlock screen after a locked start, or at the sign-in screen -
there is a language button in the top right, because those screens have no menu to reach
Settings through. Changing the language there applies to that browser only and tells you
so; sign in to change it for everyone. The one exception is the very first screen: until the
master key exists there is nobody to sign in yet, so a language picked there is saved for the
whole instance.

Picking a language re-renders the picker itself straight away, so you can check it reads the
way you expect before you commit to it. Nothing is saved at that point: the rest of the app,
and your date and currency choices, change only when you press Save. Leave the screen without
saving and everything stays as it was.

## It is a setting for the whole instance

The language is **global**, not per person. Everyone using this Hezo instance sees the same
language, and only an admin can change it. That matches how the rest of the instance-level
settings work.

## Date and currency formats

Language, date format, and currency format are three separate choices on the same screen,
because they genuinely come apart: plenty of people want German prose with ISO dates.

**Date format** sets the order of the fields:

| Option | Example |
|---|---|
| Day first | 29/07/2026 |
| Month first | 07/29/2026 |
| Year first (ISO) | 2026-07-29 |
| Day, month name, year | 29 Jul 2026 |

Month names always follow your **language**, not the date format - so a German instance on
day-first dates reads "29 Jul 2026" with the German abbreviation, not the English one.

**Currency format** sets how amounts are punctuated:

| Option | Example |
|---|---|
| $1,234.56 | period for decimals, comma for thousands |
| 1.234,56 $ | comma for decimals, period for thousands |
| 1 234,56 $ | comma for decimals, space for thousands |

This changes **presentation only**. Hezo always bills in US dollars, because that is what
the AI model providers charge in, and budgets are stored in dollars. There is no currency
conversion and no exchange rate anywhere in Hezo - picking a European format does not turn
your spend into euros, it only writes the same dollar amount the way you are used to
reading it.

Each option previews itself with a real value, so you can pick by looking rather than by
decoding a pattern like `DD/MM/YYYY`.

## What is not translated

Hezo translates its own interface. It does not translate **your content or your agents'
output** - task titles and descriptions, agent comments, run logs, CEO chat replies,
documents, and project summaries all stay in whatever language they were written in.

If you want your agents to work in a particular language, tell them so: set it in the
project's custom prompt or an agent's instructions. That is a separate thing from the
interface language, and deliberately so - a German-speaking operator may still want their
code comments and commit messages in English.

The [documentation](/docs/introduction) is English-only.
