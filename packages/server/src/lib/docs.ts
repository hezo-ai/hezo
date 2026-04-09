import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

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
