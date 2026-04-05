import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SkillManifest } from '@hezo/shared';

/**
 * Resolve the path to a company's directory on the host filesystem.
 * Layout: {dataDir}/companies/{companySlug}/
 */
export function resolveCompanyPath(dataDir: string, companySlug: string): string {
	return join(dataDir, 'companies', companySlug);
}

/**
 * Resolve the path to a project's directory on the host filesystem.
 * Layout: {dataDir}/companies/{companySlug}/projects/{projectSlug}/
 */
export function resolveProjectPath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
): string {
	return join(dataDir, 'companies', companySlug, 'projects', projectSlug);
}

/**
 * Resolve the absolute path to the designated repo's .dev/ folder.
 * Layout: {dataDir}/companies/{companySlug}/projects/{projectSlug}/{repoShortName}/.dev/
 */
export function resolveDevDocsPath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	repoShortName: string,
): string {
	return join(dataDir, 'companies', companySlug, 'projects', projectSlug, repoShortName, '.dev');
}

/**
 * Resolve the absolute path to the designated repo's AGENTS.md.
 */
export function resolveAgentsMdPath(
	dataDir: string,
	companySlug: string,
	projectSlug: string,
	repoShortName: string,
): string {
	return join(
		dataDir,
		'companies',
		companySlug,
		'projects',
		projectSlug,
		repoShortName,
		'AGENTS.md',
	);
}

/**
 * Read a file from the .dev/ folder of a designated repo.
 * Returns null if file doesn't exist.
 */
export function readDocFile(devDocsPath: string, filename: string): string | null {
	const filePath = join(devDocsPath, filename);
	if (!existsSync(filePath)) return null;
	return readFileSync(filePath, 'utf-8');
}

/**
 * Write a file to the .dev/ folder of a designated repo.
 * Creates the .dev/ directory if it doesn't exist.
 */
export function writeDocFile(devDocsPath: string, filename: string, content: string): string {
	mkdirSync(devDocsPath, { recursive: true });
	const filePath = join(devDocsPath, filename);
	writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

/**
 * Delete a file from the .dev/ folder.
 * Returns true if file existed and was deleted, false if it didn't exist.
 */
export function deleteDocFile(devDocsPath: string, filename: string): boolean {
	const filePath = join(devDocsPath, filename);
	if (!existsSync(filePath)) return false;
	unlinkSync(filePath);
	return true;
}

/**
 * List all files in the .dev/ folder.
 * Returns an array of filenames (not full paths).
 */
export function listDocFiles(devDocsPath: string): string[] {
	if (!existsSync(devDocsPath)) return [];
	return readdirSync(devDocsPath).filter((f) => !f.startsWith('.'));
}

/**
 * Resolve the path to a company's skills directory on the host filesystem.
 * Layout: {dataDir}/companies/{companySlug}/skills/
 */
export function resolveSkillsPath(dataDir: string, companySlug: string): string {
	return join(dataDir, 'companies', companySlug, 'skills');
}

const SKILL_MANIFEST_FILENAME = '.manifest.json';

/**
 * Read the skills manifest from a skills directory.
 * Returns an empty manifest if the file doesn't exist.
 */
export function readSkillManifest(skillsDir: string): SkillManifest {
	const manifestPath = join(skillsDir, SKILL_MANIFEST_FILENAME);
	if (!existsSync(manifestPath)) return { skills: [] };
	try {
		const raw = readFileSync(manifestPath, 'utf-8');
		const parsed = JSON.parse(raw) as SkillManifest;
		if (!parsed || !Array.isArray(parsed.skills)) return { skills: [] };
		return parsed;
	} catch {
		return { skills: [] };
	}
}

/**
 * Write the skills manifest to a skills directory.
 * Creates the skills directory if it doesn't exist.
 */
export function writeSkillManifest(skillsDir: string, manifest: SkillManifest): void {
	mkdirSync(skillsDir, { recursive: true });
	const manifestPath = join(skillsDir, SKILL_MANIFEST_FILENAME);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

/**
 * Read a skill markdown file by slug. Returns null if not found.
 */
export function readSkillFile(skillsDir: string, slug: string): string | null {
	const filePath = join(skillsDir, `${slug}.md`);
	if (!existsSync(filePath)) return null;
	return readFileSync(filePath, 'utf-8');
}

/**
 * Write a skill markdown file by slug. Creates the skills directory if needed.
 */
export function writeSkillFile(skillsDir: string, slug: string, content: string): string {
	mkdirSync(skillsDir, { recursive: true });
	const filePath = join(skillsDir, `${slug}.md`);
	writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

/**
 * Delete a skill markdown file by slug. Returns true if it existed.
 */
export function deleteSkillFile(skillsDir: string, slug: string): boolean {
	const filePath = join(skillsDir, `${slug}.md`);
	if (!existsSync(filePath)) return false;
	unlinkSync(filePath);
	return true;
}

/**
 * List skill filenames (without .md extension) in a skills directory.
 */
export function listSkillFiles(skillsDir: string): string[] {
	if (!existsSync(skillsDir)) return [];
	return readdirSync(skillsDir)
		.filter((f) => f.endsWith('.md') && !f.startsWith('.'))
		.map((f) => f.slice(0, -3));
}

/**
 * Read all skill contents for injection into a system prompt.
 * Returns skills in manifest order with name and content.
 */
export function readAllSkillContents(skillsDir: string): Array<{ name: string; content: string }> {
	if (!existsSync(skillsDir)) return [];
	const manifest = readSkillManifest(skillsDir);
	const results: Array<{ name: string; content: string }> = [];
	for (const entry of manifest.skills) {
		const content = readSkillFile(skillsDir, entry.slug);
		if (content !== null) {
			results.push({ name: entry.name, content });
		}
	}
	return results;
}
