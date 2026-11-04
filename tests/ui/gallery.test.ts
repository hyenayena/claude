import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gallerySections, registerGallerySection, styledCells, stripStyles, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {chatGallerySection} from '../../src/ui/gallery.js';

const ESC = String.fromCharCode(27);

test('the chat section renders at 39, 79 and 159 columns within the width', async () => {
	const render = await chatGallerySection.load();
	for (const width of [39, 79, 159]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			const rows = withColorDepth(depth, () => render({width, depth, ascii: false}));
			assert.ok(rows.length > 15);
			for (const row of rows) assert.ok(styledCells(row) <= width, `${width} ${depth}: ${stripStyles(row)}`);
		}
	}
});

test('the rows hold only SGR escapes and the sample pieces', async () => {
	const render = await chatGallerySection.load();
	const rows = withColorDepth('256', () => render({width: 79, depth: '256', ascii: false}));
	const rest = rows.join('\n').replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
	assert.ok(!rest.includes(ESC));
	for (const part of ['Fix the failing test', 'Thinking', 'Edit(', 'Bash(', 'Patching parse()', 'Error: ']) assert.ok(rest.includes(part), part);
});

test('registering the section is accepted once', () => {
	assert.equal(registerGallerySection(chatGallerySection), true);
	assert.equal(registerGallerySection(chatGallerySection), false);
	assert.ok(gallerySections().some(s => s.name === 'chat'));
});
