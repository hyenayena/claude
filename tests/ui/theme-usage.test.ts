import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

for (const name of ['present.ts', 'markdown.ts', 'banner.ts', 'agent-view.ts', 'file-card.ts', 'highlight.ts', 'tool-card.ts', 'tool-kind.ts', 'tool-args.ts', 'LiveTools.tsx', 'markdown-parse.ts', 'markdown-table.ts', 'markdown-gallery.ts', 'status-bar.ts', 'ChatStatusBar.tsx', 'turn-summary.ts', 'gallery.ts', 'plan-widget.ts', 'PlanWidget.tsx', 'ChatHeader.tsx', 'store.ts']) {
	test(`${name} takes its colours from the theme, not from escape literals`, () => {
		const source = readFileSync(fileURLToPath(new URL(`../../src/ui/${name}`, import.meta.url)), 'utf8');
		assert.ok(!source.includes('\\u001b'), 'a \\u001b literal');
		assert.ok(!source.includes('\\x1b['), 'a \\x1b[ literal');
		assert.ok(!source.includes(String.fromCharCode(27)), 'a raw ESC character');
	});
}

test('no hex colour is left in src/ui', () => {
	const dir = fileURLToPath(new URL('../../src/ui/', import.meta.url));
	for (const name of readdirSync(dir).filter(n => /\.tsx?$/.test(n))) {
		assert.ok(!/#[0-9a-fA-F]{6}\b/.test(readFileSync(`${dir}${name}`, 'utf8')), `${name} has a hex colour`);
	}
});
