---
name: Webapp Testing
description: Use when verifying frontend functionality, debugging UI behavior, or capturing browser screenshots and logs for a local web application — drive a real browser with Playwright instead of assuming the UI works.
source_url: https://github.com/anthropics/skills/blob/9d2f1ae187231d8199c64b5b762e1bdf2244733d/skills/webapp-testing/SKILL.md
---

# Webapp Testing

To verify a web application actually works, drive it in a real browser with Playwright and observe the result — don't infer it from the code.

## Setup

Playwright installs cleanly at runtime inside an agent workspace:

```sh
mkdir -p /tmp/pw && cd /tmp/pw
npm init -y && npm install playwright
sudo npx playwright install --with-deps chromium
node your-script.mjs   # run from the same directory so require('playwright') resolves
```

Stay in the directory where you installed for all follow-up runs. Always launch headless: `chromium.launch({ headless: true })`.

## Choosing your approach

- **Static HTML** → read the HTML file directly to identify selectors, then write a Playwright script using them.
- **Dynamic app, server not running** → start the server yourself (background it, wait for its port to accept connections), then run the automation, then stop it.
- **Dynamic app, server already running** → reconnaissance-then-action:
  1. Navigate and wait for the page to settle: `await page.waitForLoadState('networkidle')`.
  2. Screenshot or inspect the DOM to see the *rendered* state.
  3. Identify selectors from what's actually rendered.
  4. Execute actions with the discovered selectors.

## The critical pitfall

**Don't inspect the DOM before the app has rendered.** On dynamic apps, always `await page.waitForLoadState('networkidle')` (or wait for a known element) before reading content — otherwise you're asserting against an empty shell.

## Minimal script shape

```js
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
await page.goto('http://localhost:5173');
await page.waitForLoadState('networkidle');
// ... actions and assertions ...
await page.screenshot({ path: 'result.png', fullPage: true });
await browser.close();
```

## What to verify

- **Behavior, not presence:** click the button and assert the outcome, don't just assert the button exists.
- **The mobile layout too:** `page.setViewportSize({ width: 375, height: 800 })` — responsive breakage is the most common UI regression.
- **Console and network errors:** capture `page.on('console')` and `page.on('pageerror')`; a page that renders but logs errors is not passing.
- **Screenshots as evidence:** attach the screenshot to your report or task thread — "I saw it work" needs a picture.

## Best practices

- Prefer robust selectors: `getByRole`, `getByText`, IDs — not brittle CSS chains.
- Wait for conditions (`waitForSelector`, `expect(...).toBeVisible()`), not arbitrary timeouts.
- Close the browser when done.
- If a flow can't be verified headlessly (OAuth to a third party, emails), verify up to the boundary and state exactly what was and wasn't covered.
