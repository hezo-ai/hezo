import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	SUPPORT_CHAT_DESKTOP_MIN_WIDTH,
	SUPPORT_CHAT_FIELDS,
	SUPPORT_CHAT_TABLET_MIN_WIDTH,
	supportChatViewport,
} from '../src/support-chat';

describe('supportChatViewport', () => {
	it('splits at the tablet and desktop widths', () => {
		expect(supportChatViewport(320)).toBe('phone');
		expect(supportChatViewport(SUPPORT_CHAT_TABLET_MIN_WIDTH - 1)).toBe('phone');
		expect(supportChatViewport(SUPPORT_CHAT_TABLET_MIN_WIDTH)).toBe('tablet');
		expect(supportChatViewport(SUPPORT_CHAT_DESKTOP_MIN_WIDTH - 1)).toBe('tablet');
		expect(supportChatViewport(SUPPORT_CHAT_DESKTOP_MIN_WIDTH)).toBe('desktop');
	});
});

describe('SUPPORT_CHAT_FIELDS', () => {
	const fields = Object.entries(SUPPORT_CHAT_FIELDS);

	it('uses keys the inbox accepts, prefixed so a shared account cannot collide', () => {
		// Chatwoot's own rule for an attribute key.
		for (const [key] of fields) {
			expect(key).toMatch(/^[\p{L}\p{N}_.-]+$/u);
			expect(key.startsWith('hezo_')).toBe(true);
		}
	});

	it('gives values to every list field and to no other', () => {
		for (const [, field] of fields) {
			if (field.type === 'list') expect(field.values?.length).toBeGreaterThan(0);
			else expect(field).not.toHaveProperty('values');
		}
	});

	it('lists every field in the deployment guide, so a deployer can define it', () => {
		const guide = readFileSync(
			new URL('../../../docs/deployment/configuration.md', import.meta.url),
			'utf8',
		);
		for (const [key] of fields) expect(guide).toContain(`\`${key}\``);
	});
});
