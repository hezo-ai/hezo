import { describe, expect, it } from 'vitest';
import { ConfigFileError, validateConfigFile, validateOtlpConfig } from '../../src/config/schema';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function block(overrides: Record<string, unknown>) {
	return { enabled: true, endpoint: 'http://127.0.0.1:4318', projects: ['*'], ...overrides };
}

describe('otlp config schema', () => {
	it('accepts the smallest enabled block', () => {
		expect(() => validateOtlpConfig(block({}))).not.toThrow();
	});

	it("accepts '*' alone and refuses it beside a project", () => {
		expect(() => validateOtlpConfig(block({ projects: ['*'] }))).not.toThrow();
		expect(() => validateOtlpConfig(block({ projects: ['*', PROJECT] }))).toThrow(
			/must stand alone/,
		);
	});

	it('accepts a project list and refuses a non-UUID entry', () => {
		expect(() => validateOtlpConfig(block({ projects: [PROJECT] }))).not.toThrow();
		expect(() => validateOtlpConfig(block({ projects: ['my-project'] }))).toThrow(
			/neither '\*' nor a project UUID/,
		);
	});

	it('requires a project when enabled is true', () => {
		expect(() => validateOtlpConfig(block({ projects: [] }))).toThrow(/at least one project/);
	});

	it('requires an endpoint when enabled is true', () => {
		expect(() => validateOtlpConfig(block({ endpoint: '' }))).toThrow(/required when/);
	});

	it('treats sampleRatio (0, 1] as the accepted range', () => {
		expect(() => validateOtlpConfig(block({ sampleRatio: 0 }))).toThrow();
		expect(() => validateOtlpConfig(block({ sampleRatio: 1 }))).not.toThrow();
		expect(() => validateOtlpConfig(block({ sampleRatio: 1.1 }))).toThrow();
	});

	it('refuses any protocol but http/json', () => {
		expect(() => validateOtlpConfig(block({ protocol: 'grpc' }))).toThrow();
		expect(() => validateOtlpConfig(block({ protocol: 'http/json' }))).not.toThrow();
	});

	it('accepts plain http only on a loopback host', () => {
		for (const endpoint of [
			'http://[::1]:4318',
			'http://127.0.0.1:4318',
			'http://localhost:4318',
		]) {
			expect(() => validateOtlpConfig(block({ endpoint }))).not.toThrow();
		}
		for (const endpoint of ['http://[::2]:4318', 'http://collector.internal:4318']) {
			expect(() => validateOtlpConfig(block({ endpoint }))).toThrow(/https/);
		}
	});

	it('accepts https anywhere and refuses a non-http scheme', () => {
		expect(() =>
			validateOtlpConfig(block({ endpoint: 'https://collector.example' })),
		).not.toThrow();
		expect(() => validateOtlpConfig(block({ endpoint: 'grpc://collector.example' }))).toThrow(
			/https/,
		);
	});

	it('refuses an unknown key rather than ignoring it', () => {
		expect(() => validateOtlpConfig(block({ forwardRunLogs: true }))).toThrow();
	});

	it('checks the header secret name grammar', () => {
		expect(() => validateOtlpConfig(block({ headersSecret: 'OTLP_TOKEN' }))).not.toThrow();
		expect(() => validateOtlpConfig(block({ headersSecret: 'otlp_token' }))).toThrow();
	});
});

describe('otlp block in a config file', () => {
	it('is validated by the config-file loader', () => {
		expect(() =>
			validateConfigFile('/tmp/hezo.cjs', {
				port: 3100,
				otlp: { enabled: true, endpoint: 'https://collector.example', projects: [PROJECT] },
			}),
		).not.toThrow();
	});

	it('reports the offending otlp key by path', () => {
		expect(() =>
			validateConfigFile('/tmp/hezo.cjs', {
				otlp: { enabled: true, endpoint: 'http://collector.internal:4318', projects: ['*'] },
			}),
		).toThrow(ConfigFileError);
		expect(() =>
			validateConfigFile('/tmp/hezo.cjs', {
				otlp: { enabled: true, endpoint: 'http://collector.internal:4318', projects: ['*'] },
			}),
		).toThrow(/otlp\.endpoint/);
	});
});
