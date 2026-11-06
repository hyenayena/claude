import type {ContextInfo} from '../deps/chat.js';
import {colorDepth, formatElapsed, glyph, meterBar, paintTone, sanitizeText, segmentBar, truncateCells, type BarSegment, type ColorDepth, type ThemeTone} from '../kit.js';
import {QUIET_NOTICE_S, routeBarText, statusLineText, tasksBarText} from './present.js';
import type {Phase, StatusLine} from './transcript.js';
import {formatTokens} from './turn-summary.js';

export const CONTEXT_WARN = 0.6;
export const CONTEXT_HIGH = 0.85;
export const METER_CELLS = 6;
const NAME_CELLS = 40;

type Scrub = (s: string) => string;
type Tasks = Parameters<typeof tasksBarText>[0];

export type StatusInput = {
	phase: Phase;
	status: StatusLine;
	awaiting: boolean;
	elapsedMs: number;
	quietMs: number;
	verb: string;
	model?: string;
	route?: string;
	context?: ContextInfo;
	account?: string;
	pin?: string;
	limit?: string;
	tasks?: Tasks;
	project?: string;
	branch?: string;
	scrub: Scrub;
};

export type StatusOptions = {frame: string; ascii?: boolean; depth?: ColorDepth};

const clean = (text: string, scrub: Scrub): string => truncateCells(sanitizeText(scrub(text), 200).replace(/\s+/g, ' '), NAME_CELLS);

export function shortModel(id: string, scrub: Scrub = s => s): string {
	const name = clean(id, scrub)
		.replace(/^claude-/, '')
		.replace(/-\d{8}(?=(\[[^\]]*\])?$)/, '');
	return name;
}

export function contextTone(fraction: number): ThemeTone {
	if (fraction >= CONTEXT_HIGH) return 'error';
	if (fraction >= CONTEXT_WARN) return 'warn';
	return 'muted';
}

export function contextSegment(context: ContextInfo | undefined, o: StatusOptions): BarSegment | undefined {
	if (!context) return undefined;
	const depth = o.depth ?? colorDepth();
	if (context.limit === undefined || context.limit <= 0) return {forms: [`${paintTone('ctx', 'muted', depth)} ${formatTokens(context.used)}`]};
	const fraction = context.used / context.limit;
	const tone = contextTone(fraction);
	const pct = `${Math.min(100, Math.round(fraction * 100))}%`;
	const label = paintTone('ctx', 'muted', depth);
	const meter = meterBar(fraction, METER_CELLS, {tone, emptyTone: 'frame', ascii: o.ascii === true, depth});
	return {forms: [`${label} ${meter} ${paintTone(pct, tone, depth)}`, `${label} ${paintTone(pct, tone, depth)}`]};
}

export function activitySegment(input: StatusInput, o: StatusOptions): BarSegment {
	const depth = o.depth ?? colorDepth();
	const paint = (text: string, tone: ThemeTone): string => paintTone(text, tone, depth);
	const keep = true;
	if (input.phase === 'interrupting') return {forms: [paint('Interrupting…', 'warn')], keep};
	if (input.awaiting) return {forms: [paint('awaiting approval', 'warn')], keep};
	if (input.phase === 'idle' && input.status === null) return {forms: [paint('idle', 'muted')], keep};
	const status = input.status;
	const what = !status || status.kind === 'thinking' ? `${input.verb}…` : statusLineText(status) || 'Working…';
	const elapsed = formatElapsed(input.elapsedMs);
	const head = paint(`${o.frame} ${what} ${elapsed}`, 'running');
	const tokens = status?.kind === 'thinking' ? status.tokens : status?.kind === 'tool-input' && status.chars > 0 ? status.chars / 4 : undefined;
	const quiet = input.quietMs >= QUIET_NOTICE_S * 1000 ? paint(`no response ${formatElapsed(input.quietMs)}`, 'warn') : undefined;
	const extra = (...parts: (string | undefined)[]): string => parts.filter((p): p is string => p !== undefined).map(p => ` ${paint('·', 'muted')} ${p}`).join('');
	const tokenPart = tokens !== undefined && tokens > 0 ? paint(`↓ ${formatTokens(tokens)}`, 'muted') : undefined;
	const forms = [
		`${head}${extra(tokenPart, quiet, paint('esc to interrupt', 'muted'))}`,
		`${head}${extra(quiet)}`,
		paint(`${o.frame} ${elapsed}`, 'running'),
	];
	return {forms: forms.filter((f, i) => forms.indexOf(f) === i), keep};
}

function modelSegment(input: StatusInput): BarSegment | undefined {
	const name = input.model ? shortModel(input.model, input.scrub) : '';
	const route = input.route ? clean(input.route, input.scrub).replace(/^tier: (.+) \(pinned\)$/, '$1, pinned').replace(/\b(task|chat): /g, '$1 ') : '';
	if (name === '' && route === '') return undefined;
	if (name === '') return {forms: [`(${route})`]};
	return {forms: route === '' ? [name] : [`${name} (${route})`, name]};
}

function accountSegment(input: StatusInput, depth: ColorDepth): BarSegment | undefined {
	const account = input.account === undefined ? undefined : clean(input.account, input.scrub);
	const pin = input.pin === undefined ? undefined : clean(input.pin, input.scrub);
	let name: string;
	if (pin !== undefined && pin !== account) name = account ? `${account} -> *${pin}` : `*${pin}`;
	else if (account) name = `${pin !== undefined ? '*' : ''}${account}`;
	else name = '';
	const limit = input.limit ? clean(input.limit, input.scrub) : '';
	if (name === '') return limit === '' ? undefined : {forms: [paintTone(limit, 'warn', depth)]};
	if (limit === '') return {forms: [name]};
	return {forms: [`${name} ${paintTone('·', 'muted', depth)} ${paintTone(limit, 'warn', depth)}`, name]};
}

function agentsSegment(input: StatusInput, o: StatusOptions): BarSegment | undefined {
	const tasks = input.tasks ?? [];
	const full = tasksBarText(tasks);
	if (full === '') return undefined;
	const running = tasks.filter(t => t.status === 'running');
	const agents = running.filter(t => t.taskType === 'local_agent').length;
	const count = agents > 0 ? agents : running.filter(t => t.background).length;
	return {forms: [full, `${glyph('toolAgent', {ascii: o.ascii === true})} ${count}`]};
}

function projectSegment(input: StatusInput, o: StatusOptions): BarSegment | undefined {
	const project = input.project ? clean(input.project, input.scrub) : '';
	if (project === '') return undefined;
	const branch = input.branch ? clean(input.branch, input.scrub) : '';
	return {forms: branch === '' ? [project] : [`${project} ${glyph('branch', {ascii: o.ascii === true})} ${branch}`, project]};
}

export function chatStatusRow(input: StatusInput, width: number, o: StatusOptions): string {
	const depth = o.depth ?? colorDepth();
	const opts = {...o, depth};
	const segments = [
		activitySegment(input, opts),
		modelSegment(input),
		contextSegment(input.context, opts),
		accountSegment(input, depth),
		agentsSegment(input, opts),
		projectSegment(input, opts),
	].filter((s): s is BarSegment => s !== undefined);
	return segmentBar(segments, width, {depth, ascii: o.ascii === true});
}
