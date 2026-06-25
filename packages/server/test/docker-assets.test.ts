import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AGENT_BASE_CONTEXT_DIR,
	extractBundledDockerContext,
	extractDockerContext,
} from '../src/services/docker-assets';

describe('docker-assets', () => {
	let dirs: string[] = [];

	function tmp(): string {
		const d = mkdtempSync(join(tmpdir(), 'hezo-docker-assets-'));
		dirs.push(d);
		return d;
	}

	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs = [];
	});

	it('extractDockerContext writes the bundle verbatim under the data dir, preserving layout', async () => {
		const dataDir = tmp();
		const dockerfile = 'FROM node:24-slim\nRUN echo hi\n';
		const script = '#!/bin/sh\necho bridge\n';
		const bundle = {
			'docker/Dockerfile.agent-base': Buffer.from(dockerfile).toString('base64'),
			'docker/scripts/hezo-ssh-bridge': Buffer.from(script).toString('base64'),
		};

		const root = await extractDockerContext(dataDir, bundle);

		expect(root).toBe(join(dataDir, AGENT_BASE_CONTEXT_DIR));
		// Files land at <root>/docker/... so resolveLocalImage finds them under root.
		expect(readFileSync(join(root, 'docker', 'Dockerfile.agent-base'), 'utf8')).toBe(dockerfile);
		expect(readFileSync(join(root, 'docker', 'scripts', 'hezo-ssh-bridge'), 'utf8')).toBe(script);
	});

	it('extractDockerContext round-trips arbitrary bytes via base64', async () => {
		const dataDir = tmp();
		const bytes = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x0a]);
		const root = await extractDockerContext(dataDir, {
			'docker/raw.bin': bytes.toString('base64'),
		});
		expect(readFileSync(join(root, 'docker', 'raw.bin'))).toEqual(bytes);
	});

	it('extractBundledDockerContext returns null when no bundle is embedded (dev/tests)', async () => {
		// The test build leaves docker-bundle.json an empty stub, so the loader
		// reports "absent" and the caller falls back to the repo docker/ dir.
		expect(await extractBundledDockerContext(tmp())).toBeNull();
	});
});
