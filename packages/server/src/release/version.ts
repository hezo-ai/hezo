/**
 * Semantic-version computation from Conventional-Commit metadata. Pure
 * arithmetic over `MAJOR.MINOR.PATCH` strings — no `v` prefix, no pre-release
 * tags. Avoids a `semver` dependency for the simple scheme we use.
 */
import type { ParsedCommit } from './conventional.js';

export type Bump = 'major' | 'minor' | 'patch' | 'none';
export type ReleaseType = 'auto' | 'major' | 'minor' | 'patch';

/** Version used as the base when there is no previous release tag. */
export const INITIAL_BASE_VERSION = '0.0.0';
/** Default first-release version when bumping from {@link INITIAL_BASE_VERSION}. */
export const FIRST_RELEASE_VERSION = '0.1.0';

/** Derive the bump implied by a set of commits, ignoring any explicit override. */
export function computeBump(commits: ParsedCommit[]): Bump {
	let bump: Bump = 'none';
	for (const c of commits) {
		if (c.breaking) {
			return 'major';
		}
		if (c.type === 'feat') {
			bump = 'minor';
		} else if (bump === 'none' && c.type !== '') {
			bump = 'patch';
		}
	}
	return bump;
}

/** Apply an explicit release-type override; `auto` keeps the computed bump. */
export function applyOverride(auto: Bump, override: ReleaseType): Bump {
	return override === 'auto' ? auto : override;
}

function parse(version: string): [number, number, number] {
	const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (!m) {
		throw new Error(`Not a plain semver version: ${version}`);
	}
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compute the next version string from a previous version and a bump. When the
 * previous version is the initial base (no prior release), a non-major bump
 * yields {@link FIRST_RELEASE_VERSION} so the first release lands at 0.1.0.
 */
export function nextVersion(prev: string, bump: Bump): string {
	if (bump === 'none') {
		throw new Error('Cannot compute next version for a "none" bump');
	}

	const isInitial = prev.trim() === INITIAL_BASE_VERSION;
	if (isInitial && bump !== 'major') {
		return FIRST_RELEASE_VERSION;
	}

	const [major, minor, patch] = parse(prev);
	switch (bump) {
		case 'major':
			return `${major + 1}.0.0`;
		case 'minor':
			return `${major}.${minor + 1}.0`;
		case 'patch':
			return `${major}.${minor}.${patch + 1}`;
	}
}
