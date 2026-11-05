import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gallerySections, registerGallerySection, styledCells, stripStyles, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {chatGallerySection, diffGallerySection, planGallerySection, statusGallerySection, toolsGallerySection} from '../../src/ui/gallery.js';

const ESC = String.fromCharCode(27);

test('the chat section renders at 39, 79 and 159 columns within the width', async () => {
	const render = await chatGallerySection.load();
	for (const width of [39, 79, 159]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			const rows = withColorDepth(depth, () => render({width, depth, ascii: false}));
			assert.ok(rows.length > 12);
			for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
		}
	}
});

test('the rows hold only SGR escapes and the sample pieces', async () => {
	const render = await chatGallerySection.load();
	const rows = withColorDepth('256', () => render({width: 79, depth: '256', ascii: false}));
	const rest = rows.join('\n').replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
	assert.ok(!rest.includes(ESC));
	for (const part of ['Fix the failing test', 'thinking', 'Edit', '$ npm test', 'Error: ']) assert.ok(rest.includes(part), part);
});

test('registering the section is accepted once', () => {
	assert.equal(registerGallerySection(chatGallerySection), true);
	assert.equal(registerGallerySection(chatGallerySection), false);
	assert.ok(gallerySections().some(s => s.name === 'chat'));
});

test('the diff section renders at 39, 79, 159 and 200 columns within the width', async () => {
	const render = await diffGallerySection.load();
	for (const width of [39, 79, 159, 200]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			const rows = withColorDepth(depth, () => render({width, depth, ascii: false}));
			assert.ok(rows.length > 20);
			for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
			const text = rows.map(stripStyles).join('\n');
			assert.match(text, /⋯ 34 unchanged lines/);
			assert.match(text, /\+\d+ lines \(ctrl\+o to expand\)/);
			if (width >= 159) assert.ok(rows.map(stripStyles).some(r => r.split('│').length === 3));
			else assert.match(text, /side-by-side from 160 columns/);
		}
	}
	const rows = withColorDepth('truecolor', () => render({width: 79, depth: 'truecolor', ascii: false}));
	assert.ok(rows.join('\n').includes('38;2;198;120;221'), 'syntax colours after the preload');
});

test('the diff section is registered next to the chat one', () => {
	assert.equal(registerGallerySection(diffGallerySection), true);
	assert.equal(registerGallerySection(diffGallerySection), false);
	assert.ok(gallerySections().some(s => s.name === 'diff'));
});

test('the tools section renders at 39, 79, 159 and 200 columns within the width', async () => {
	const render = await toolsGallerySection.load();
	for (const width of [39, 79, 159, 200]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			const rows = withColorDepth(depth, () => render({width, depth, ascii: false}));
			for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
			const text = rows.map(stripStyles).join('\n');
			for (const part of ['Read 3 files, searched 2 patterns', 'exit 1', 'earlier lines', 'denied', '+2 lines', 'github:search_issues']) {
				if (width >= 79) assert.ok(text.includes(part), `${width} ${part}`);
			}
		}
	}
});

test('the markdown section renders at 39, 79 and 159 columns within the width', async () => {
	const {markdownGallerySection} = await import('../../src/ui/markdown-gallery.js');
	assert.equal(markdownGallerySection.name, 'markdown');
	const render = await markdownGallerySection.load();
	for (const width of [39, 79, 159]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			const rows = withColorDepth(depth, () => render({width, depth, ascii: false}));
			const text = rows.map(stripStyles).join('\n');
			for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
			for (const part of ['Heading one', 'nested item', '╭─ typescript', '╭─ bash', '┬', '⋯ +10 lines', '✻ thinking · 12s (ctrl+o)']) assert.ok(text.includes(part), `${width} ${depth}: ${part}`);
			assert.ok(!text.includes('copy'));
			assert.ok(!rows.join('\n').replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').includes(ESC));
		}
	}
});

test('the status section renders within the width at every depth and is registered', async () => {
	const render = await statusGallerySection.load();
	for (const width of [39, 79, 159]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			for (const ascii of [false, true]) {
				const rows = withColorDepth(depth, () => render({width, depth, ascii}));
				assert.ok(rows.length > 10);
				for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
			}
		}
	}
	const text = withColorDepth('none', () => render({width: 159, depth: 'none', ascii: false})).map(stripStyles).join('\n');
	for (const part of ['idle', 'awaiting approval', 'esc to interrupt', 'interrupted', '3 files changed']) assert.ok(text.includes(part), part);
	assert.equal(registerGallerySection(statusGallerySection), true);
});

test('the plan section renders within the width in every mode, with notes', async () => {
	const render = await planGallerySection.load();
	for (const width of [39, 79, 159]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			for (const ascii of [false, true]) {
				const rows = withColorDepth(depth, () => render({width, depth, ascii}));
				for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
				const text = rows.map(stripStyles).join('\n');
				assert.match(text, /Plan 2\/6/);
				assert.match(text, /\+\d+ more/);
				assert.match(text, /Plan done/);
				assert.match(text, /Plan · 6 steps/);
			}
		}
	}
});
