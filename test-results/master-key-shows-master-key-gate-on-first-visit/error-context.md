# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: master-key.spec.ts >> shows master key gate on first visit
- Location: tests/e2e/master-key.spec.ts:3:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Set Master Key')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Set Master Key')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - link "hezo" [ref=e5] [cursor=pointer]:
      - /url: /companies
    - button [ref=e6] [cursor=pointer]:
      - img [ref=e7]
  - generic [ref=e12]:
    - heading "Companies" [level=1] [ref=e13]
    - button "New Company" [ref=e14] [cursor=pointer]:
      - img [ref=e15]
      - text: New Company
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | test('shows master key gate on first visit', async ({ page }) => {
  4  | 	await page.goto('/');
> 5  | 	await expect(page.getByText('Set Master Key')).toBeVisible();
     |                                                 ^ Error: expect(locator).toBeVisible() failed
  6  | });
  7  | 
  8  | test('can set master key and proceed', async ({ page }) => {
  9  | 	await page.goto('/');
  10 | 	await expect(page.getByText('Set Master Key')).toBeVisible();
  11 | 
  12 | 	await page.getByRole('button', { name: 'Generate Key' }).click();
  13 | 	await page.getByRole('button', { name: 'Copy to clipboard' }).click();
  14 | 
  15 | 	const keyInput = page.getByPlaceholder('Paste generated key to confirm');
  16 | 	const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  17 | 	await keyInput.fill(clipboardText);
  18 | 
  19 | 	await page.getByRole('button', { name: 'Set Key & Continue' }).click();
  20 | 	await expect(page.getByText('Companies')).toBeVisible({ timeout: 10000 });
  21 | });
  22 | 
```