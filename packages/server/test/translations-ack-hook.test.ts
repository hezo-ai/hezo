import { describe, expect, it } from 'vitest';
// Repo tooling under scripts/ — imported directly (pure functions, no DB/DOM),
// same pattern as docs-ack-hook.test.ts.
import {
	checkCommitMessage,
	findTranslationsAckValue,
	stringBearingFiles,
} from '../../../scripts/check-translations-ack';

const ACK = 'Translations-Checked: added settings.locale.* to all 12 catalogs';

describe('stringBearingFiles', () => {
	it('flags web sources, the catalogs themselves, and the shared label maps', () => {
		const files = [
			'packages/web/src/components/sidebar.tsx',
			'packages/web/src/lib/i18n/catalog/de.json',
			'packages/shared/src/types/common.ts',
		];
		expect(stringBearingFiles(files)).toEqual(files);
	});

	it('exempts the server, tests, docs, migrations, and repo prose', () => {
		expect(
			stringBearingFiles([
				'packages/server/src/routes/tasks.ts',
				'packages/server/migrations/017_example.sql',
				'packages/web/test/locale-settings.test.tsx',
				'test/browser/master-key-gate.spec.ts',
				'docs/concepts/languages-and-formats.md',
				'agents/blank/captain.md',
				'AGENTS.md',
			]),
		).toEqual([]);
	});
});

describe('findTranslationsAckValue', () => {
	it('finds the trailer case-insensitively and trims the value', () => {
		expect(findTranslationsAckValue('feat: x\n\ntranslations-checked:  retranslated nav.*  ')).toBe(
			'retranslated nav.*',
		);
	});

	it('returns null when absent', () => {
		expect(findTranslationsAckValue('feat: x\n\nDocs-Checked: updated docs/foo.md')).toBeNull();
	});
});

describe('checkCommitMessage', () => {
	it('rejects a string-bearing commit with no trailer', () => {
		const r = checkCommitMessage('feat: add locale row', [
			'packages/web/src/components/settings/locale-section.tsx',
		]);
		expect(r.ok).toBe(false);
		expect(r.error).toContain('Translations-Checked');
		// Names the cascade obligation, not just the missing trailer.
		expect(r.error).toContain('catalog');
	});

	it('rejects bare and too-short acknowledgments', () => {
		for (const value of ['yes', 'n/a', 'done', 'ok', 'checked!']) {
			const r = checkCommitMessage(`feat: x\n\nTranslations-Checked: ${value}`, [
				'packages/web/src/main.tsx',
			]);
			expect(r.ok).toBe(false);
		}
	});

	it('accepts a meaningful acknowledgment', () => {
		expect(checkCommitMessage(`feat: x\n\n${ACK}`, ['packages/web/src/main.tsx']).ok).toBe(true);
	});

	it('accepts an explicit no-strings-changed acknowledgment', () => {
		const r = checkCommitMessage(
			'refactor: extract query helper\n\nTranslations-Checked: no user-facing strings added or changed; catalogs untouched',
			['packages/web/src/lib/api.ts'],
		);
		expect(r.ok).toBe(true);
	});

	it('passes server-only, test-only, and docs-only commits without a trailer', () => {
		expect(checkCommitMessage('feat: route', ['packages/server/src/routes/tasks.ts']).ok).toBe(
			true,
		);
		expect(
			checkCommitMessage('test: cover locale', ['packages/web/test/locale-settings.test.tsx']).ok,
		).toBe(true);
		expect(checkCommitMessage('docs: typo', ['docs/concepts/tasks.md']).ok).toBe(true);
	});

	it('passes merge and revert commits touching strings', () => {
		expect(checkCommitMessage('Merge branch main', ['packages/web/src/main.tsx']).ok).toBe(true);
		expect(checkCommitMessage('Revert "feat: x"', ['packages/web/src/main.tsx']).ok).toBe(true);
	});
});
