import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {readSessionTitle, titleFromPrompt, transcriptFile} from '../../src/chat/title.js';

test('transcriptFile follows the Claude Code project folder naming', () => {
	assert.equal(transcriptFile('/data/claude/config', '/app', 'abc'), '/data/claude/config/projects/-app/abc.jsonl');
	assert.equal(transcriptFile('/c', '/home/me/my.proj', 's'), '/c/projects/-home-me-my-proj/s.jsonl');
});

test('readSessionTitle prefers a custom title, then the last generated one', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-title-'));
	const file = join(dir, 's.jsonl');
	assert.equal(await readSessionTitle(file), undefined);
	const lines = [
		{type: 'user', message: {content: 'hi "-title" in text'}},
		{type: 'ai-title', aiTitle: 'First guess'},
		'not json -title"',
		{type: 'ai-title', aiTitle: 'Better title'},
	];
	await writeFile(file, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
	assert.equal(await readSessionTitle(file), 'Better title');
	await writeFile(file, [...lines, {type: 'custom-title', customTitle: 'Mine'}].map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
	assert.equal(await readSessionTitle(file), 'Mine');
	await writeFile(file, JSON.stringify({type: 'ai-title', aiTitle: 'x'.repeat(300)}));
	assert.equal((await readSessionTitle(file))!.length, 120);
});

test('titleFromPrompt takes the first line, shortened', () => {
	assert.equal(titleFromPrompt('  fix the build\nplease '), 'fix the build');
	assert.equal(titleFromPrompt('a'.repeat(100)).length, 60);
	assert.equal(titleFromPrompt('   '), '');
});
