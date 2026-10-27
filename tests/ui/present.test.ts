import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeScrub} from '../../src/chat/scrub.js';
import {
	formatAssistantBlock,
	formatError,
	formatNotice,
	formatOut,
	formatToolBlock,
	formatUserLine,
	formatAudit,
	formatModeLine,
	liveTail,
	SGR,
	statusBarText,
	statusLineText,
	tasksBarText,
	modeHint,
	workingText,
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
		statusBarText(
			{model: dirty, sessionId: dirty, phase: 'idle', limit: dirty},
			scrub,
		),
	];
	for (const o of outputs) {
		assert.ok(!o.includes(SECRET), o);
		assert.ok(onlyConstantEscapes(o), JSON.stringify(o));
	}
});

test('escape split across deltas is caught because the tail scrubs the whole', () => {
	const tail = liveTail(`ab${ESC}[3`.concat('1mcd'), scrub, 5, 80).join('\n');
	assert.equal(tail, 'abcd');
});

test('liveTail returns at most the requested rows', () => {
	const tail = liveTail('line\n'.repeat(100), scrub, 7, 40);
	assert.equal(tail.length, 7);
	assert.deepEqual(liveTail('', scrub, 7, 40), []);
});

test('tool block collapses to three result lines with a footer', () => {
	const block = formatToolBlock({name: 'Bash', input: {command: 'ls'}, isError: false, text: '1\n2\n3\n4\n5'}, scrub).replace(/\u001b\[\d+m/g, '');
	assert.equal(block, ['● Bash(ls)', '  ⎿  1', '     2', '     3', '     … +2 lines (ctrl+o to expand)'].join('\n'));
});

test('tool blocks look like Claude Code: green or red dot, bold name, plain arguments', () => {
	const ok = formatToolBlock({name: 'Bash', input: {command: 'ls'}, isError: false, text: 'x'}, scrub);
	const failed = formatToolBlock({name: 'Bash', input: {command: 'ls'}, isError: true, text: 'boom'}, scrub);
	assert.ok(ok.startsWith(`${SGR.green}●${SGR.reset} ${SGR.bold}Bash${SGR.boldOff}(ls)`));
	assert.ok(failed.startsWith(`${SGR.red}●${SGR.reset}`));
	assert.match(failed, /⎿ {2}boom/);
	assert.equal(failed.split(SGR.red).length, 2, 'only the dot is red');
	assert.match(formatToolBlock({name: 'Read', input: {file_path: '/a'}, isError: true, text: ''}, scrub), /⎿ {2}Error/);
});

test('assistant blocks start with a dot and hang under it', () => {
	const strip = (s: string) => s.replace(/\u001b\[\d+m/g, '');
	assert.equal(strip(formatAssistantBlock('one\n\ntwo\nthree', scrub)), '● one\n\n  two\n  three');
	assert.equal(strip(formatAssistantBlock('cut', scrub, true)), '● cut\n  (interrupted)');
	for (const line of strip(formatAssistantBlock('word '.repeat(40), scrub, false, 30)).split('\n')) assert.ok(line.length <= 30, line);
});

test('the working line and the mode hint', () => {
	assert.equal(workingText('running', null, 12.7), 'Working… (12s · esc to interrupt)');
	assert.equal(workingText('running', {kind: 'thinking'}, 0), 'Thinking… (0s · esc to interrupt)');
	assert.equal(workingText('interrupting', null, 3), 'Interrupting…');
	assert.equal(workingText('running', {kind: 'thinking', tokens: 3400}, 72), 'Thinking… (1m 12s · ↓ 3.4k tokens · esc to interrupt)');
	assert.equal(workingText('running', {kind: 'tool-input', name: 'Edit', chars: 800}, 5), 'Writing Edit… (5s · ↓ 200 tokens · esc to interrupt)');
	assert.equal(workingText('running', {kind: 'tool-input', name: 'Ed\u001bit', chars: 0}, 5), 'Writing Edit… (5s · esc to interrupt)');
	assert.equal(workingText('running', null, 130, 59), 'Working… (2m 10s · esc to interrupt)');
	assert.equal(workingText('running', null, 130, 75), 'Working… (2m 10s · no response for 1m 15s · esc to interrupt)');
	assert.equal(modeHint('default'), '');
	assert.equal(modeHint('acceptEdits'), '⏵⏵ accept edits on (shift+tab to cycle)');
	assert.equal(modeHint('plan'), '⏸ plan mode on (shift+tab to cycle)');
});

test('status bar: truncated session first, then model, limit, phase and running tasks', () => {
	const base = {model: 'm', sessionId: '0123456789abc', phase: 'running' as const};
	assert.equal(statusBarText(base, scrub), '01234567 · m · running');
	assert.equal(
		statusBarText({...base, phase: 'idle', limit: '5h limit 85%, resets 15:00', tasks: '3 in background'}, scrub),
		'01234567 · m · 5h limit 85%, resets 15:00 · idle · 3 in background',
	);
	assert.equal(statusBarText({model: undefined, sessionId: undefined, phase: 'idle', tasks: ''}, scrub), 'idle');
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
	assert.ok(long.length <= 'Allowed Bash: '.length + 100);
	assert.ok(long.endsWith('…'));
	const dirtyLine = formatAudit({outcome: 'allowed', toolName: 'Bash', summary: `a${ESC}]0;x\u0007 ${SECRET}\nsecond`}, scrub);
	assert.ok(onlyConstantEscapes(dirtyLine), JSON.stringify(dirtyLine));
	assert.ok(!dirtyLine.includes(SECRET));
	assert.ok(!dirtyLine.includes('second'));
});

test('tool results: Edit and Write summarise, refusals show denied, Bash keeps the clamp', () => {
	const strip = (s: string) => s.replace(/\u001b\[\d+m/g, '');
	const block = (name: string, input: unknown, isError: boolean, text: string) =>
		strip(formatToolBlock({name, input, isError, text}, scrub));
	assert.match(
		block('Edit', {file_path: '/app/a.ts', old_string: 'a', new_string: 'b\nc'}, false, 'The file has been updated'),
		/⎿ {2}Updated \/app\/a\.ts with 2 additions and 1 removal$/,
	);
	assert.match(block('Write', {file_path: '/app/b.ts', content: 'x\ny\n'}, false, 'File created'), /⎿ {2}Wrote 2 lines to \/app\/b\.ts$/);
	assert.match(block('Read', {file_path: '/app/b.ts'}, false, '1\tx\n2\ty\n'), /⎿ {2}Read 2 lines$/);
	assert.match(block('Glob', {pattern: '*.ts'}, false, '/a.ts\n/b.ts'), /⎿ {2}Found 2 files$/);
	assert.match(block('Glob', {pattern: '*.ts'}, false, 'No files found'), /⎿ {2}Found 0 files$/);
	assert.match(block('Bash', {command: 'x'}, true, "The user doesn't want to proceed with this tool use."), /⎿ {2}denied/);
	assert.match(block('Edit', {file_path: '/app/a.ts'}, true, 'The user denied this tool call. Do not retry'), /⎿ {2}denied/);
	assert.match(block('Bash', {command: 'x'}, false, 'a\nb\nc\nd\ne'), /… \+2 lines \(ctrl\+o to expand\)/);
	assert.match(block('AskUserQuestion', {questions: [{question: 'Which?'}, {}]}, false, 'User answered: secret-answer'), /AskUserQuestion\(Which\? \(\+1 more\)\)/);
	assert.ok(!block('AskUserQuestion', {questions: [{question: 'Which?'}]}, false, 'secret-answer').includes('secret-answer'));
});

test('status bar shows awaiting approval instead of the phase', () => {
	const base = {model: undefined, sessionId: undefined};
	assert.equal(statusBarText({...base, phase: 'running', pending: 0}, scrub), 'running');
	assert.equal(statusBarText({...base, phase: 'running', pending: 2}, scrub), 'awaiting approval');
});

test('audit summaries use the reveal function so they match what was approved', () => {
	const show = (s: string) => s.replaceAll(ESC, '<ESC>');
	const line = formatAudit({outcome: 'allowed', toolName: 'Bash', summary: `echo ${ESC}[31m`}, scrub, show);
	assert.ok(line.includes('echo <ESC>[31m'));
	assert.ok(!line.includes(`${ESC}[31m`));
});

test('status bar scrubs the limit segment', () => {
	const base = {model: 'm', sessionId: undefined, phase: 'idle' as const};
	assert.equal(statusBarText({...base, limit: `x${SECRET}`}, scrub).includes(SECRET), false);
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

const TABLE = '| name | description | notes |\n| --- | --- | --- |\n| alpha | a rather long description of alpha | first |\n| beta | another long description for beta | second |';
const plainCells = (s: string) => [...s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')].length;

test('formatOut lays assistant tables out to the given width', () => {
	const out = formatOut({kind: 'assistant', text: TABLE, interrupted: false}, scrub, scrub, 40);
	for (const line of out.split('\n')) assert.ok(plainCells(line) <= 39, line);
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
	assert.equal(toolHeader('mcp__other__run_command', {command: 'x'}, id), 'mcp__other__run_command(command)');
});

test('formatAssistantBlockWithCopy points each action at its header row after wrapping and indent', async () => {
	const {formatAssistantBlockWithCopy, formatAssistantBlock} = await import('../../src/ui/present.js');
	const id = (s: string) => s;
	const strip = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
	const md = `${'word '.repeat(30)}\n\n\`\`\`js\nlet x = 1;\n\`\`\``;
	const block = formatAssistantBlockWithCopy(md, id, false, 40);
	const rows = block.text.split('\n').map(strip);
	assert.equal(block.actions.length, 1);
	assert.equal(rows[block.actions[0]!.line]!.trim(), '╭─ js · copy');
	assert.equal(block.actions[0]!.copy, 'let x = 1;');
	assert.equal(strip(formatAssistantBlock(md, id, false, 40)).includes('copy'), false);
	assert.deepEqual(formatAssistantBlockWithCopy('no code here', id).actions, []);
});
