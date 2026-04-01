# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: issue-crud.spec.ts >> can create an issue
- Location: tests/e2e/issue-crud.spec.ts:4:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Issues')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByText('Issues')

```

# Page snapshot

```yaml
- generic:
  - generic:
    - generic:
      - banner:
        - link:
          - /url: /companies
          - text: hezo
        - button:
          - img
      - generic:
        - generic:
          - generic:
            - heading [level=1]: Companies
            - button:
              - img
              - text: New Company
  - dialog "Create Company" [active] [ref=e2]:
    - generic [ref=e3]:
      - heading "Create Company" [level=2] [ref=e4]
      - button [ref=e5]:
        - img [ref=e6]
    - generic [ref=e9]:
      - generic [ref=e10]:
        - generic [ref=e11]: Name
        - textbox "Name" [ref=e12]: Issue Test Corp
      - generic [ref=e13]:
        - generic [ref=e14]: Mission
        - textbox "Mission" [ref=e15]:
          - /placeholder: Optional
      - generic [ref=e16]:
        - generic [ref=e17]: Email
        - textbox "Email" [ref=e18]:
          - /placeholder: Optional
      - generic [ref=e19]:
        - generic [ref=e20]: Company Type
        - combobox "Company Type" [ref=e21]:
          - option "None" [selected]
      - paragraph [ref=e22]: Internal Server Error
      - generic [ref=e23]:
        - button "Cancel" [ref=e24] [cursor=pointer]
        - button "Create" [ref=e25] [cursor=pointer]
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | import { authenticate } from './helpers';
  3  | 
  4  | test('can create an issue', async ({ page }) => {
  5  | 	await page.goto('/');
  6  | 	await authenticate(page);
  7  | 	await page.goto('/companies');
  8  | 
  9  | 	await page.getByRole('button', { name: 'New Company' }).click();
  10 | 	await page.getByLabel('Name').fill('Issue Test Corp');
  11 | 	await page.getByRole('button', { name: 'Create' }).click();
> 12 | 	await expect(page.getByText('Issues')).toBeVisible({ timeout: 10000 });
     |                                         ^ Error: expect(locator).toBeVisible() failed
  13 | 
  14 | 	// Create a project first
  15 | 	await page.getByText('Projects').click();
  16 | 	await page.getByRole('button', { name: 'New Project' }).click();
  17 | 	await page.getByLabel('Name').fill('Test Project');
  18 | 	await page.getByRole('button', { name: 'Create' }).click();
  19 | 	await expect(page.getByText('Test Project')).toBeVisible({ timeout: 5000 });
  20 | 
  21 | 	// Create issue
  22 | 	await page.getByText('Issues').click();
  23 | 	await page.getByRole('button', { name: 'New Issue' }).click();
  24 | 	await page.getByLabel('Title').fill('Test Issue');
  25 | 	await page
  26 | 		.locator('select')
  27 | 		.filter({ hasText: 'Select project' })
  28 | 		.selectOption({ label: 'Test Project' });
  29 | 	await page.getByRole('button', { name: 'Create' }).click();
  30 | 
  31 | 	await expect(page.getByText('Test Issue')).toBeVisible({ timeout: 10000 });
  32 | });
  33 | 
```