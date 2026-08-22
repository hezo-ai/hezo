/**
 * Guards that every agent CLI in the container image is pinned.
 *
 * A floating CLI changes a run's behaviour with no commit, no review and no
 * signal. Codex v0.116.0 changed how it sanitizes MCP tool names - hyphens
 * became underscores - and the change simply arrived mid-flight, silently
 * invalidating the tool names agents were told to look for. Two runs had already
 * lost themselves nearby. Nothing in the repo would have caught it, because
 * `npm install -g <pkg>` with no version is indistinguishable from a pinned one
 * at a glance and produces a different image every rebuild.
 *
 * It also guards that every pinned *binary* artifact is pinned once per
 * architecture. The image is published multi-arch (amd64 + arm64), but only the
 * release build builds arm64 - so a URL hardcoding one architecture installs a
 * binary the other leg cannot exec, and nothing says so until a release is
 * already blocked on it. Worse, the failure reads as `agy: not found` (the
 * missing x86-64 ELF loader in an arm64 rootfs), not as an architecture error.
 *
 * This is a text check over the Dockerfile on purpose: it must fail in an
 * ordinary shard, with no Docker daemon and no image pull, or it would only run
 * where the image already exists.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const dockerfile = readFileSync(resolve(ROOT, 'docker/Dockerfile.agent-base'), 'utf8');

/** Lines with continuations joined, so a multi-line RUN reads as one string. */
const joined = dockerfile.replace(/\\\n\s*/g, ' ');

describe('agent CLI pins', () => {
	it('pins every global npm install to an ARG version', () => {
		// `npm install -g pkg` and `npm install -g pkg@${VERSION}` look alike in a
		// diff; this is what makes the difference enforceable.
		const installs = [...joined.matchAll(/npm install -g (\S+)/g)].map((m) => m[1]);
		expect(installs.length).toBeGreaterThan(0);

		const unpinned = installs.filter((spec) => !/@\$\{[A-Z0-9_]+\}$/.test(spec));
		expect(
			unpinned,
			`unpinned global npm install(s): ${unpinned.join(', ')}. Add an ARG <NAME>_VERSION and install <pkg>@\${<NAME>_VERSION}.`,
		).toEqual([]);
	});

	it('declares an ARG default for every version referenced by an install', () => {
		// An ARG with no default silently resolves to empty at build time, which npm
		// reads as "latest" - a pin that is not one.
		const referenced = new Set(
			[...joined.matchAll(/\$\{([A-Z0-9_]+_VERSION)\}/g)].map((m) => m[1]),
		);
		expect(referenced.size).toBeGreaterThan(0);

		for (const name of referenced) {
			const declared = new RegExp(`^ARG ${name}=\\S+`, 'm').test(dockerfile);
			expect(declared, `${name} is used but has no "ARG ${name}=<value>" default`).toBe(true);
		}
	});

	it('covers every AI coding CLI the runtimes drive', () => {
		// A new runtime whose CLI is added here without a pin is the regression this
		// names explicitly, rather than leaving it to the generic checks above.
		for (const pkg of [
			'@anthropic-ai/claude-code',
			'@openai/codex',
			'opencode-ai',
			'@moonshot-ai/kimi-code',
		]) {
			expect(
				new RegExp(`npm install -g ${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@\\$\\{`).test(
					joined,
				),
				`${pkg} is not pinned`,
			).toBe(true);
		}
		// Grok and Antigravity are native binaries, not npm packages.
		expect(/ARG GROK_VERSION=/.test(dockerfile)).toBe(true);
		expect(/ARG AGY_VERSION=/.test(dockerfile)).toBe(true);
	});

	it('pins Antigravity by checksum, since its installer takes no version', () => {
		// Upstream's installer accepts only -d and -h, and its manifest exposes the
		// current release only, so there is no version to ask for. The artifact path
		// also carries an opaque build id after the version, so the URL cannot be
		// rebuilt from AGY_VERSION - it has to be recorded, and then the download
		// needs its own integrity check because nothing else verifies it.
		expect(/ARG AGY_URL_AMD64=https:\/\/\S+/.test(dockerfile)).toBe(true);
		expect(/ARG AGY_URL_ARM64=https:\/\/\S+/.test(dockerfile)).toBe(true);
		expect(/ARG AGY_SHA512_AMD64=[0-9a-f]{100,}/.test(dockerfile)).toBe(true);
		expect(/ARG AGY_SHA512_ARM64=[0-9a-f]{100,}/.test(dockerfile)).toBe(true);
		expect(joined).toContain('sha512sum -c -');
		// The version and the URL are two facts that can disagree; this is what
		// makes a mismatched pair fail the build rather than ship mislabelled.
		expect(joined).toContain('agy --version | grep -q "${AGY_VERSION}"');
		// Piping the installer would silently reintroduce "latest".
		expect(joined).not.toMatch(/antigravity\.google\/cli\/install\.sh\s*\|/);
	});

	it('carries the pinned Antigravity version in both artifact URLs', () => {
		// A bump that updates one arch and forgets the other is the likely next
		// mistake: the build still passes on amd64, and the arm64 leg only runs at
		// release. Both URLs carry the version in their path, so this catches it.
		const version = dockerfile.match(/^ARG AGY_VERSION=(\S+)/m)?.[1];
		expect(version, 'ARG AGY_VERSION has no default').toBeTruthy();

		for (const arch of ['AMD64', 'ARM64']) {
			const url = dockerfile.match(new RegExp(`^ARG AGY_URL_${arch}=(\\S+)`, 'm'))?.[1] ?? '';
			expect(
				url.includes(`/${version}-`),
				`AGY_URL_${arch} (${url}) does not carry AGY_VERSION ${version} - a half-finished bump`,
			).toBe(true);
		}
	});

	it('pins every architecture-specific download once per architecture', () => {
		// The image ships multi-arch, but only the release build builds arm64, so a
		// URL that names one architecture is a release-time failure with no earlier
		// signal. Every such pin is an ARG pair, selected at build time.
		const archToken = /(?:^|[^a-z0-9])(x64|x86[_-]?64|amd64|aarch64|arm64)(?:[^a-z0-9]|$)/i;
		const args = [...dockerfile.matchAll(/^ARG ([A-Z0-9_]+)=(\S+)$/gm)];
		const names = new Set(args.map(([, name]) => name));

		for (const [, name, value] of args) {
			if (!value.startsWith('https://') || !archToken.test(value)) continue;

			const suffix = name.match(/_(AMD64|ARM64)$/)?.[1];
			expect(
				suffix,
				`ARG ${name} downloads an architecture-specific artifact but is not arch-suffixed. Split it into ${name}_AMD64 / ${name}_ARM64 and select on TARGETARCH.`,
			).toBeTruthy();

			const sibling = `${name.slice(0, -suffix!.length)}${suffix === 'AMD64' ? 'ARM64' : 'AMD64'}`;
			expect(names.has(sibling), `${name} has no ${sibling} counterpart`).toBe(true);
		}
	});

	it('selects the architecture-specific artifact at build time', () => {
		// An ARG pair nothing reads is a pin that does not apply. BuildKit fills
		// TARGETARCH in per target platform; declaring it is what makes it arrive.
		expect(/^ARG TARGETARCH$/m.test(dockerfile), 'TARGETARCH is not declared').toBe(true);
		for (const arg of ['AGY_URL_AMD64', 'AGY_URL_ARM64', 'AGY_SHA512_AMD64', 'AGY_SHA512_ARM64']) {
			expect(joined, `${arg} is declared but never read`).toContain(`\${${arg}}`);
		}
	});

	it('verifies each pinned CLI actually runs', () => {
		// A wrong version number is a typo away, and a bad pin that only surfaces on
		// an agent run is the slowest possible feedback. Every install ends in a
		// --version call so the image build fails instead.
		for (const cmd of ['claude --version', 'codex --version', 'opencode --version']) {
			expect(joined, `${cmd} missing from the image build`).toContain(cmd);
		}
	});
});
