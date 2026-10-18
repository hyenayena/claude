import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React from 'react';
import {stringWidth} from '../../src/chat/wrap.js';
import {makeReveal} from '../../src/chat/reveal.js';
import {makeScrub} from '../../src/chat/scrub.js';
import type {PermissionRequest} from '../../src/chat/permission.js';
import {ChatView} from '../../src/ui/ChatView.js';
import {fakeController, mountHarness, questionReq, toolReq} from './testkit.js';

const reveal = makeReveal(s => s);
const scrub = makeScrub(s => s);
const ESC = '\u001b';
const BEL = '\u0007';
const bidi = String.fromCharCode(0x202e);
const lineSep = String.fromCharCode(0x2028);
const SGR = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const RAW_CONTROL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${bidi}${lineSep}]`);

const hostileLines = Array.from({length: 100}, (_, i) => `line ${i} ${ESC}[31m ${bidi} wide-日本語`).join('\n');
const hostile: Record<string, PermissionRequest> = {
	bash: toolReq({
		input: {command: `echo ${ESC}]0;pwn${BEL} ${'x'.repeat(300)}\n${hostileLines}`},
		description: `d ${ESC}[2J`,
		highlights: [{level: 'warn', text: `w ${ESC}]0;x${BEL}`}],
	}),
	edit: toolReq({
		toolName: 'Edit',
		path: `/app/${ESC}[31mx${bidi}.ts`,
		input: {file_path: 'x'},
		always: false,
		defaultToNo: true,
		preview: {
			rows: Array.from({length: 500}, (_, i) => ({
				kind: (['add', 'del', 'ctx'] as const)[i % 3] as 'add' | 'del' | 'ctx',
				text: `l${i} ${ESC}[1m 日本 ${bidi}`,
				no: i + 1,
			})),
			added: 100,
			removed: 100,
			truncated: true,
			approximate: false,
		},
	}),
	symlink: toolReq({
		toolName: 'Write',
		path: '/app/sub/linkpkg',
		resolvedPath: `/app/${ESC}[31mpackage${bidi}.json ${'y'.repeat(200)}`,
		input: {file_path: 'sub/linkpkg', content: 'x'},
		always: false,
	}),
	question: questionReq({
		questions: [
			{
				question: `Q ${ESC}[2J ${'long '.repeat(60)}`,
				header: `H${ESC}[1m`,
				multiSelect: true,
				options: [
					{label: `L1 ${ESC}[31m`, description: 'd'.repeat(300)},
					{label: 'L2', description: ''},
					{label: 'L3 日本語', description: bidi},
					{label: 'L4', description: ''},
				],
			},
		],
	}),
};

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

for (const [name, request] of Object.entries(hostile)) {
	test(`${name} prompt stays inside the terminal and shows no raw control at any size`, async () => {
		for (const rows of [24, 17, 12, 10, 8, 7, 6, 5, 4, 3]) {
			for (const columns of [80, 40, 20]) {
				const controller = fakeController();
				controller.pendingPermissions.push(request);
				const h = mountHarness(
					<ChatView
						controller={controller}
						print={() => {}}
						close={() => {}}
						scrub={scrub}
						reveal={reveal}
						credentialLabel="API key"
						armMs={20}
						projectDir="/app"
					/>,
					{columns, rows},
				);
				cleanup.push(() => h.unmount());
				await h.settle(60);
				const frame = h.lastFrame();
				const lines = frame.replace(/\n+$/, '').split('\n');
				const tag = `${name} ${rows}x${columns}`;
				assert.ok(lines.length <= rows - 1, `${tag}: ${lines.length} rows`);
				for (const line of lines) {
					const plain = line.replace(SGR, '');
					assert.ok(stringWidth(plain) <= columns, `${tag}: ${stringWidth(plain)} cells`);
					assert.doesNotMatch(plain, RAW_CONTROL, `${tag}: raw control character`);
				}
				assert.match(frame.replace(SGR, ''), /API key/, `${tag}: status bar`);
			}
		}
	});
}
