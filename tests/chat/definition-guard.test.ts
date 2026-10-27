import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {addsPrivilegedFrontmatter, isDefinitionPath, privilegedEntries} from '../../src/chat/definition-guard.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-defguard-')));
after(() => rmSync(tmp, {recursive: true, force: true}));

test('privilegedEntries picks the privileged keys with their continuation lines', () => {
	const text = [
		'---',
		'name: x',
		'allowed-tools: Bash(git:*) Read',
		'hooks:',
		'  PreToolUse:',
		'    - command: sh evil.sh',
		'tools: Read, Bash',
		'---',
		'permissionMode: auto',
	].join('\n');
	assert.deepEqual(privilegedEntries(text), [
		'allowed-tools: Bash(git:*) Read',
		'hooks:\n  PreToolUse:\n    - command: sh evil.sh',
	]);
});

test('privilegedEntries matches near spellings and ignores files without frontmatter', () => {
	assert.equal(privilegedEntries('---\r\nPermission_Mode: acceptEdits\r\n---\r\n').length, 1);
	assert.equal(privilegedEntries(String.fromCharCode(0xfeff) + '---\n"mcpServers":\n- {}\n---\n').length, 1);
	assert.equal(privilegedEntries('---\nallowedTools: Bash\n').length, 1);
	assert.deepEqual(privilegedEntries('# Title\nallowed-tools: Bash\n'), []);
	assert.deepEqual(privilegedEntries('---\nname: a\ndescription: hooks: none\n---\n'), []);
});

test('isDefinitionPath covers the hub definition dirs and any .claude dir', () => {
	const hub = '/data/md';
	assert.ok(isDefinitionPath('/data/md/skills/x/SKILL.md', [hub]));
	assert.ok(isDefinitionPath('/data/md/agents/a.md', [hub]));
	assert.ok(isDefinitionPath('/data/md/commands/c.md', [hub]));
	assert.ok(isDefinitionPath('/app/src/.claude/skills/x/SKILL.md', [hub]));
	assert.ok(!isDefinitionPath('/data/md/notes.md', [hub]));
	assert.ok(!isDefinitionPath('/data/md/projects/yena/tasks/t.md', [hub]));
	assert.ok(!isDefinitionPath('/data/mdx/skills/x.md', [hub]));
});

test('addsPrivilegedFrontmatter: Write of a new file with a privileged key', async () => {
	const file = path.join(tmp, 'new.md');
	assert.ok(await addsPrivilegedFrontmatter(file, 'Write', {content: '---\nname: a\nallowed-tools: Bash\n---\n'}));
	assert.ok(!(await addsPrivilegedFrontmatter(file, 'Write', {content: '---\nname: a\ntools: Read\n---\n'})));
});

test('addsPrivilegedFrontmatter: Edit adding, changing, keeping and removing', async () => {
	const file = path.join(tmp, 'agent.md');
	writeFileSync(file, '---\nname: a\npermissionMode: default\n---\nBody text\n');
	const edit = (old_string: string, new_string: string, replace_all = false) =>
		addsPrivilegedFrontmatter(file, 'Edit', {old_string, new_string, replace_all});
	assert.ok(await edit('name: a', 'name: a\nhooks:\n  Stop: []'));
	assert.ok(await edit('permissionMode: default', 'permissionMode: auto'));
	assert.ok(!(await edit('Body text', 'Other text')));
	assert.ok(!(await edit('permissionMode: default\n', '')));
	assert.ok(!(await edit('missing', 'allowed-tools: Bash')));
	assert.ok(await edit('a', 'a\nmcpServers: x', true));
});

test('addsPrivilegedFrontmatter: Edit creating a file from an empty old_string', async () => {
	const file = path.join(tmp, 'skills', 'new', 'SKILL.md');
	mkdirSync(path.dirname(file), {recursive: true});
	assert.ok(await addsPrivilegedFrontmatter(file, 'Edit', {old_string: '', new_string: '---\nallowed-tools: Bash\n---\n'}));
});
