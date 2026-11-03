import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {buildAgentDefinitions, MAX_AGENT_BYTES, MAX_AGENT_FILES, MAX_DEFINITIONS, readAgentFile} from '../../src/chat/agent-defs.js';
import {DEFAULT_TIERS, tierMapFromState} from '../../src/chat/tiers.js';
import {makeFakeLog, serialized} from '../helpers/fake-log.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-defs-'));
after(() => rmSync(root, {recursive: true, force: true}));
let n = 0;
const dirs = () => {
	const base = path.join(root, `case-${++n}`);
	const project = path.join(base, 'project');
	const user = path.join(base, 'user');
	mkdirSync(project, {recursive: true});
	mkdirSync(user, {recursive: true});
	return {project, user};
};
const agent = (dir: string, file: string, head: string, body = 'Do the work.') => {
	writeFileSync(path.join(dir, file), `---\n${head}\n---\n${body}\n`);
	return path.join(dir, file);
};

test('a fixed tier becomes a definition with the map model and effort; tools in both list forms', async () => {
	const {project, user} = dirs();
	agent(project, 'reviewer.md', 'name: reviewer\ndescription: Reviews code\nmodel: strong\neffort: low\ncolor: red\ntools: Read, Grep, Bash(git:*)\ndisallowedTools: [Write, "Edit"]\nmaxTurns: 20\nmemory: project\nbackground: true\nskills: [lint]');
	agent(user, 'helper.md', 'description: "Helps"\nmodel: light', 'Help out.');
	const log = makeFakeLog();
	const map = tierMapFromState({tierStrongModel: 'fable', tierStrongEffort: 'xhigh'});
	const defs = await buildAgentDefinitions({dirs: [project, user], map, log});
	assert.deepEqual(defs.reviewer, {
		description: 'Reviews code',
		prompt: 'Do the work.',
		model: 'fable',
		effort: 'xhigh',
		tools: ['Read', 'Grep', 'Bash(git:*)'],
		disallowedTools: ['Write', 'Edit'],
		skills: ['lint'],
		maxTurns: 20,
		memory: 'project',
		background: true,
	});
	assert.deepEqual(defs.helper, {description: 'Helps', prompt: 'Help out.', model: DEFAULT_TIERS.light.model, effort: DEFAULT_TIERS.light.effort});
	assert.ok(log.records.some(r => r.msg === 'agent definitions' && r.fields.count === 2 && r.level === 'debug'));
});

test('ranges get a definition at their default; concrete models and skipped files get none, with the reason logged and no name', async () => {
	const {project} = dirs();
	agent(project, 'ranged.md', 'name: secret-ranged\ndescription: d\nmodel: light/STRONG');
	agent(project, 'model-only.md', 'name: secret-model\ndescription: d\nmodel: opus');
	const cases: [string, string, string][] = [
		['mode.md', 'name: secret-mode\ndescription: d\nmodel: max\npermissionMode: bypassPermissions', 'key'],
		['hooks.md', 'name: secret-hooks\ndescription: d\nmodel: max\nhooks: x', 'key'],
		['mcp.md', 'name: secret-mcp\ndescription: d\nmodel: max\nmcp_servers: x', 'key'],
		['allowed.md', 'name: secret-allowed\ndescription: d\nmodel: max\nallowed-tools: Bash', 'key'],
		['multi.md', 'name: secret-multi\ndescription: |\n  long\nmodel: max', 'yaml'],
		['list.md', 'name: secret-list\ndescription: d\nmodel: max\ntools:\n  - Read', 'yaml'],
		['value.md', 'name: secret-value\ndescription: d\nmodel: max\nmaxTurns: 5000', 'value'],
		['badtool.md', 'name: secret-badtool\ndescription: d\nmodel: max\ntools: Read; rm -rf', 'value'],
		['nodesc.md', 'name: secret-nodesc\nmodel: max', 'missing'],
	];
	for (const [file, head] of cases) agent(project, file, head);
	writeFileSync(path.join(project, 'big.md'), `---\nname: secret-big\ndescription: d\nmodel: max\n---\n${'x'.repeat(MAX_AGENT_BYTES)}`);
	const log = makeFakeLog();
	const defs = await buildAgentDefinitions({dirs: [project], map: DEFAULT_TIERS, log});
	assert.deepEqual(Object.keys(defs), ['secret-ranged']);
	assert.equal(defs['secret-ranged']!.model, DEFAULT_TIERS.strong.model);
	for (const [file, , reason] of cases) {
		const r = await readAgentFile(path.join(project, file));
		assert.deepEqual(r, {skip: reason}, file);
	}
	assert.deepEqual(await readAgentFile(path.join(project, 'big.md')), {skip: 'size'});
	const reasons = log.records.filter(r => r.msg === 'agent definition skipped').map(r => r.fields.reason).sort();
	assert.deepEqual(reasons, ['key', 'key', 'key', 'key', 'missing', 'size', 'value', 'value', 'yaml', 'yaml']);
	assert.ok(!serialized(log).includes('secret'), 'no agent names in the log');
	const ranged = await readAgentFile(path.join(project, 'ranged.md'));
	assert.ok('file' in ranged && ranged.file.tier?.low === 'light' && ranged.file.tier.high === 'strong' && ranged.file.tier.default === 'strong');
	const modelOnly = await readAgentFile(path.join(project, 'model-only.md'));
	assert.ok('file' in modelOnly && modelOnly.file.hasModel && modelOnly.file.tier === undefined);
});

test('the project file wins over a user file of the same name', async () => {
	const {project, user} = dirs();
	agent(project, 'a.md', 'name: same\ndescription: project one\nmodel: light');
	agent(user, 'b.md', 'name: same\ndescription: user one\nmodel: max');
	const defs = await buildAgentDefinitions({dirs: [project, user], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.equal(defs.same?.description, 'project one');
	assert.equal(defs.same?.model, DEFAULT_TIERS.light.model);
});

test('at most 100 files per folder are read and at most 50 definitions made', async () => {
	const {project, user} = dirs();
	for (let i = 0; i < MAX_AGENT_FILES + 5; i++) agent(project, `p${String(i).padStart(3, '0')}.md`, `description: d\nmodel: light`);
	const defs = await buildAgentDefinitions({dirs: [project, user], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.equal(Object.keys(defs).length, MAX_DEFINITIONS);
	const {project: p2} = dirs();
	for (let i = 0; i < MAX_AGENT_FILES + 5; i++) agent(p2, `p${String(i).padStart(3, '0')}.md`, i < MAX_AGENT_FILES ? 'description: d' : 'description: d\nmodel: max');
	const none = await buildAgentDefinitions({dirs: [p2], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.deepEqual(Object.keys(none), [], 'files after the first 100 are not read');
});

test('a skipped project file shadows a hub definition with its frontmatter name', async () => {
	const {project, user} = dirs();
	agent(project, 'local-file.md', 'name: shared-agent\ndescription: d\nmodel: max\npermissionMode: bypassPermissions');
	agent(user, 'shared-agent-hub.md', 'name: shared-agent\ndescription: hub\nmodel: light');
	const defs = await buildAgentDefinitions({dirs: [project, user], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.equal(defs['shared-agent'], undefined);
});

test('the tier key is no longer honoured and broken tier syntax gives no definition', async () => {
	const {project} = dirs();
	agent(project, 'old.md', 'name: old\ndescription: d\ntier: max');
	agent(project, 'broken.md', 'name: broken\ndescription: d\nmodel: strong/light');
	agent(project, 'inherit.md', 'name: inherits\ndescription: d\nmodel: inherit');
	agent(project, 'three.md', 'name: three\ndescription: d\nmodel: light/standard/max');
	assert.deepEqual(await readAgentFile(path.join(project, 'old.md')), {skip: 'key'});
	const broken = await readAgentFile(path.join(project, 'broken.md'));
	assert.ok('file' in broken && broken.file.hasModel && broken.file.tier === undefined);
	const defs = await buildAgentDefinitions({dirs: [project], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.deepEqual(Object.keys(defs), ['three']);
	assert.equal(defs.three!.model, DEFAULT_TIERS.standard.model);
});
