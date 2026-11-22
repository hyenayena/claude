import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {ProjectAccess, ProjectAccessReader} from '../../src/deps/project.js';
import {buildScope} from '../../src/policy.js';

export const RULES = '[deny read]\n.env*\n!.env.example\nsecrets/\n[ask read]\nnotes/private.md\n[deny write]\nscripts/\n/compose.yaml\n[ask write]\n/package.json\n**/.git/config\n';

export function rulesFixture() {
	const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-rules-chat-')));
	const workplace = path.join(tmp, 'workplace');
	const stage = path.join(tmp, 'stage');
	const web = path.join(workplace, 'web');
	const hub = path.join(tmp, 'data', 'md');
	const dataDir = path.join(tmp, 'data', 'claude');
	const projectData = path.join(tmp, 'data', 'project');
	const put = (file: string, text = 'x') => {
		mkdirSync(path.dirname(file), {recursive: true});
		writeFileSync(file, text);
	};
	for (const d of [stage, hub, path.join(dataDir, 'config'), path.join(projectData, 'rules')]) mkdirSync(d, {recursive: true});
	for (const f of ['.env', '.env.example', 'a.ts', 'notes/private.md', 'notes/public.md', 'scripts/x.sh', 'compose.yaml', 'package.json', '.git/config', 'secrets/k']) put(path.join(web, f));
	put(path.join(web, '.yenarules'), RULES);
	const access: ProjectAccess = {roots: [workplace, stage], docs: path.join(hub, 'projects'), managed: [workplace, stage], writable: [web]};
	const reader: ProjectAccessReader = {
		dataDir: projectData,
		rulesFile: n => path.join(projectData, 'rules', `${n}.yenarules`),
		read: async () => access,
		readSync: () => access,
	};
	const paths = {
		projectDir: web,
		hubDir: hub,
		mdDir: path.join(dataDir, 'md'),
		dataDir,
		configDir: path.join(dataDir, 'config'),
		stateFile: path.join(dataDir, 'state.json'),
		credentialsFile: path.join(dataDir, 'credentials.json'),
		projects: reader,
	};
	return {
		tmp,
		web,
		hub,
		paths,
		put,
		scope: buildScope(paths, path.join(tmp, 'home')),
		cleanup: () => rmSync(tmp, {recursive: true, force: true}),
	};
}
