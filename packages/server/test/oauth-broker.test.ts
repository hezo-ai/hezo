import { describe, expect, it } from 'vitest';
import { resolveBrokerDescriptor } from '../src/services/oauth/broker';

describe('resolveBrokerDescriptor', () => {
	it('resolves a bundled provider_id to its registry descriptor', () => {
		const r = resolveBrokerDescriptor({ provider_id: 'google-youtube', client_id: 'cid' });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.descriptor.provider).toBe('google-youtube');
		expect(r.descriptor.deviceCodeUrl).toBe('https://oauth2.googleapis.com/device/code');
		expect(r.descriptor.tokenUrl).toBe('https://oauth2.googleapis.com/token');
		expect(r.descriptor.scopes).toEqual(['https://www.googleapis.com/auth/youtube']);
		expect(r.descriptor.allowedHosts).toContain('*.googleapis.com');
		expect(r.descriptor.clientId).toBe('cid');
		expect(r.descriptor.clientSecret).toBeUndefined();
	});

	it('carries the client secret when supplied', () => {
		const r = resolveBrokerDescriptor({
			provider_id: 'google-youtube',
			client_id: 'cid',
			client_secret: 'GOCSPX-secret',
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.descriptor.clientSecret).toBe('GOCSPX-secret');
	});

	it('lets BYO body fields override the descriptor defaults', () => {
		const r = resolveBrokerDescriptor({
			provider_id: 'google-youtube',
			client_id: 'cid',
			scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
			allowed_hosts: ['youtube.googleapis.com'],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.descriptor.scopes).toEqual(['https://www.googleapis.com/auth/youtube.readonly']);
		expect(r.descriptor.allowedHosts).toEqual(['youtube.googleapis.com']);
		// endpoints still come from the descriptor
		expect(r.descriptor.tokenUrl).toBe('https://oauth2.googleapis.com/token');
	});

	it('supports a fully custom (BYO-endpoint) flow with no provider_id', () => {
		const r = resolveBrokerDescriptor({
			client_id: 'cid',
			device_code_url: 'https://acme.example/device',
			token_url: 'https://acme.example/token',
			scopes: ['a', 'b'],
			allowed_hosts: ['api.acme.example'],
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.descriptor.provider).toBe('oauth-broker');
		expect(r.descriptor.deviceCodeUrl).toBe('https://acme.example/device');
		expect(r.descriptor.tokenUrl).toBe('https://acme.example/token');
		expect(r.descriptor.scopes).toEqual(['a', 'b']);
	});

	it('rejects an unknown provider_id', () => {
		const r = resolveBrokerDescriptor({ provider_id: 'nope', client_id: 'cid' });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toMatch(/unknown provider_id/);
	});

	it('requires a client_id', () => {
		const r = resolveBrokerDescriptor({ provider_id: 'google-youtube' });
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toMatch(/client_id/);
	});

	it('requires endpoints when no provider is chosen', () => {
		const missingDevice = resolveBrokerDescriptor({
			client_id: 'cid',
			token_url: 'https://x/token',
		});
		expect(missingDevice.ok).toBe(false);
		if (missingDevice.ok) return;
		expect(missingDevice.error).toMatch(/device_code_url/);

		const missingToken = resolveBrokerDescriptor({
			client_id: 'cid',
			device_code_url: 'https://x/device',
		});
		expect(missingToken.ok).toBe(false);
		if (missingToken.ok) return;
		expect(missingToken.error).toMatch(/token_url/);
	});
});
