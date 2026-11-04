import {BLOCK_DISPLAY_CAP, clampChars} from '../chat/truncate.js';
import type {AuditEntry, ChatMode} from '../chat/permission.js';
import {SGR_ATTR, sliceCells, stringCells, truncateCells, wrapRows} from '../kit.js';
import {sgr} from './sgr.js';
import type {PrintAction, PrintOptions} from '../../../../src/api.js';
import type {RouteInfo} from '../chat/events.js';
import {openFenceLine, renderMarkdownBlocks} from './markdown.js';
import {formatToolCard, formatToolGroup, resultLines} from './tool-card.js';
import type {Scrub} from './tool-args.js';
import {LIVE, ROUTE_TOOL_NAME, type Out, type Phase, type StatusLine, type Todo} from './transcript.js';
import type {Tier} from '../chat/tiers.js';

export type {Scrub} from './tool-args.js';
export {toolArgs, toolHeader, toolOneLiner, styledToolHeader} from './tool-args.js';

export {sgr, type Sgr} from './sgr.js';

const paint = (style: string, text: string): string =>
	style === ''
		? text
		: text
				.split('\n')
				.map(line => `${style}${line}${SGR_ATTR.reset}`)
				.join('\n');

export function formatUserLine(text: string, scrub: Scrub): string {
	const sg = sgr();
	const lines = scrub(text).split('\n').map((line, i) => ` ${i === 0 ? '>' : ' '} ${line} `);
	return paint(sg.surface, lines.join('\n'));
}

const THINKING_LINES = 6;

export function formatThinking(text: string, scrub: Scrub): string {
	const sg = sgr();
	const lines = scrub(clampChars(text, BLOCK_DISPLAY_CAP)).trim().split('\n');
	const shown = lines.slice(0, THINKING_LINES);
	const more = lines.length - shown.length;
	const body = [`✻ Thinking…`, ...shown.map(l => `  ${l}`), ...(more > 0 ? [`  … +${more} line${more === 1 ? '' : 's'} (ctrl+o to expand)`] : [])];
	return paint(sg.muted + sg.italic, body.join('\n'));
}

const hang = (marker: string, lines: string[]): string =>
	lines.map((l, i) => (i === 0 ? `${marker} ${l}` : l === '' ? '' : `${' '.repeat(BLOCK_INDENT)}${l}`)).join('\n');

const BLOCK_INDENT = 2;

export function formatAssistantBlock(text: string, scrub: Scrub, interrupted = false, width?: number): string {
	return assistantBlock(text, scrub, interrupted, width, false).text;
}

export function assistantPrint(
	text: string,
	scrub: Scrub,
	opts: {interrupted?: boolean; width?: number | undefined; copyLabel?: boolean} = {},
): {text: string; options: PrintOptions} {
	const draw = (width: number | undefined) => assistantBlock(text, scrub, opts.interrupted === true, width, opts.copyLabel === true);
	const now = draw(opts.width);
	return {
		text: now.text,
		options: {
			...(now.actions.length > 0 && {actions: now.actions}),
			render: width => {
				const block = draw(width);
				return block.actions.length > 0 ? block : {text: block.text};
			},
		},
	};
}

function assistantBlock(text: string, scrub: Scrub, interrupted: boolean, width: number | undefined, copyLabel: boolean): {text: string; actions: PrintAction[]} {
	const inner = width === undefined ? undefined : Math.max(10, width - BLOCK_INDENT);
	const rendered = renderMarkdownBlocks(scrub(clampChars(text, BLOCK_DISPLAY_CAP)), {width: inner, copyLabel});
	const lead = /^\n*/.exec(rendered.text)![0].length;
	const source = rendered.text.slice(lead).split('\n');
	const lines: string[] = [];
	const firstRow: number[] = [];
	for (const l of source) {
		firstRow.push(lines.length);
		if (inner === undefined) lines.push(l);
		else lines.push(...wrapRows(l, inner, {mode: 'word'}));
	}
	if (interrupted) lines.push(paint(sgr().muted, '(interrupted)'));
	const actions = rendered.codeBlocks
		.map(b => ({line: firstRow[b.header - lead], copy: b.code}))
		.filter((a): a is PrintAction => a.line !== undefined);
	return {text: hang('●', lines), actions};
}

const MODEL_NAME = /^claude-(opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;
const OLD_MODEL_NAME = /^claude-(\d{1,2})(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/;
const MODEL_CAP = 20;

export function shortModel(model: string, scrub: Scrub): string {
	const m = MODEL_NAME.exec(model);
	if (m) return `${m[1]}-${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
	const old = OLD_MODEL_NAME.exec(model);
	if (old) return `${old[3]}-${old[1]}${old[2] !== undefined ? `.${old[2]}` : ''}`;
	const shown = scrub(model).replace(/\s+/g, ' ');
	return shown.length > MODEL_CAP ? `${shown.slice(0, MODEL_CAP - 1)}…` : shown;
}

export function queuedLines(queue: string[], scrub: Scrub, max: number): string[] {
	if (max <= 0 || queue.length === 0) return [];
	const one = (q: string) => `↳ queued: ${scrub(q.replace(/\s+/g, ' '))}`;
	if (queue.length <= max) return queue.map(one);
	return [...queue.slice(0, max - 1).map(one), `↳ +${queue.length - max + 1} more queued`];
}

const TODO_MARK: Record<Todo['status'], string> = {completed: '☒', in_progress: '☐', pending: '☐'};

export function todoLines(todos: Todo[], scrub: Scrub, max: number): string[] {
	const sg = sgr();
	if (max <= 0 || !todos.some(t => t.status !== 'completed')) return [];
	const line = (t: Todo) => {
		const text = `${TODO_MARK[t.status]} ${scrub(t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content)}`;
		if (t.status === 'completed') return paint(sg.muted + sg.strike, text);
		return t.status === 'in_progress' ? paint(sg.bold, text) : text;
	};
	if (todos.length <= max) return resultLines(todos.map(line));
	const current = Math.max(0, todos.findIndex(t => t.status !== 'completed'));
	const start = Math.min(current, todos.length - (max - 1));
	const shown = todos.slice(start, start + max - 1).map(line);
	return resultLines([...shown, paint(sg.muted, `… +${todos.length - shown.length} more`)]);
}

export {RESULT_PREFIX, resultLines, TOOL_RESULT_ROWS} from './tool-card.js';

export const formatToolBlock = formatToolCard;

export type RouteBlock = {tier?: Tier; detail?: string; tone: 'ok' | 'dim'};

export function routeBlockOf(route: RouteInfo, previous?: Tier): RouteBlock {
	const change = route.main !== undefined && previous !== undefined && previous !== route.main ? `chat ${previous} -> ${route.main}` : undefined;
	if (route.outcome === 'pinned') {
		return {tone: 'ok', ...(route.pinned !== undefined && {tier: route.pinned}), detail: change ? `pinned, ${change}` : 'pinned'};
	}
	if (route.failed || route.outcome === 'kept') {
		const tier = route.rated ?? route.main;
		return tier === undefined ? {tone: 'dim', detail: 'failed, model unchanged'} : {tone: 'dim', tier, detail: 'kept'};
	}
	const parts: string[] = [];
	if (route.held && route.main !== undefined) parts.push(`held, chat ${route.main}`);
	else if (change) parts.push(change);
	if (route.newTask && previous !== undefined) parts.push('new task');
	return {tone: 'ok', ...(route.rated !== undefined && {tier: route.rated}), ...(parts.length > 0 && {detail: parts.join(', ')})};
}

export function formatRouteBlock(block: RouteBlock, scrub: Scrub, width?: number): string {
	const sg = sgr();
	const dot = `${block.tone === 'ok' ? sg.ok : sg.muted}●${sg.reset}`;
	const tier = block.tier !== undefined ? `(${scrub(block.tier)})` : '';
	const detail = block.detail !== undefined ? ` · ${scrub(block.detail)}` : '';
	let rest = `${tier}${detail}`;
	if (width !== undefined) rest = truncateCells(rest, Math.max(1, width - 2 - ROUTE_TOOL_NAME.length));
	return `${dot} ${sg.bold}${ROUTE_TOOL_NAME}${sg.boldOff}${rest}${sg.reset}`;
}

export function routeNoticeText(pinned: Tier | undefined): string {
	return pinned !== undefined ? `Tier pinned: ${pinned}` : 'Tier: back to the router';
}

export function routeBarText(route: RouteInfo | undefined): string {
	if (!route) return '';
	if (route.pinned !== undefined) return `tier: ${route.pinned} (pinned)`;
	if (route.outcome === 'off') return '';
	const parts: string[] = [];
	if (route.rated !== undefined) parts.push(`task: ${route.rated}`);
	if (route.main !== undefined && (route.rated === undefined || route.main !== route.rated)) parts.push(`chat: ${route.main}`);
	return parts.join(' · ');
}

export function formatError(message: string, scrub: Scrub): string {
	return paint(sgr().error, `Error: ${scrub(message)}`);
}

export function formatWarning(message: string, scrub: Scrub): string {
	return paint(sgr().warn, scrub(message));
}

export function formatNotice(message: string, scrub: Scrub): string {
	return paint(sgr().muted, scrub(message));
}

const auditText = (raw: string, show: Scrub): string => show(raw).split('\n')[0] ?? '';

const pluralQuestions = (summary: string): string => {
	const m = /^(\d+) question\(s\)$/.exec(summary);
	if (!m) return summary;
	return m[1] === '1' ? '1 question' : `${m[1]} questions`;
};

export function formatAudit(entry: AuditEntry, scrub: Scrub, reveal: Scrub = scrub, width?: number): string {
	const tool = scrub(entry.toolName);
	const summary = auditText(entry.summary, reveal);
	const line = ((): string => {
		switch (entry.outcome) {
			case 'allowed':
				return `Allowed ${tool}: ${summary}`;
			case 'auto-accepted':
				return `Auto-accepted ${tool}: ${summary}`;
			case 'always-allowed':
				return `Always-allowed ${tool}(${summary}) for this chat`;
			case 'denied':
				return `Denied ${tool}: ${summary}`;
			case 'denied-by-policy':
				return `Blocked ${tool}: ${summary}`;
			case 'cancelled':
				return `Cancelled ${tool}: the turn was interrupted`;
			case 'answered':
				return `Answered ${pluralQuestions(summary)}`;
			case 'dismissed':
				return `Dismissed ${pluralQuestions(summary)}`;
		}
	})();
	return paint(sgr().muted, width === undefined ? line : cutMiddle(line, Math.max(1, width)));
}

function cutMiddle(text: string, max: number): string {
	const cells = stringCells(text);
	if (cells <= max) return text;
	if (max < 3) return truncateCells(text, max);
	const head = Math.ceil((max - 1) / 2);
	const tail = max - 1 - head;
	return `${sliceCells(text, 0, head)}…${sliceCells(text, cells - tail, tail)}`;
}

const MODE_LINE: Record<ChatMode, string> = {
	default: 'Mode: default (edits ask for approval)',
	acceptEdits: 'Mode: auto-accept edits (this chat only)',
	plan: 'Mode: plan (yena researches and proposes a plan; nothing is changed until you approve it)',
	auto: 'Mode: auto (a classifier approves or denies tool calls, asks when unsure; this chat only)',
};

export function formatModeLine(mode: ChatMode, error?: string, scrub: Scrub = s => s): string {
	const line = error === undefined ? MODE_LINE[mode] : `Auto mode is unavailable: ${scrub(error)}. ${MODE_LINE[mode]}`;
	return paint(sgr().muted, line);
}

export function formatOut(out: Out, scrub: Scrub, reveal: Scrub = scrub, width?: number): string {
	switch (out.kind) {
		case 'audit':
			return formatAudit(out.entry, scrub, reveal, width);
		case 'mode':
			return formatModeLine(out.mode, out.error, scrub);
		case 'account':
			return formatNotice(
				out.reason === 'pinned'
					? `Now on account "${out.account}" (chosen with "claude auth use").`
					: `Now on account "${out.account}" instead of "${out.previous}".`,
				scrub,
			);
		case 'route-block':
			return formatRouteBlock(routeBlockOf(out.route, out.previous), scrub, width);
		case 'route':
			return formatNotice(routeNoticeText(out.pinned), scrub);
		case 'thinking':
			return formatThinking(out.text, scrub);
		case 'task':
			return paint(sgr().muted, `⚙ Background task ${out.status}: ${scrub(out.description)}${out.summary ? ` — ${scrub(out.summary)}` : ''}`);
		case 'assistant':
			return formatAssistantBlock(out.text, scrub, out.interrupted, width);
		case 'tool':
			return formatToolCard(out, scrub, width);
		case 'tool-group':
			return formatToolGroup(out.items, scrub, width);
		case 'error':
			return formatError(out.message, scrub);
		case 'api-error':
			return formatError(`API error (${out.code})`, scrub);
		case 'blank':
			return ' ';
		case 'outcome':
			switch (out.outcome) {
				case 'interrupted':
					return formatNotice('Interrupted.', scrub);
				case 'timeout':
					return formatError(out.error ?? 'The request timed out', scrub);
				case 'max-turns':
					return formatError(out.error ?? 'Reached the maximum number of turns', scrub);
				case 'error':
					return formatError(out.error ?? 'The request failed', scrub);
				case 'limit':
					return formatWarning(out.error ?? 'Usage limit reached', scrub);
				case 'context':
					return formatWarning(out.error ?? 'The conversation is too long for the context window', scrub);
			}
	}
}

let tailCache: {raw: string; scrub: Scrub; columns: number; rows: string[]} | undefined;

export function liveTail(liveRaw: string, scrub: Scrub, maxRows: number, columns: number): string[] {
	if (liveRaw === '' || maxRows <= 0) return [];
	const cached = tailCache;
	const rows =
		cached && cached.raw === liveRaw && cached.scrub === scrub && cached.columns === columns
			? cached.rows
			: renderTail(liveRaw, scrub, columns);
	tailCache = {raw: liveRaw, scrub, columns, rows};
	return rows.slice(-maxRows);
}

function renderTail(liveRaw: string, scrub: Scrub, columns: number): string[] {
	let window = liveRaw;
	let cut = false;
	if (window.length > LIVE.tailChars) {
		const start = liveRaw.length - LIVE.tailChars;
		const nl = liveRaw.indexOf('\n', start);
		const from = nl >= 0 ? nl + 1 : start;
		window = liveRaw.slice(from);
		const fence = openFenceLine(liveRaw.slice(0, from));
		if (fence !== undefined) window = `${fence}\n${window}`;
		cut = true;
	}
	const rows = assistantBlock(window, scrub, false, Math.max(1, columns - 1), false).text.split('\n');
	if (cut && rows[0]?.startsWith('● ')) rows[0] = `${' '.repeat(BLOCK_INDENT)}${rows[0].slice(2)}`;
	return rows;
}

export function statusLineText(status: StatusLine): string {
	if (!status) return '';
	switch (status.kind) {
		case 'thinking':
			return 'Thinking…';
		case 'tool-input': {
			const name = status.name.replace(/[^\w:.-]/g, '').slice(0, 40);
			return name ? `Writing ${name}…` : 'Writing…';
		}
		case 'compacting':
			return 'Compacting…';
		case 'retry':
			return `Retrying (${status.attempt}/${status.maxRetries}) in ${Math.ceil(status.delayMs / 1000)}s…`;
	}
}

export const formatDuration = (seconds: number): string => {
	const s = Math.max(0, Math.floor(seconds));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const formatTokens = (n: number): string => (n < 1000 ? `${Math.round(n)}` : `${(n / 1000).toFixed(1)}k`);

export const QUIET_NOTICE_S = 60;

export const WORKING_VERBS = [
	'Sniffing',
	'Prowling',
	'Scavenging',
	'Cackling',
	'Gnawing',
	'Tracking',
	'Stalking',
	'Pouncing',
	'Burrowing',
	'Howling',
	'Lurking',
	'Snuffling',
	'Chomping',
	'Circling',
	'Crunching bones',
	'Following the scent',
	'Perking ears',
	'Wagging',
	'Den-digging',
	'Rallying the clan',
	'Giggling at bugs',
	'Licking paws',
	'Fluffing the tail',
	'Digging up old code',
	'Chewing on a stack trace',
	'Whooping',
	'Marking territory',
	'Napping in the shade',
	'Stealing from lions',
	'Sharpening teeth',
	'Twitching ears',
	'Nosing around',
	'Spotting the spots',
	'Hunting by moonlight',
	'Grooming the pack',
	'Dragging it to the den',
	'Laughing maniacally',
	'Smelling a regression',
	'Tail-chasing',
	'Bone-burying',
	'Paw-typing',
	'Snarling at the linter',
	'Scouting the savanna',
	'Yipping',
] as const;

export function pickWorkingVerb(random = Math.random, previous?: string): string {
	const pool = WORKING_VERBS.filter(v => v !== previous);
	return pool[Math.floor(random() * pool.length)] ?? 'Working';
}

export function workingText(phase: Phase, status: StatusLine, seconds: number, quietSeconds = 0, verb?: string): string {
	if (phase === 'interrupting') return 'Interrupting…';
	const what = verb !== undefined && (!status || status.kind === 'thinking') ? `${verb}…` : statusLineText(status) || 'Working…';
	const parts = [formatDuration(seconds)];
	const tokens = status?.kind === 'thinking' ? status.tokens : status?.kind === 'tool-input' && status.chars > 0 ? status.chars / 4 : undefined;
	if (tokens !== undefined && tokens > 0) parts.push(`↓ ${formatTokens(tokens)} tokens`);
	if (quietSeconds >= QUIET_NOTICE_S) parts.push(`no response for ${formatDuration(quietSeconds)}`);
	parts.push('esc to interrupt');
	return `${what} (${parts.join(' · ')})`;
}

const MODE_HINT: Record<ChatMode, string> = {
	default: '',
	acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
	plan: '⏸ plan mode on (shift+tab to cycle)',
	auto: '⏵⏵ auto mode on (shift+tab to cycle)',
};

export const modeHint = (mode: ChatMode): string => MODE_HINT[mode];

export function tasksBarText(tasks: readonly {status: string; background: boolean; taskType?: string}[]): string {
	const running = tasks.filter(t => t.status === 'running');
	const agents = running.filter(t => t.taskType === 'local_agent').length;
	const background = running.filter(t => t.background).length;
	const parts: string[] = [];
	if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
	if (background > 0) parts.push(`${background} in background`);
	return parts.join(' · ');
}

export function statusBarText(
	s: {
		account?: string;
		pin?: string;
		model: string | undefined;
		route?: string;
		sessionId: string | undefined;
		phase: Phase;
		pending?: number;
		limit?: string;
		tasks?: string;
	},
	scrub: Scrub,
): string {
	const parts: string[] = [];
	if (s.pin !== undefined && s.pin !== s.account) parts.push(s.account ? `${scrub(s.account)} -> *${scrub(s.pin)}` : `*${scrub(s.pin)}`);
	else if (s.account) parts.push(`${s.pin !== undefined ? '*' : ''}${scrub(s.account)}`);
	if (s.sessionId) parts.push(scrub(s.sessionId).slice(0, 8));
	if (s.model) parts.push(scrub(s.model));
	if (s.route) parts.push(scrub(s.route));
	if (s.limit) parts.push(scrub(s.limit));
	parts.push(s.pending !== undefined && s.pending > 0 ? 'awaiting approval' : s.phase);
	if (s.tasks) parts.push(s.tasks);
	return parts.join(' · ');
}
