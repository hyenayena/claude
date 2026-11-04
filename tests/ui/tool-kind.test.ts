import assert from 'node:assert/strict';
import {test} from 'node:test';
import {GLYPHS} from '../../src/kit.js';
import {FAMILY_GLYPH, FOLDABLE_TOOLS, isFoldable, mcpParts, toolFamily, type ToolFamily} from '../../src/ui/tool-kind.js';
import {displayName} from '../../src/ui/tool-args.js';

test('every tool family has its glyph', () => {
	const families: ToolFamily[] = ['read', 'search', 'edit', 'shell', 'web', 'agent', 'task', 'other'];
	assert.deepEqual(Object.keys(FAMILY_GLYPH).sort(), [...families].sort());
	for (const f of families) assert.ok(FAMILY_GLYPH[f] in GLYPHS, f);
});

test('built-in tools map to their family', () => {
	const table: Record<string, ToolFamily> = {
		Read: 'read',
		NotebookRead: 'read',
		LS: 'read',
		Grep: 'search',
		Glob: 'search',
		ToolSearch: 'search',
		Edit: 'edit',
		Write: 'edit',
		MultiEdit: 'edit',
		NotebookEdit: 'edit',
		Bash: 'shell',
		BashOutput: 'shell',
		KillShell: 'shell',
		Monitor: 'shell',
		WebFetch: 'web',
		WebSearch: 'web',
		Agent: 'agent',
		Task: 'agent',
		SendMessage: 'agent',
		TodoWrite: 'task',
		TaskCreate: 'task',
		TaskStop: 'task',
		ExitPlanMode: 'task',
		AskUserQuestion: 'other',
		Unknown: 'other',
	};
	for (const [name, family] of Object.entries(table)) assert.equal(toolFamily(name), family, name);
	assert.equal(toolFamily('toString'), 'other', 'inherited object keys are not tools');
});

test('yena console tools: list is read, run is shell', () => {
	assert.equal(toolFamily('mcp__yena__list_commands'), 'read');
	assert.equal(toolFamily('mcp__yena__run_command'), 'shell');
});

test('other MCP tools are classified by the tool word and shown as server:tool', () => {
	const table: Record<string, ToolFamily> = {
		mcp__gh__search_issues: 'search',
		mcp__gh__find_user: 'search',
		mcp__web__fetch_page: 'web',
		mcp__gh__get_issue: 'read',
		mcp__fs__list_dir: 'read',
		mcp__db__create_row: 'edit',
		mcp__db__delete_row: 'edit',
		mcp__x__dance: 'other',
	};
	for (const [name, family] of Object.entries(table)) assert.equal(toolFamily(name), family, name);
	assert.deepEqual(mcpParts('mcp__gh__search_issues'), {server: 'gh', tool: 'search_issues'});
	assert.equal(mcpParts('Bash'), undefined);
	assert.equal(displayName('mcp__gh__get_issue'), 'gh:get_issue');
	assert.equal(displayName('mcp__yena__run_command'), 'Yena');
});

test('only Read, Grep, Glob and LS fold', () => {
	assert.deepEqual([...FOLDABLE_TOOLS], ['Read', 'Grep', 'Glob', 'LS']);
	assert.ok(isFoldable('Read') && isFoldable('LS'));
	assert.ok(!isFoldable('Bash') && !isFoldable('Edit') && !isFoldable('mcp__gh__get_issue'));
});
