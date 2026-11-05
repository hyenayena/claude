import {SGR} from '../helpers/sgr16.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chatStatusRow} from '../../src/ui/status-bar.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {stringCells, stripStyles, styledCells, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {
	assistantPrint,
	formatThinking,
	formatAssistantBlock,
	formatError,
	formatNotice,
	formatOut,
	formatToolBlock,
	formatUserLine,
	formatAudit,
	formatModeLine,
	liveTail,
	statusLineText,
	tasksBarText,
	modeHint,
	verbFor,
	pickWorkingVerb,
	WORKING_VERBS,
	shortModel,
	toolOneLiner,
} from '../../src/ui/present.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const scrub = makeScrub(s => s.split(SECRET).join('[redacted]'));
const ESC = '\u001b';
const dirty = `x${ESC}]52;c;ZXZpbA==\u0007y ${SECRET} ${ESC}[31mred${ESC}[0m ‮`;

const allowed = Object.values(SGR);
function onlyConstantEscapes(s: string): boolean {
	let rest = s;
	for (const code of allowed) rest = rest.split(code).join('');
	return !rest.includes(ESC) && !rest.includes('\u0007') && !rest.includes('‮');
}

test('every field type is scrubbed and only constants add SGR', () => {
	const outputs = [
		formatUserLine(dirty, scrub),
		formatAssistantBlock(dirty, scrub),
		formatAssistantBlock(dirty, scrub, true),
		formatToolBlock({name: `Bash${dirty}`, input: {command: dirty}, isError: false, text: dirty}, scrub),
		formatToolBlock({name: 'Read', input: {file_path: dirty}, isError: true, text: dirty}, scrub),
		formatToolBlock({name: 'Other', input: {[dirty]: 1}, isError: false, text: dirty}, scrub),
		formatError(dirty, scrub),
		formatNotice(dirty, scrub),
		formatOut({kind: 'outcome', outcome: 'error', error: dirty}, scrub),
		formatOut({kind: 'api-error', code: dirty}, scrub),
		...liveTail(dirty, scrub, 10, 80),
		chatStatusRow({phase: 'idle', status: null, awaiting: false, elapsedMs: 0, quietMs: 0, verb: 'Sniffing', model: dirty, account: dirty, limit: dirty, project: dirty, branch: dirty, scrub}, 200, {frame: '*'}),
	];
	for (const o of outputs) {
		assert.ok(!o.includes(SECRET), o);
		assert.ok(onlyConstantEscapes(o), JSON.stringify(o));
	}
});

test('escape split across deltas is caught because the tail scrubs the whole', () => {
	const tail = liveTail(`ab${ESC}[3`.concat('1mcd'), scrub, 5, 80).join('\n');
	assert.equal(tail, '● abcd');
});

test('liveTail returns at most the requested rows', () => {
	const tail = liveTail('line\n'.repeat(100), scrub, 7, 40);
	assert.equal(tail.length, 7);
	assert.deepEqual(liveTail('', scrub, 7, 40), []);
	assert.deepEqual(liveTail('text', scrub, 0, 40), []);
});

const plain = (s: string) => s.replace(/\u001b\[[\d;]*m/g, '');

test('liveTail renders Markdown while it streams, like the finished block', () => {
	const raw = '# Title\n\nSome **bold** text\n- item\n```ts\nconst x = 1;';
	const tail = liveTail(raw, scrub, 30, 80);
	assert.ok(tail.join('\n').includes(`${SGR.bold}bold`));
	assert.deepEqual(tail.map(plain), ['● Title', '', '  Some bold text', '  • item', `  ╭─ ts ${'─'.repeat(77 - 7)}╮`, '  │ const x = 1;']);
	assert.deepEqual(tail.map(plain).slice(0, 4), formatAssistantBlock(raw, scrub, false, 79).split('\n').map(plain).slice(0, 4));
});

test('liveTail keeps rows off the last column', () => {
	const tail = liveTail('word '.repeat(200), scrub, 30, 41);
	assert.ok(tail.length > 1);
	for (const row of tail) assert.ok(plain(row).length <= 40, row);
});

test('liveTail keeps framing code whose fence opened before the window', () => {
	const raw = `intro\n\`\`\`py\n${'x = 1\n'.repeat(4000)}tail_line`;
	const tail = liveTail(raw, scrub, 3, 80).map(plain);
	assert.deepEqual(tail, ['  │ x = 1', '  │ x = 1', '  │ tail_line']);
	assert.ok(!liveTail(raw, scrub, 200, 80).some(r => r.startsWith('●')));
});

test('tool block keeps at most five result rows, the footer included', () => {
	const plainBlock = (text: string, width?: number) =>
		stripStyles(formatToolBlock({name: 'WebFetch', input: {url: 'u'}, isError: false, text}, scrub, width));
	assert.equal(plainBlock('1\n2\n3\n4\n5'), ['✓ ⊕ WebFetch u', '  ⎿  1', '     2', '     3', '     4', '     5'].join('\n'));
	assert.equal(plainBlock('1\n2\n3\n4\n5\n6\n7\n'), ['✓ ⊕ WebFetch u', '  ⎿  1', '     2', '     3', '     4', '     … +3 lines (ctrl+o to expand)'].join('\n'));
});

test('tool block rows are counted as the chat shows them, not as source lines', () => {
	const width = 40;
	const block = stripStyles(formatToolBlock({name: 'WebFetch', input: {url: 'u'}, isError: false, text: `${'y'.repeat(200)}\nz`}, scrub, width));
	const rows = block.split('\n');
	assert.equal(rows.length, 1 + 5);
	assert.match(rows.at(-1)!, /… \+3 lines \(ctrl\+o to expand\)$/);
	for (const row of rows) assert.ok(row.length <= width, row);
});

test('an audit line fits one row by losing its middle, so the resolved target stays', () => {
	const summary = '/workplace/project/some/deep/link/file.txt -> /workplace/project/real/target/file.txt';
	const full = formatAudit({outcome: 'allowed', toolName: 'Write', summary}, scrub).replace(/\u001b\[\d+m/g, '');
	assert.equal(full, `Allowed Write: ${summary}`);
	const cut = formatAudit({outcome: 'allowed', toolName: 'Write', summary}, scrub, scrub, 50).replace(/\u001b\[\d+m/g, '');
	assert.equal(cut.length, 50);
	assert.match(cut, /^Allowed Write: \/workplace.*….*real\/target\/file\.txt$/);
});

test('tool block puts the call on one row however long or multi-line the command is', () => {
	const command = `cd /workplace/yena && ${'echo long; '.repeat(30)}\ncat <<'EOF'\nbody\nEOF`;
	const width = 60;
	const block = stripStyles(formatToolBlock({name: 'Bash', input: {command}, isError: false, text: 'ok'}, scrub, width));
	const [header, ...rest] = block.split('\n');
	assert.ok(stringCells(header!) <= width, header);
	assert.match(header!, /^✓ \$ cd \/workplace\/yena && echo long;.*…$/);
	assert.deepEqual(rest, ['  │ ok']);
});

test('tool rows: a status mark, a family glyph, the bold name and plain arguments', () => {
	const ok = withColorDepth('16', () => formatToolBlock({name: 'WebFetch', input: {url: 'u'}, isError: false, text: 'x'}, scrub));
	const failed = withColorDepth('16', () => formatToolBlock({name: 'WebFetch', input: {url: 'u'}, isError: true, text: 'boom'}, scrub));
	assert.ok(ok.startsWith(`${SGR.green}✓${SGR.reset} `), JSON.stringify(ok));
	assert.ok(ok.includes(`${SGR.bold}WebFetch${SGR.boldOff} u`));
	assert.ok(failed.startsWith(`${SGR.red}✗${SGR.reset} `), JSON.stringify(failed));
	assert.match(stripStyles(failed), /\n {2}⎿ {2}boom$/);
	assert.equal(stripStyles(formatToolBlock({name: 'Read', input: {file_path: '/a'}, isError: true, text: ''}, scrub)).split('\n')[1], '  ⎿  failed');
});

test('assistant blocks start with a dot and hang under it', () => {
	const strip = (s: string) => s.replace(/\u001b\[\d+m/g, '');
	assert.equal(strip(formatAssistantBlock('one\n\ntwo\nthree', scrub)), '● one\n\n  two\n  three');
	assert.equal(strip(formatAssistantBlock('cut', scrub, true)), '● cut\n  (interrupted)');
	for (const line of strip(formatAssistantBlock('word '.repeat(40), scrub, false, 30)).split('\n')) assert.ok(line.length <= 30, line);
});

test('working verbs and the mode hint', () => {
	assert.equal(pickWorkingVerb(() => 0), WORKING_VERBS[0]);
	assert.equal(pickWorkingVerb(() => 0.9999), WORKING_VERBS[WORKING_VERBS.length - 1]);
	assert.equal(pickWorkingVerb(() => 0, WORKING_VERBS[0]), WORKING_VERBS[1]);
	assert.equal(verbFor('box-1', 3), verbFor('box-1', 3));
	assert.ok((WORKING_VERBS as readonly string[]).includes(verbFor('box-1', 3)));
	assert.equal(modeHint('default'), '');
	assert.equal(modeHint('acceptEdits'), '⏵⏵ accept edits on (shift+tab to cycle)');
	assert.equal(modeHint('plan'), '⏸ plan mode on (shift+tab to cycle)');
});

test('status line texts', () => {
	assert.equal(statusLineText({kind: 'retry', attempt: 2, maxRetries: 5, delayMs: 3000}), 'Retrying (2/5) in 3s…');
	assert.equal(statusLineText({kind: 'thinking'}), 'Thinking…');
	assert.equal(statusLineText(null), '');
});

test('formatAudit produces one dim line per decision, clamped and scrubbed', () => {
	const strip = (s: string) => s.replace(/\u001b\[\d+m/g, '');
	const line = (outcome: Parameters<typeof formatAudit>[0]['outcome'], toolName: string, summary: string) =>
		strip(formatAudit({outcome, toolName, summary}, scrub));
	assert.equal(line('allowed', 'Bash', 'ls -la'), 'Allowed Bash: ls -la');
	assert.equal(line('denied', 'Edit', '/app/a.ts'), 'Denied Edit: /app/a.ts');
	assert.equal(line('always-allowed', 'Bash', 'npm test'), 'Always-allowed Bash(npm test) for this chat');
	assert.equal(line('auto-accepted', 'Edit', '/app/a.ts (+2 -1)'), 'Auto-accepted Edit: /app/a.ts (+2 -1)');
	assert.equal(line('cancelled', 'Bash', 'ls'), 'Cancelled Bash: the turn was interrupted');
	assert.equal(line('answered', 'AskUserQuestion', '2 question(s)'), 'Answered 2 questions');
	assert.equal(line('denied-by-policy', 'Write', '/etc/x'), 'Blocked Write: /etc/x');
	assert.equal(strip(formatModeLine('acceptEdits')), 'Mode: auto-accept edits (this chat only)');

	const long = line('allowed', 'Bash', `${'x'.repeat(300)}`);
	assert.equal(long, `Allowed Bash: ${'x'.repeat(300)}`);
	const dirtyLine = formatAudit({outcome: 'allowed', toolName: 'Bash', summary: `a${ESC}]0;x\u0007 ${SECRET}\nsecond`}, scrub);
	assert.ok(onlyConstantEscapes(dirtyLine), JSON.stringify(dirtyLine));
	assert.ok(!dirtyLine.includes(SECRET));
	assert.ok(!dirtyLine.includes('second'));
});

test('tool results: Edit and Write summarise, refusals show denied, Bash keeps the clamp', () => {
	const strip = (s: string) => s.replace(/\u001b\[\d+m/g, '');
	const block = (name: string, input: unknown, isError: boolean, text: string) =>
		strip(formatToolBlock({name, input, isError, text}, scrub));
	assert.match(block('Edit', {file_path: '/app/a.ts', old_string: 'a', new_string: 'b\nc'}, false, 'The file has been updated'), /^✓ ✎ Edit {2}▫? ?.*\/app\/a\.ts {2}\+2 −1/m);
	assert.match(block('Write', {file_path: '/app/b.ts', content: 'x\ny\n'}, false, 'File created'), /^✓ ✎ Write {2}◇ \/app\/b\.ts {2}\+2 −0 {2}new file$/m);
	assert.match(block('Read', {file_path: '/app/b.ts'}, false, '1\tx\n2\ty\n'), /^✓ ▤ Read \/app\/b\.ts {2}· 2 lines$/);
	assert.match(block('Glob', {pattern: '*.ts'}, false, '/a.ts\n/b.ts'), /· 2 files$/);
	assert.match(block('Glob', {pattern: '*.ts'}, false, 'No files found'), /· 0 files$/);
	assert.match(block('Bash', {command: 'x'}, true, "The user doesn't want to proceed with this tool use."), /^✗ \$ x {2}· denied$/);
	assert.match(block('Edit', {file_path: '/app/a.ts'}, true, 'The user denied this tool call. Do not retry'), /· denied$/);
	assert.match(block('Bash', {command: 'x'}, false, 'a\nb\nc\nd\ne\nf\ng'), /│ … \+3 earlier lines \(ctrl\+o to expand\)/);
	assert.match(block('AskUserQuestion', {questions: [{question: 'Which?'}, {}]}, false, 'User answered: secret-answer'), /AskUserQuestion Which\? \(\+1 more\)  · answered/);
	assert.ok(!block('AskUserQuestion', {questions: [{question: 'Which?'}]}, false, 'secret-answer').includes('secret-answer'));
});

test('audit summaries use the reveal function so they match what was approved', () => {
	const show = (s: string) => s.replaceAll(ESC, '<ESC>');
	const line = formatAudit({outcome: 'allowed', toolName: 'Bash', summary: `echo ${ESC}[31m`}, scrub, show);
	assert.ok(line.includes('echo <ESC>[31m'));
	assert.ok(!line.includes(`${ESC}[31m`));
});

test('limit and context outcomes print a yellow notice, not an error', () => {
	const limit = formatOut({kind: 'outcome', outcome: 'limit', error: 'You hit your 5-hour limit'}, scrub);
	assert.match(limit, /You hit your 5-hour limit/);
	assert.ok(limit.includes('\u001b[33m'));
	assert.doesNotMatch(limit, /Error:/);
	const context = formatOut({kind: 'outcome', outcome: 'context', error: undefined}, scrub);
	assert.match(context, /context window/);
	assert.doesNotMatch(context, /Error:/);
	assert.ok(!formatOut({kind: 'outcome', outcome: 'limit', error: `a${SECRET}`}, scrub).includes(SECRET));
});

test('account notices name the reason: another account, or the pinned one', () => {
	const plain = (t: string) => t.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
	const changed = formatOut({kind: 'account', account: 'spare', previous: 'work', reason: 'changed'}, scrub);
	assert.equal(plain(changed), 'Now on account "spare" instead of "work".');
	const pinned = formatOut({kind: 'account', account: 'spare', previous: 'work', reason: 'pinned'}, scrub);
	assert.equal(plain(pinned), 'Now on account "spare" (chosen with "claude auth use").');
});

const TABLE = '| name | description | notes |\n| --- | --- | --- |\n| alpha | a rather long description of alpha | first |\n| beta | another long description for beta | second |';
const plainCells = (s: string) => [...s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')].length;

test('formatOut lays assistant tables out to the given width', () => {
	const out = formatOut({kind: 'assistant', text: TABLE, interrupted: false}, scrub, scrub, 40);
	for (const line of out.split('\n')) assert.ok(plainCells(line) <= 40, line);
});

test('the status bar counts running agents and background work', () => {
	assert.equal(tasksBarText([]), '');
	assert.equal(tasksBarText([{status: 'running', background: false, taskType: 'local_agent'}]), '1 agent');
	assert.equal(
		tasksBarText([
			{status: 'running', background: false, taskType: 'local_agent'},
			{status: 'running', background: true, taskType: 'local_agent'},
			{status: 'running', background: true, taskType: 'local_bash'},
			{status: 'completed', background: true, taskType: 'local_agent'},
		]),
		'2 agents · 2 in background',
	);
	assert.equal(tasksBarText([{status: 'running', background: true}]), '1 in background');
});

test('yena console tools are shown as Yena with the command line', async () => {
	const {toolHeader, styledToolHeader} = await import('../../src/ui/present.js');
	const id = (s: string) => s;
	assert.equal(toolHeader('mcp__yena__run_command', {command: 'http get https://x.test'}, id), 'Yena(http get https://x.test)');
	assert.equal(toolHeader('mcp__yena__list_commands', {}, id), 'Yena(list commands)');
	assert.equal(styledToolHeader('mcp__yena__run_command', {command: 'mod list'}, id), `${SGR.bold}Yena${SGR.boldOff}(mod list)`);
	assert.equal(toolHeader('mcp__other__run_command', {command: 'x'}, id), 'other:run_command(command)');
});

test('assistantPrint points each action at its header row after wrapping and indent', async () => {
	const {formatAssistantBlock} = await import('../../src/ui/present.js');
	const id = (s: string) => s;
	const strip = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
	const md = `${'word '.repeat(30)}\n\n\`\`\`js\nlet x = 1;\n\`\`\``;
	const block = assistantPrint(md, id, {width: 40, copyLabel: true});
	const rows = block.text.split('\n').map(strip);
	const actions = block.options.actions ?? [];
	assert.equal(actions.length, 1);
	assert.match(rows[actions[0]!.line]!.trim(), /^╭─ js .* copy ─╮$/);
	assert.equal(actions[0]!.copy, 'let x = 1;');
	assert.equal(strip(formatAssistantBlock(md, id, false, 40)).includes('copy'), false);
	assert.equal(assistantPrint('no code here', id, {copyLabel: true}).options.actions, undefined);
});

test('assistantPrint lays the block out again for each width, with actions for that layout', async () => {
	
	const id = (s: string) => s;
	const strip = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
	const md = `${'word '.repeat(30)}\n\n\`\`\`js\nlet x = 1;\n\`\`\``;
	const block = assistantPrint(md, id, {width: 40, copyLabel: true});
	const render = block.options.render!;
	for (const width of [30, 60, 120]) {
		const out = render(width);
		assert.equal(typeof out, 'object');
		const {text, actions} = out as {text: string; actions?: {line: number; copy: string}[]};
		const rows = text.split('\n').map(strip);
		for (const row of rows) assert.ok(row.length <= width, `${width}: ${row}`);
		assert.equal(actions?.length, 1);
		assert.match(rows[actions![0]!.line]!.trim(), /^╭─ js .* copy ─╮$/);
	}
	assert.ok(strip((render(120) as {text: string}).text).split('\n')[0]!.length > 40);
	assert.deepEqual(assistantPrint('plain', id).options.render!(50), {text: '● plain'});
});

const SGR_ANY = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const onlySgr = (s: string): boolean => !s.replace(SGR_ANY, '').includes(ESC) && !s.includes('\u0007') && !s.includes('‮');
const cardOf = (t: Parameters<typeof formatToolBlock>[0], width?: number, depth: ColorDepth = '16') =>
	withColorDepth(depth, () => formatToolBlock(t, scrub, width));

test('an Edit is a file card: header with counts, then numbered rows in red and green', () => {
	const patch = {hunks: [{oldStart: 9, newStart: 9, lines: [' keep', '-old', '+new1', '+new2']}]};
	const raw = cardOf({name: 'Edit', input: {file_path: '/a.ts'}, isError: false, text: 'ok', patch}, 80);
	assert.deepEqual(stripStyles(raw).split('\n'), [
		'✓ ✎ Edit  ◇ /a.ts  +2 −1',
		'  │  9  9   keep',
		'  │ 10    - old',
		'  │    10 + new1',
		'  │    11 + new2',
	]);
	assert.ok(raw.includes(`${ESC}[0;31m-`) || raw.includes(`${ESC}[31m-`) || raw.includes('31m'));
	assert.ok(onlySgr(raw));
	const rows = raw.split('\n');
	assert.ok(rows[2]!.includes('31'));
	assert.ok(rows[3]!.includes('32'));

	const big = {hunks: [{oldStart: 1, newStart: 1, lines: Array.from({length: 60}, (_, i) => `+l${i}`)}]};
	const capped = stripStyles(cardOf({name: 'Edit', input: {file_path: '/a.ts'}, isError: false, text: 'ok', patch: big}, 80)).split('\n');
	assert.equal(capped.length, 1 + 40);
	assert.match(capped[32]!, /… \+21 lines \(ctrl\+o to expand\)$/);
	assert.match(capped.at(-1)!, /l59$/);

	const fallback = stripStyles(cardOf({name: 'Edit', input: {file_path: '/a.ts', old_string: 'a', new_string: 'b'}, isError: false, text: 'ok'}, 80)).split('\n');
	assert.deepEqual(fallback.slice(1), ['  │ - a', '  │ + b']);
});

test('a Write shows the head of a new file, an overwrite as a diff, and the same content twice is a bare header', () => {
	const content = Array.from({length: 13}, (_, i) => `l${i + 1}`).join('\n');
	const created = stripStyles(cardOf({name: 'Write', input: {file_path: '/n.ts', content}, isError: false, text: 'ok', patch: {hunks: [], created: true}}, 80)).split('\n');
	assert.equal(created[0], '✓ ✎ Write  ◇ /n.ts  +13 −0  new file');
	assert.equal(created[1], '  │  1 l1');
	assert.equal(created.length, 1 + 10 + 1);
	assert.equal(created.at(-1), '  │ … +3 lines (ctrl+o to expand)');

	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '-b', '+c']}]};
	const over = stripStyles(cardOf({name: 'Write', input: {file_path: '/n.ts', content: 'c'}, isError: false, text: 'ok', patch}, 80)).split('\n');
	assert.deepEqual(over, ['✓ ✎ Write  ◇ /n.ts  +1 −2', '  │ 1   - a', '  │ 2   - b', '  │   1 + c']);

	const same = stripStyles(cardOf({name: 'Write', input: {file_path: '/n.ts', content: 'c'}, isError: false, text: 'ok', patch: {hunks: []}}, 80));
	assert.equal(same, '✓ ✎ Write  ◇ /n.ts  +0 −0');
});

test('card rows stay inside the width and their lines are scrubbed', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: [`-${'x'.repeat(80)}`, `+${dirty}`, ` ${'界'.repeat(30)}`]}]};
	for (const width of [20, 30, 60, 100]) {
		for (const depth of ['truecolor', '16', 'none'] as ColorDepth[]) {
			const raw = cardOf({name: 'Edit', input: {file_path: `/${'p'.repeat(60)}`}, isError: false, text: 'ok', patch}, width, depth);
			assert.ok(onlySgr(raw), JSON.stringify(raw));
			assert.ok(!raw.includes(SECRET));
			for (const r of raw.split('\n')) assert.ok(styledCells(r) <= width, `${width} ${depth}: ${JSON.stringify(stripStyles(r))}`);
		}
	}
	const content = Array.from({length: 12}, () => 'y'.repeat(70)).join('\n');
	const head = stripStyles(cardOf({name: 'Write', input: {file_path: '/n', content}, isError: false, text: 'ok'}, 30)).split('\n');
	for (const r of head) assert.ok(stringCells(r) <= 30, JSON.stringify(r));
	assert.match(head.at(-1) ?? '', /^ {2}│ … \+2 lines/);
});

test('errors and refusals of Edit and Write keep the old result, without a card', () => {
	const strip = (s: string) => s.replace(/\u001b\[\d+m/g, '');
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}]};
	for (const name of ['Edit', 'Write']) {
		const out = strip(formatToolBlock({name, input: {file_path: '/a.ts', content: 'b'}, isError: true, text: 'boom', patch}, scrub));
		assert.ok(!out.includes('+ b') && !out.includes('- a'), out);
		assert.ok(out.split('\n').length <= 3, out);
		assert.ok(out.startsWith(`✗ ✎ ${name} /a.ts`), out);
	}
});

test('an Edit with word-level and syntax colours at truecolor, tinted over the whole row', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-const total = count + 1;', '+const total = count + 2;']}]};
	const rows = cardOf({name: 'Edit', input: {file_path: '/a.ts'}, isError: false, text: 'ok', patch}, 80, 'truecolor').split('\n');
	assert.equal(styledCells(rows[1]!), 80);
	assert.ok(rows[1]!.includes('48;2;74;31;36'));
	assert.ok(rows[2]!.includes('48;2;31;58;36'));
	assert.ok(rows[2]!.includes('48;2;47;107;58'));
});

test('secrets and escapes in patch lines never reach the output; a CRLF and a missing width are fine', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: [`-${dirty}`, `+line\r`, `\\ No newline at end of file`]}]};
	const raw = cardOf({name: 'Edit', input: {file_path: '/a.ts'}, isError: false, text: 'ok', patch});
	assert.ok(onlySgr(raw), JSON.stringify(raw));
	assert.ok(!raw.includes(SECRET) && !raw.includes('\r'));
	assert.ok(raw.includes('[redacted]'));
});

test('toolOneLiner names the tool and its main argument without parentheses', () => {
	assert.equal(toolOneLiner('Read', {file_path: 'foo.ts'}, scrub), 'Read foo.ts');
	assert.equal(toolOneLiner('Bash', {command: 'npm test'}, scrub), 'Bash npm test');
	assert.equal(toolOneLiner('Thing', {}, scrub), 'Thing');
	const shown = toolOneLiner('Bash', {command: `cat ${SECRET}`}, scrub);
	assert.ok(!shown.includes(SECRET), shown);
});

test('shortModel shortens Claude model ids and keeps aliases', () => {
	assert.equal(shortModel('claude-haiku-4-5-20251001', scrub), 'haiku-4.5');
	assert.equal(shortModel('claude-opus-4-1', scrub), 'opus-4.1');
	assert.equal(shortModel('claude-sonnet-4-20250514', scrub), 'sonnet-4');
	assert.equal(shortModel('claude-3-5-sonnet-20241022', scrub), 'sonnet-3.5');
	for (const alias of ['opus', 'sonnet', 'haiku', 'inherit']) assert.equal(shortModel(alias, scrub), alias);
	const odd = shortModel(`some-very-long-model-name-${SECRET}`, scrub);
	assert.ok(stringCells(odd) <= 20, odd);
	assert.ok(!odd.includes('\u001b'));
	assert.equal(shortModel(`${SECRET}`, scrub), '[redacted]');
});

test('the thinking row is one muted line with the duration when the engine sent one', () => {
	const sg = (s: string) => s.replace(/\u001b\[[\d;]*m/g, '');
	assert.equal(sg(formatThinking('a long thought\nover lines', scrub, 12_000)), '✻ thinking · 12s (ctrl+o)');
	assert.equal(sg(formatThinking('hmm', scrub)), '✻ thinking (ctrl+o)');
	assert.equal(sg(formatThinking('hmm', scrub, 500)), '✻ thinking · 0.5s (ctrl+o)');
	assert.equal(sg(formatOut({kind: 'thinking', text: 'x', durationMs: 65_000}, scrub)), '✻ thinking · 1m 05s (ctrl+o)');
	assert.ok(!formatThinking('x', scrub).includes('\n'));
});

test('the tail draws an open fence without a bottom border and keeps the partial line plain', () => {
	const withNl = liveTail('```ts\nconst a = 1;\nconst b', scrub, 30, 60).map(plain);
	assert.deepEqual(withNl.slice(1), ['  │ const a = 1;', '  │ const b']);
	assert.ok(withNl[0]!.startsWith('● ╭─ ts '));
	assert.ok(!withNl.some(r => r.includes('╰')));
	const closed = liveTail('```ts\nconst a = 1;\n```', scrub, 30, 60).map(plain);
	assert.ok(closed.at(-1)!.startsWith('  ╰'));
	const halfTable = liveTail('| a | b |', scrub, 30, 60).map(plain);
	assert.deepEqual(halfTable, ['● | a | b |']);
});

test('a long code block is capped in the chat and complete in the viewer rows', async () => {
	const {assistantRows, CODE_BLOCK_ROWS} = await import('../../src/ui/present.js');
	const md = ['```', ...Array.from({length: 200}, (_, i) => `l${i}`), '```'].join('\n');
	const printed = assistantPrint(md, scrub, {width: 40, copyLabel: true});
	assert.equal(printed.text.split('\n').length, CODE_BLOCK_ROWS + 2);
	assert.equal(printed.options.actions![0]!.copy.split('\n').length, 200);
	assert.equal(assistantRows(md, scrub, 40, {full: true}).length, 202);
	assert.ok(assistantRows(md, scrub, 40).length < 202);
});
