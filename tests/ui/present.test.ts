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
			{credentialLabel: dirty, model: dirty, sessionId: dirty, phase: 'idle'},
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
	const block = formatToolBlock({name: 'Bash', input: {command: 'ls'}, isError: false, text: '1\n2\n3\n4\n5'}, scrub);
	assert.match(block, /Bash\(ls\)/);
	assert.match(block, /\+2 more lines/);
});

test('status bar shows cost only when positive and truncates the session id', () => {
	const base = {credentialLabel: 'API key', model: 'm', sessionId: '0123456789abc', phase: 'running' as const};
	assert.equal(statusBarText(base, scrub), 'API key · m · 01234567 · running');
});

test('status line texts', () => {
	assert.equal(statusLineText({kind: 'retry', attempt: 2, maxRetries: 5, delayMs: 3000}), 'Retrying (2/5) in 3s…');
	assert.equal(statusLineText({kind: 'thinking'}), 'thinking…');
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
	assert.match(block('Edit', {file_path: '/app/a.ts'}, false, 'The file has been updated'), /⎿ updated \/app\/a\.ts/);
	assert.match(block('Write', {file_path: '/app/b.ts'}, false, 'File created'), /⎿ created \/app\/b\.ts/);
	assert.match(block('Bash', {command: 'x'}, true, "The user doesn't want to proceed with this tool use."), /⎿ denied/);
	assert.match(block('Edit', {file_path: '/app/a.ts'}, true, 'The user denied this tool call. Do not retry'), /⎿ denied/);
	assert.match(block('Bash', {command: 'x'}, false, 'a\nb\nc\nd\ne'), /… \+2 more lines/);
	assert.match(block('AskUserQuestion', {questions: [{question: 'Which?'}, {}]}, false, 'User answered: secret-answer'), /AskUserQuestion\(Which\? \(\+1 more\)\)/);
	assert.ok(!block('AskUserQuestion', {questions: [{question: 'Which?'}]}, false, 'secret-answer').includes('secret-answer'));
});

test('status bar shows the mode and awaiting approval', () => {
	const base = {credentialLabel: 'API key', model: undefined, sessionId: undefined};
	assert.equal(statusBarText({...base, phase: 'running', mode: 'acceptEdits', pending: 0}, scrub), 'API key · running · mode: accept edits');
	assert.equal(statusBarText({...base, phase: 'running', mode: 'default', pending: 2}, scrub), 'API key · awaiting approval · mode: default');
});

test('audit summaries use the reveal function so they match what was approved', () => {
	const show = (s: string) => s.replaceAll(ESC, '<ESC>');
	const line = formatAudit({outcome: 'allowed', toolName: 'Bash', summary: `echo ${ESC}[31m`}, scrub, show);
	assert.ok(line.includes('echo <ESC>[31m'));
	assert.ok(!line.includes(`${ESC}[31m`));
});

test('status bar appends the limit segment after the mode', () => {
	const base = {credentialLabel: 'API key', model: 'm', sessionId: undefined, phase: 'idle' as const, mode: 'default' as const};
	assert.equal(statusBarText({...base, limit: '5h limit 85% · resets 15:00'}, scrub), 'API key · m · idle · mode: default · 5h limit 85% · resets 15:00');
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
