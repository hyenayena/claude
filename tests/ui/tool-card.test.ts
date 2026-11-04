import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {makeScrub} from '../../src/chat/scrub.js';
import {stringCells, stripStyles, styledCells, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {resetHighlighterForTests, preloadHighlighter} from '../../src/ui/highlight.js';
import {bashExit, errorReason, foldSummary, formatToolCard, formatToolGroup, runningToolRow, type ToolLike} from '../../src/ui/tool-card.js';
import {SGR} from '../helpers/sgr16.js';

const id = (s: string): string => s;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const plain = (t: ToolLike, width = 80): string => stripStyles(formatToolCard(t, id, width));
const at16 = (t: ToolLike, width = 80): string => withColorDepth('16', () => formatToolCard(t, id, width));

const read = (path: string, extra: Partial<ToolLike> = {}): ToolLike => ({name: 'Read', input: {file_path: path}, isError: false, text: '1\ta\n2\tb', ...extra});
const grep = (pattern: string, extra: Partial<ToolLike> = {}): ToolLike => ({name: 'Grep', input: {pattern}, isError: false, text: 'a.ts\nb.ts', ...extra});

afterEach(() => resetHighlighterForTests());

test('every kind of call fits the width at 40, 80 and 120 columns', () => {
	const calls: ToolLike[] = [
		read('/very/long/path/to/some/deep/directory/file-with-a-long-name.ts', {durationMs: 2500}),
		grep('some long pattern with spaces', {durationMs: 1200}),
		{name: 'Glob', input: {pattern: 'src/**/*.ts'}, isError: false, text: 'a\nb'},
		{name: 'Bash', input: {command: `npm test -- --reporter=spec ${'x'.repeat(200)}\nsecond`}, isError: false, text: 'line\n'.repeat(30), durationMs: 70_000},
		{name: 'Bash', input: {command: 'npm test'}, isError: true, text: `Exit code 2\n${'fail '.repeat(60)}`, durationMs: 3000},
		{name: 'Edit', input: {file_path: '/a.ts'}, isError: true, text: '<tool_use_error>String to replace not found in file.</tool_use_error>'},
		{name: 'WebFetch', input: {url: `https://example.com/${'p'.repeat(100)}`}, isError: false, text: 'page'},
		{name: 'Agent', input: {subagent_type: 'coder', description: 'Fix'}, isError: false, text: 'done', durationMs: 3_800_000},
		{name: 'mcp__gh__search_issues', input: {query: 'q'}, isError: false, text: 'r'},
		{name: 'TodoWrite', input: {todos: [{content: 'a', status: 'completed'}]}, isError: false, text: ''},
		{name: 'Bash', input: {command: 'rm x'}, isError: true, text: "The user doesn't want to proceed with this tool use."},
	];
	for (const width of [40, 80, 120]) {
		for (const call of calls) {
			for (const row of formatToolCard(call, id, width).split('\n')) assert.ok(styledCells(row) <= width, `${width} ${call.name}: ${stripStyles(row)}`);
		}
	}
});

test('the duration shows from one second on, right-aligned and muted', () => {
	assert.ok(!/\ds$/.test(plain(read('/a.ts', {durationMs: 999}))));
	const row = plain(read('/a.ts', {durationMs: 1000}), 60);
	assert.ok(row.endsWith('  1.0s'), row);
	assert.equal(stringCells(row), 60);
	assert.ok(at16(read('/a.ts', {durationMs: 1000}), 60).includes(`${SGR.dim}1.0s`));
});

test('single-line results move into the header as a muted summary', () => {
	assert.equal(plain(read('/a.ts')), '✓ ▤ Read /a.ts  · 2 lines');
	assert.equal(plain({name: 'Glob', input: {pattern: '*.ts'}, isError: false, text: '/a.ts\n/b.ts'}), '✓ ⌕ Glob *.ts  · 2 files');
	assert.equal(plain(grep('x')), '✓ ⌕ Grep x  · 2 files');
	assert.equal(plain(grep('x', {text: 'No matches found'})), '✓ ⌕ Grep x  · no matches');
	assert.equal(plain({name: 'AskUserQuestion', input: {questions: [{question: 'Which?'}]}, isError: false, text: 'secret'}), '✓ ◦ AskUserQuestion Which?  · answered');
});

test('other results hang under the header, five rows with the head kept', () => {
	const rows = plain({name: 'WebFetch', input: {url: 'u'}, isError: false, text: 'a\nb\nc\nd\ne\nf\ng'}).split('\n');
	assert.equal(rows.length, 6);
	assert.equal(rows[1], '  ⎿  a');
	assert.equal(rows[5], '     … +3 lines (ctrl+o to expand)');
});

test('errors: a red reason row from the first useful line', () => {
	const call: ToolLike = {name: 'Edit', input: {file_path: '/a.ts'}, isError: true, text: '<tool_use_error>String to replace not found in file.\nmore</tool_use_error>'};
	assert.deepEqual(plain(call).split('\n'), ['✗ ✎ Edit /a.ts', '  ⎿  String to replace not found in file.']);
	const raw = at16(call);
	assert.ok(raw.startsWith(`${SGR.red}✗${SGR.reset}`));
	assert.ok(raw.includes(`${SGR.red}  ⎿  String`));
	assert.equal(errorReason('Error: boom   here\nsecond'), 'boom here');
	assert.equal(errorReason('\n  \n'), 'failed');
	assert.equal(errorReason('<tool_use_error></tool_use_error>'), 'failed');
	assert.equal(plain({name: 'Read', input: {file_path: '/a'}, isError: true, text: ''}).split('\n')[1], '  ⎿  failed');
});

test('refusals are muted, one row, with the reason in the header', () => {
	const deny = (text: string): ToolLike => ({name: 'Bash', input: {command: 'rm x'}, isError: true, text});
	assert.equal(plain(deny("The user doesn't want to proceed with this tool use.")), '✗ $ rm x  · denied');
	const raw = at16(deny("The user doesn't want to proceed with this tool use."));
	assert.ok(raw.startsWith(`${SGR.dim}✗${SGR.reset}`), JSON.stringify(raw));
	assert.ok(!raw.includes(SGR.red));
});

test('bashExit reads only a first line "Exit code N"', () => {
	assert.deepEqual(bashExit('Exit code 1\nout'), {code: 1, rest: 'out'});
	assert.deepEqual(bashExit('Exit code 127'), {code: 127, rest: ''});
	assert.deepEqual(bashExit('out\nExit code 1\n'), {rest: 'out\nExit code 1\n'});
	assert.deepEqual(bashExit('Exit code x\n'), {rest: 'Exit code x\n'});
});

test('Bash: header without the name, exit only when non-zero, the output tail in a box', () => {
	const ok = plain({name: 'Bash', input: {command: 'ls src'}, isError: false, text: 'a\nb', durationMs: 1800}, 40).split('\n');
	assert.equal(ok[0], `✓ $ ls src${' '.repeat(40 - 10 - 4)}1.8s`);
	assert.deepEqual(ok.slice(1), ['  │ a', '  │ b']);
	const lines = Array.from({length: 12}, (_, i) => `l${i + 1}`).join('\n');
	const tail = plain({name: 'Bash', input: {command: 'seq 12'}, isError: false, text: lines}).split('\n');
	assert.equal(tail.length, 1 + 5);
	assert.equal(tail[1], '  │ … +8 earlier lines (ctrl+o to expand)');
	assert.equal(tail.at(-1), '  │ l12');
	const failed = plain({name: 'Bash', input: {command: 'npm test'}, isError: true, text: 'Exit code 1\nnot ok 1\n', durationMs: 12_000}).split('\n');
	assert.match(failed[0]!, /^✗ \$ npm test +exit 1 · 12s$/);
	assert.deepEqual(failed.slice(1), ['  │ not ok 1']);
	assert.ok(at16({name: 'Bash', input: {command: 'x'}, isError: true, text: 'Exit code 3\nno'}).includes(`${SGR.red}exit 3`));
});

test('Bash: empty output has no box; an error without a code gets a reason row', () => {
	assert.deepEqual(plain({name: 'Bash', input: {command: 'true'}, isError: false, text: ''}).split('\n'), ['✓ $ true']);
	assert.deepEqual(plain({name: 'Bash', input: {command: 'x'}, isError: true, text: 'Command timed out'}).split('\n'), ['✗ $ x', '  ⎿  Command timed out']);
	const multi = plain({name: 'Bash', input: {command: 'x'}, isError: true, text: 'spawn failed\ndetails here'}).split('\n');
	assert.deepEqual(multi, ['✗ $ x', '  ⎿  spawn failed', '  │ spawn failed', '  │ details here']);
});

test('Bash: a multi-line command shows its first line and +N lines; background is marked', () => {
	const row = plain({name: 'Bash', input: {command: '\ncd app\nnpm run build\nnpm run lint\n'}, isError: false, text: ''}).split('\n')[0]!;
	assert.equal(row, '✓ $ cd app  +2 lines');
	const bg = plain({name: 'Bash', input: {command: 'sleep 9', run_in_background: true}, isError: false, text: 'started'}, 60).split('\n')[0]!;
	assert.match(bg, /^✓ \$ sleep 9 +in background$/);
});

test('Bash highlights the command once the highlighter is ready and stays plain before', async () => {
	const call: ToolLike = {name: 'Bash', input: {command: 'echo "hi" # c'}, isError: false, text: ''};
	const before = withColorDepth('truecolor', () => formatToolCard(call, id, 80));
	assert.equal(stripStyles(before), '✓ $ echo "hi" # c');
	assert.ok(!before.includes('38;2;198;120;221'));
	assert.equal(await preloadHighlighter(), true);
	const after = withColorDepth('truecolor', () => formatToolCard(call, id, 80));
	assert.equal(stripStyles(after), '✓ $ echo "hi" # c');
	assert.notEqual(after, before);
	assert.ok(withColorDepth('16', () => formatToolCard(call, id, 80)).split(ESC).every(p => !p.startsWith('[38;')), 'no syntax colours at depth 16');
});

test('depth none has no colour parameters', () => {
	const raw = withColorDepth('none', () => formatToolCard({name: 'Bash', input: {command: 'x'}, isError: true, text: 'Exit code 1\nno', durationMs: 5000}, id, 60));
	assert.ok(!new RegExp(`${ESC}\\[(?:3|4|9)\\d`).test(raw), JSON.stringify(raw));
});

test('foldSummary counts distinct paths and patterns, in order of first appearance', () => {
	const items = [read('/a.ts'), read('/b.ts'), read('/a.ts'), grep('TODO'), grep('TODO'), grep('x'), {name: 'Glob', input: {pattern: '*.ts'}, isError: false, text: ''}, {name: 'LS', input: {path: '/src'}, isError: false, text: ''}] as ToolLike[];
	const s = foldSummary(items);
	assert.equal(s.title, 'Read 2 files, searched 2 patterns, matched 1 glob, listed 1 dir');
	assert.deepEqual(s.names, ['a.ts', 'b.ts', '"TODO"', '"x"', '*.ts', 'src']);
	assert.equal(s.glyph, 'toolRead');
	const first = foldSummary([grep('a'), read('/x')]);
	assert.equal(first.title, 'Searched 1 pattern, read 1 file'.replace('read', 'Read'));
	assert.equal(foldSummary([grep('a'), {name: 'Glob', input: {pattern: 'p'}, isError: false, text: ''}] as ToolLike[]).glyph, 'toolSearch');
});

test('a fold prints as one row; names are cut to fit; the duration is the wall span', () => {
	const items = [read('/a.ts', {startedAt: 1000, durationMs: 300}), read('/b.ts', {startedAt: 1400, durationMs: 1500}), grep('TODO', {startedAt: 1500, durationMs: 200})];
	const wide = stripStyles(formatToolGroup(items, id, 80));
	assert.match(wide, /^✓ ▤ Read 2 files, searched 1 pattern {2}a\.ts, b\.ts, "TODO" +1\.9s$/);
	assert.equal(stringCells(wide), 80);
	const narrow = stripStyles(formatToolGroup(items, id, 60));
	assert.ok(stringCells(narrow) <= 60 && narrow.includes('…'), narrow);
	for (const w of [10, 20, 30, 40]) assert.ok(styledCells(formatToolGroup(items, id, w)) <= w, String(w));
	assert.ok(!/\ds$/.test(stripStyles(formatToolGroup([read('/a'), read('/b')], id, 80))), 'no duration without timestamps');
	assert.equal(stripStyles(formatToolGroup([read('/a.ts')], id, 80)), '✓ ▤ Read /a.ts  · 2 lines');
});

test('running rows: the frame, the family glyph, activity and the elapsed time', () => {
	const tool = {id: 't', name: 'Agent', input: {subagent_type: 'coder', description: 'Fix'}, elapsedSeconds: 0, startedAt: 10_000, activity: {name: 'Read', input: {file_path: '/a.ts'}}};
	assert.equal(stripStyles(runningToolRow(tool, id, 80, '⠋', 10_500)), '⠋ ✦ Agent coder: Fix  → Read /a.ts');
	assert.match(stripStyles(runningToolRow(tool, id, 60, '⠋', 24_000)), /14s$/);
	assert.match(stripStyles(runningToolRow({id: 't', name: 'Bash', input: {command: 'sleep 5'}, elapsedSeconds: 3}, id, 60, '⠙', 0)), /^⠙ \$ sleep 5 +3\.0s$/);
	for (const w of [8, 20, 40]) assert.ok(styledCells(runningToolRow(tool, id, w, '⠋', 99_000)) <= w);
});

test('hostile text in the command, output, path and tool name never reaches the output', () => {
	const evil = `x${ESC}]52;c;ZXZpbA==${BEL}y${ESC}[31mred${ESC}[0m`;
	const scrub = makeScrub(s => s);
	const calls: ToolLike[] = [
		{name: 'Bash', input: {command: evil}, isError: false, text: evil},
		{name: 'Bash', input: {command: 'x'}, isError: true, text: `Exit code 1\n${evil}`},
		read(evil, {text: evil}),
		{name: `mcp__${evil}__tool`, input: {a: evil}, isError: true, text: evil},
		{name: 'Edit', input: {file_path: evil}, isError: true, text: evil},
	];
	for (const depth of ['truecolor', '16', 'none'] as ColorDepth[]) {
		for (const call of calls) {
			const out = withColorDepth(depth, () => formatToolCard(call, scrub, 60)) + withColorDepth(depth, () => formatToolGroup([call, read(evil)], scrub, 60));
			assert.ok(!out.includes(`${ESC}]`) && !out.includes(BEL) && !out.includes('ZXZpbA==\u0007'), JSON.stringify(out));
			assert.ok(!/\u001b\[31mred/.test(out), JSON.stringify(out));
		}
	}
});
