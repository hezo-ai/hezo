import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadFilesystemDefaultSkills } from '../src/db/default-skills';

const skillsDir = join(import.meta.dir, '..', '..', '..', 'skills');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'skills-bundle.json');

const skills = await loadFilesystemDefaultSkills(skillsDir);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(skills));
console.log(`Bundled default skills → ${outputPath}`);
