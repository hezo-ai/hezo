# Target audiences — website subpages

**Status (2026-08).** The team-template half of this plan shipped: all three teams are live
in `marketplace/teams/` (#713), were renamed to **Social Media Marketing** and **Investment
Portfolio** (#820), and the App Team slug became `app-dev` (#1011). Goal suggestions shipped
with them. Authoring a team is now `writing-agent-prompts.md`; the seeding procedure
this document originally prescribed no longer exists.

What remains unbuilt is the website half, below — it lives in the `hezo-ai/website` repo.

## Implementation — website (hezo-ai/website repo)

The site is Gatsby 5; docs already come from this repo via the `vendor/hezo`
submodule, but the audience pages are marketing pages that live in the website
repo itself. There is currently **zero** persona content — this is greenfield.

- **Pages:** `/for/app-builders`, `/for/influencers`, `/for/investors`
  (`app-builders` matches the "App Team" name better than `developers`; final
  slugs are an open question below). Recommended shape: one shared
  `src/templates/audience.tsx` + a single audience data file, generated via
  `createPages` in `gatsby-node.js` — the same pattern `doc.tsx` /
  `news-article.tsx` use, and adding a fourth audience later becomes a data
  edit. (Three static files under `src/pages/for/` would also work; the shared
  template keeps the three pages structurally identical, which the messaging
  rule below wants anyway.)
- **Per-page structure:** audience hero ("Your app team" / "Your content team"
  / "Your research team"), *what your team ships in week one* (the outputs
  listed per audience above), a roster showcase that mirrors the template's
  roles one-for-one, an audience-specific FAQ, and the install CTA (reuse the
  homepage's install-pill; `src/components/Pillars.js` is an existing unused
  component worth repurposing for the roster grid). The Investor page carries
  the not-financial-advice disclaimer.
- **Messaging rule:** each page's roster and promises mirror exactly what the
  template provisions. When a template's roster changes, the page changes in
  the same release.
- **Wiring:** nav links (or a "For…" dropdown — `@radix-ui/react-popover` is
  already a dependency) in `src/components/Nav.js`, in *both* the desktop
  `.nav-right` block and the mobile `.nav-menu` block; a column or link group
  in `src/components/Footer.js`; homepage cross-links — likely a small
  "Who is Hezo for?" three-card section on `src/pages/index.js` linking the
  three pages, while the hero itself stays audience-neutral (open question
  below).
- **SEO:** per-page `Head` via `src/components/Seo.js` with `title`,
  `description`, and `pathname` (canonical), plus `BreadcrumbList` and
  `FAQPage` JSON-LD passed as children — copy the `news-article.tsx` pattern,
  the richest on the site. Sitemap inclusion is automatic (`onPostBuild` in
  `gatsby-node.js` includes every built page); `static/llms.txt` is **manual**
  — add the three pages there.

