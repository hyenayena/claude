import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';

const hostRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const src = (name: string) => pathToFileURL(fileURLToPath(new URL('../../src/ui/' + name, import.meta.url))).href;
const harness = pathToFileURL(fileURLToPath(new URL('../helpers/harness.ts', import.meta.url))).href;

const script = `
const {mountHarness} = await import(${JSON.stringify(harness)});
const {secretPrompt} = await import(${JSON.stringify(src('secret-prompt.tsx'))});
const {namePrompt} = await import(${JSON.stringify(src('name-prompt.tsx'))});
const control = {close() {}};
const frames = {};
const show = async (name, el) => {
	const h = mountHarness(el);
	await h.settle(40);
	frames[name] = h.lastFrame();
	h.unmount();
};
await show('secret', secretPrompt(control, 'secret-ok', () => {}));
await show('name', namePrompt(control, 'name-ok', 'suggested-ok', () => undefined, () => {}));
process.stdout.write('FRAMES:' + JSON.stringify(frames));
process.exit(0);
`;

test('the prompts render under tsx run from the host root', () => {
	const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
		cwd: hostRoot,
		encoding: 'utf8',
		timeout: 60_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /ReferenceError|React is not defined/);
	const frames = JSON.parse(result.stdout.slice(result.stdout.indexOf('FRAMES:') + 7)) as Record<string, string>;
	assert.match(frames['secret'] as string, /secret-ok/);
	assert.match(frames['name'] as string, /name-ok/);
	assert.match(frames['name'] as string, /suggested-ok/);
});
