import type {AgentPolicy, CommandConfirmRequest, CommandInfo, CommandInfoSub, CommandRunResult, CommandRunStatus} from '../../../../src/api.js';
import type {ChatTuning, LivePatch} from '../chat-prefs.js';
import type {SlashCommandInfo, TaskInfo} from '../chat/chat-session.js';
import type {ChatMode, ChatEvent, ChatState, ContextInfo, PermissionDecision, PermissionRequest, PlanItem, RateLimitInfo, RouteInfo} from '../deps/chat.js';
import {ContractError, readChatEvent, readContextInfo, readPermissionDecision, readPermissionRequest, readPlanItems, readProviderCommand, readRateLimit, readRouteInfo, readTaskInfo, TIERS, type Tier} from '../deps/chat.js';
import {ACCOUNT_NAME_RE} from '../accounts.js';
import {MAX_ENTRIES, type WireBundle, type WireEntry} from '../vault.js';

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;

export class ProtocolError extends Error {
	override name = 'ProtocolError';
}

export type OpenSpec = {
	fresh: boolean;
	model?: string;
	resume?: string;
	fork?: boolean;
	resumeAt?: string;
	historyUntil?: string;
	draft?: string;
	apiKeyOnly?: boolean;
};

export type StatePatch = {lastSessionId?: string; lastModel?: string; allowedCommands?: string[]};

export type RpcCall =
	| {op: 'stopTask'; args: {id: string}}
	| {op: 'mcpStatus'; args: Record<string, never>}
	| {op: 'reconnectMcp'; args: {name: string}}
	| {op: 'rewindFiles'; args: {userMessageId: string}}
	| {op: 'backgroundTasks'; args: Record<string, never>};
export type RpcOp = RpcCall['op'];

export type Snapshot = {
	state: ChatState;
	sessionId?: string;
	model?: string;
	mode: ChatMode;
	needsNewSession: boolean;
	title?: string;
	route?: RouteInfo;
	context?: ContextInfo;
	plan?: PlanItem[];
	pendingPermissions: PermissionRequest[];
	tasks: TaskInfo[];
	commands: SlashCommandInfo[];
	rateLimit?: RateLimitInfo;
	costUsd?: number;
	queued: string[];
	startedAt: number;
};

export type SessionStatus = {
	kind: 'chat' | 'ask';
	where: 'local' | 'runner';
	state: 'idle' | 'running' | 'waiting-permission';
	title?: string;
	sessionId8?: string;
	startedAt: number;
	pending: number;
	queued: number;
	attached: boolean;
};

type Base = {v: 1};

export type ClientFrame = Base &
	(
		| {type: 'hello'; role: 'attach' | 'control'}
		| {type: 'open'; open: OpenSpec; tuning: ChatTuning; mode?: ChatMode; keep: boolean}
		| {type: 'send'; text: string; command?: boolean}
		| {type: 'steer'; text: string}
		| {type: 'interrupt'}
		| {type: 'setMode'; mode: ChatMode}
		| {type: 'answer'; id: string; decision: PermissionDecision}
		| {type: 'reset'}
		| {type: 'applyLive'; patch: LivePatch}
		| {type: 'setTier'; tier: Tier | 'auto'}
		| {type: 'setTitle'; title: string}
		| {type: 'forget'; key: string}
		| {type: 'queue'; lines: string[]}
		| {type: 'setKeep'; keep: boolean}
		| {type: 'commands'; list: CommandInfo[]}
		| ({type: 'rpc'; id: string} & RpcCall)
		| {type: 'bridgeResult'; id: string; result: CommandRunResult}
		| {type: 'bridgeConfirm'; id: string; ok: boolean}
		| {type: 'close'}
		| {type: 'stop'}
		| {type: 'status'}
		| {type: 'credentials'; bundle: WireBundle}
	);

export type RunnerFrame = Base &
	(
		| ({type: 'snapshot'} & Snapshot)
		| {type: 'event'; event: ChatEvent}
		| {type: 'rpcResult'; id: string; ok: boolean; value?: unknown; error?: string}
		| {type: 'bridgeRun'; id: string; line: string; timeoutMs: number; approved?: boolean}
		| {type: 'bridgeAbort'; id: string}
		| {type: 'bridgeAsk'; id: string; request: CommandConfirmRequest}
		| {type: 'stateUpdate'; patch: StatePatch}
		| {type: 'log'; level: 'error' | 'warn' | 'info' | 'debug'; msg: string; fields?: Record<string, unknown>}
		| {type: 'statusReply'; status: SessionStatus}
		| {type: 'bye'; reason: string}
	);

export type Frame = ClientFrame | RunnerFrame;
export type FrameDirection = 'toRunner' | 'toClient';

const fail = (what: string): never => {
	throw new ProtocolError(`Invalid frame: ${what}`);
};

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const rec = (v: unknown, what: string): Rec => (isRec(v) ? v : fail(`${what} must be an object`));
const str = (v: unknown, what: string, max = MAX_FRAME_BYTES): string =>
	typeof v === 'string' && v.length <= max ? v : fail(`${what} must be a string`);
const ident = (v: unknown, what: string): string => {
	const s = str(v, what, 256);
	return s === '' ? fail(`${what} must not be empty`) : s;
};
const bool = (v: unknown, what: string): boolean => (typeof v === 'boolean' ? v : fail(`${what} must be a boolean`));
const num = (v: unknown, what: string): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail(`${what} must be a number`));
const nonNeg = (v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : fail(`${what} must be a number from 0 to ${max}`);
const int = (v: unknown, what: string): number => (Number.isSafeInteger(v) ? (v as number) : fail(`${what} must be an integer`));
const oneOf = <T extends string>(v: unknown, set: readonly T[], what: string): T =>
	typeof v === 'string' && (set as readonly string[]).includes(v) ? (v as T) : fail(`${what} is not valid`);
const arr = (v: unknown, what: string, max: number): unknown[] =>
	Array.isArray(v) && v.length <= max ? v : fail(`${what} must be a list of at most ${max}`);
const has = (o: Rec, key: string): boolean => o[key] !== undefined && o[key] !== null;

const MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const STATES = ['idle', 'running', 'closed'] as const;
const POLICIES = ['safe', 'confirm', 'deny'] as const;
const RUN_STATUSES = ['ok', 'error', 'invalid', 'unknown', 'denied', 'declined', 'off', 'busy', 'timeout', 'aborted'] as const;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const STYLES = ['Explanatory', 'Learning'] as const;

const optStr = (o: Rec, key: string, max?: number): string | undefined => (has(o, key) ? str(o[key], key, max) : undefined);
const optNum = (o: Rec, key: string): number | undefined => (has(o, key) ? num(o[key], key) : undefined);
const optBool = (o: Rec, key: string): boolean | undefined => (has(o, key) ? bool(o[key], key) : undefined);
const strList = (v: unknown, what: string, max: number): string[] => arr(v, what, max).map((s, i) => str(s, `${what}[${i}]`));

const readOpen = (v: unknown): OpenSpec => {
	const o = rec(v, 'open');
	return {
		fresh: bool(o.fresh, 'fresh'),
		...(has(o, 'model') && {model: ident(o.model, 'model')}),
		...(has(o, 'resume') && {resume: ident(o.resume, 'resume')}),
		...(has(o, 'fork') && {fork: bool(o.fork, 'fork')}),
		...(has(o, 'resumeAt') && {resumeAt: ident(o.resumeAt, 'resumeAt')}),
		...(has(o, 'historyUntil') && {historyUntil: str(o.historyUntil, 'historyUntil')}),
		...(has(o, 'draft') && {draft: str(o.draft, 'draft')}),
		...(has(o, 'apiKeyOnly') && {apiKeyOnly: bool(o.apiKeyOnly, 'apiKeyOnly')}),
	};
};

const readTuning = (v: unknown): ChatTuning => {
	const o = rec(v, 'tuning');
	return {
		...(has(o, 'effort') && {effort: oneOf(o.effort, EFFORTS, 'effort')}),
		...(has(o, 'thinking') && {thinking: oneOf(o.thinking, ['disabled'] as const, 'thinking')}),
		...(o.fastMode === true && {fastMode: true as const}),
		...(has(o, 'outputStyle') && {outputStyle: oneOf(o.outputStyle, STYLES, 'outputStyle')}),
		...(o.noMcp === true && {noMcp: true as const}),
		...(o.hooks === true && {hooks: true as const}),
	};
};

const readPatch = (v: unknown): LivePatch => {
	const o = rec(v, 'patch');
	const nullable = <T extends string>(key: string, read: (x: unknown) => T): T | null | undefined =>
		o[key] === null ? null : o[key] === undefined ? undefined : read(o[key]);
	const model = nullable('model', x => ident(x, 'model'));
	const effort = nullable('effort', x => oneOf(x, EFFORTS, 'effort'));
	const thinking = nullable('thinking', x => oneOf(x, ['disabled'] as const, 'thinking'));
	const outputStyle = nullable('outputStyle', x => oneOf(x, STYLES, 'outputStyle'));
	return {
		...(model !== undefined && {model}),
		...(effort !== undefined && {effort}),
		...(thinking !== undefined && {thinking}),
		...(has(o, 'fastMode') && {fastMode: bool(o.fastMode, 'fastMode')}),
		...(outputStyle !== undefined && {outputStyle}),
	};
};

const readStatePatch = (v: unknown): StatePatch => {
	const o = rec(v, 'patch');
	return {
		...(has(o, 'lastSessionId') && {lastSessionId: ident(o.lastSessionId, 'lastSessionId')}),
		...(has(o, 'lastModel') && {lastModel: str(o.lastModel, 'lastModel', 256)}),
		...(has(o, 'allowedCommands') && {allowedCommands: strList(o.allowedCommands, 'allowedCommands', 1000)}),
	};
};

const readPolicy = (v: unknown): AgentPolicy => oneOf(v, POLICIES, 'policy');

const MAX_SUB_DEPTH = 3;

const readSubcommands = (v: unknown, depth: number): CommandInfoSub[] =>
	arr(v, 'subcommands', 100).map(s => {
		const so = rec(s, 'subcommand');
		const sub: CommandInfoSub = {
			name: ident(so.name, 'name'),
			aliases: strList(so.aliases, 'aliases', 20),
			usage: str(so.usage, 'usage', 4096),
			description: str(so.description, 'description', 4096),
			policy: readPolicy(so.policy),
		};
		if (has(so, 'subcommands')) {
			if (depth >= MAX_SUB_DEPTH) fail('subcommands nested too deep');
			sub.subcommands = readSubcommands(so.subcommands, depth + 1);
		}
		return sub;
	});

const readCommandInfo = (v: unknown): CommandInfo => {
	const o = rec(v, 'command');
	return {
		name: ident(o.name, 'name'),
		description: str(o.description, 'description', 4096),
		...(has(o, 'usage') && {usage: str(o.usage, 'usage', 4096)}),
		policy: readPolicy(o.policy),
		subcommands: readSubcommands(o.subcommands, 1),
	};
};

const readRunResult = (v: unknown): CommandRunResult => {
	const o = rec(v, 'result');
	return {
		status: oneOf(o.status, RUN_STATUSES, 'status') as CommandRunStatus,
		output: str(o.output, 'output'),
		truncated: bool(o.truncated, 'truncated'),
		ms: num(o.ms, 'ms'),
		...(has(o, 'reason') && {reason: str(o.reason, 'reason', 4096)}),
	};
};

const readConfirmRequest = (v: unknown): CommandConfirmRequest => {
	const o = rec(v, 'request');
	return {
		line: str(o.line, 'line', 4096),
		command: str(o.command, 'command', 256),
		...(has(o, 'subcommand') && {subcommand: str(o.subcommand, 'subcommand', 256)}),
		caller: str(o.caller, 'caller', 256),
	};
};

const readSnapshot = (o: Rec): Snapshot => ({
	state: oneOf(o.state, STATES, 'state') as ChatState,
	...(has(o, 'sessionId') && {sessionId: ident(o.sessionId, 'sessionId')}),
	...(has(o, 'model') && {model: str(o.model, 'model', 256)}),
	mode: oneOf(o.mode, MODES, 'mode'),
	needsNewSession: bool(o.needsNewSession, 'needsNewSession'),
	...(has(o, 'title') && {title: str(o.title, 'title', 4096)}),
	...(has(o, 'route') && {route: readRouteInfo(o.route)}),
	...(has(o, 'context') && {context: readContextInfo(rec(o.context, 'context'))}),
	...(has(o, 'plan') && {plan: readPlanItems(o.plan)}),
	pendingPermissions: arr(o.pendingPermissions, 'pendingPermissions', 100).map(readPermissionRequest),
	tasks: arr(o.tasks, 'tasks', 100).map(readTaskInfo),
	commands: arr(o.commands, 'commands', 300).map(readProviderCommand),
	...(has(o, 'rateLimit') && {rateLimit: readRateLimit(o.rateLimit)}),
	...(has(o, 'costUsd') && {costUsd: num(o.costUsd, 'costUsd')}),
	queued: strList(o.queued, 'queued', 16),
	startedAt: num(o.startedAt, 'startedAt'),
});

const readStatus = (v: unknown): SessionStatus => {
	const o = rec(v, 'status');
	return {
		kind: oneOf(o.kind, ['chat', 'ask'] as const, 'kind'),
		where: oneOf(o.where, ['local', 'runner'] as const, 'where'),
		state: oneOf(o.state, ['idle', 'running', 'waiting-permission'] as const, 'state'),
		...(has(o, 'title') && {title: str(o.title, 'title', 4096)}),
		...(has(o, 'sessionId8') && {sessionId8: str(o.sessionId8, 'sessionId8', 16)}),
		startedAt: num(o.startedAt, 'startedAt'),
		pending: int(o.pending, 'pending'),
		queued: int(o.queued, 'queued'),
		attached: bool(o.attached, 'attached'),
	};
};

const readRpc = (o: Rec): {id: string} & RpcCall => {
	const id = ident(o.id, 'id');
	const args = rec(o.args ?? {}, 'args');
	switch (o.op) {
		case 'stopTask':
			return {id, op: 'stopTask', args: {id: ident(args.id, 'task id')}};
		case 'mcpStatus':
			return {id, op: 'mcpStatus', args: {}};
		case 'reconnectMcp':
			return {id, op: 'reconnectMcp', args: {name: ident(args.name, 'name')}};
		case 'rewindFiles':
			return {id, op: 'rewindFiles', args: {userMessageId: ident(args.userMessageId, 'userMessageId')}};
		case 'backgroundTasks':
			return {id, op: 'backgroundTasks', args: {}};
		default:
			return fail('rpc op');
	}
};

const readLogFields = (v: unknown): Record<string, unknown> => {
	const o = rec(v, 'fields');
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(o).slice(0, 20)) {
		const x = o[k];
		if (typeof x === 'string') out[k] = x.slice(0, 1024);
		else if (typeof x === 'number' || typeof x === 'boolean' || x === null) out[k] = x;
	}
	return out;
};

const VAULT_STATUSES = ['ok', 'no-provider', 'no-grant', 'old-host', 'error'] as const;
const VALUE_MAX = 8192;

const readWireEntry = (v: unknown): WireEntry => {
	const o = rec(v, 'entry');
	const name = str(o.name, 'name', 32);
	if (!ACCOUNT_NAME_RE.test(name)) fail('account name');
	if (has(o, 'slot')) fail('slot');
	return {
		name,
		type: oneOf(o.type, ['key'] as const, 'type'),
		kind: oneOf(o.kind, ['api-key', 'oauth'] as const, 'kind'),
		...(has(o, 'email') && {email: str(o.email, 'email', 320)}),
		disabled: bool(o.disabled, 'disabled'),
		...(o.reserved === true && {reserved: true}),
		...(has(o, 'value') && {value: str(o.value, 'value', VALUE_MAX)}),
	};
};

const readBundle = (v: unknown): WireBundle => {
	const o = rec(v, 'bundle');
	return {status: oneOf(o.status, VAULT_STATUSES, 'status'), entries: arr(o.entries, 'entries', MAX_ENTRIES).map(readWireEntry)};
};

type Reader = (o: Rec) => Rec | null;

const CLIENT: Record<string, Reader> = {
	hello: o => ({role: oneOf(o.role, ['attach', 'control'] as const, 'role')}),
	open: o => ({
		open: readOpen(o.open),
		tuning: readTuning(o.tuning ?? {}),
		...(has(o, 'mode') && {mode: oneOf(o.mode, MODES, 'mode')}),
		keep: bool(o.keep, 'keep'),
	}),
	send: o => ({text: str(o.text, 'text'), ...(o.command === true && {command: true})}),
	steer: o => ({text: str(o.text, 'text')}),
	interrupt: () => ({}),
	setMode: o => ({mode: oneOf(o.mode, MODES, 'mode')}),
	answer: o => ({id: ident(o.id, 'id'), decision: readPermissionDecision(o.decision)}),
	reset: () => ({}),
	applyLive: o => ({patch: readPatch(o.patch)}),
	setTier: o => ({tier: oneOf(o.tier, [...TIERS, 'auto'] as const, 'tier')}),
	setTitle: o => ({title: str(o.title, 'title', 4096)}),
	forget: o => ({key: str(o.key, 'key', 4096)}),
	queue: o => ({lines: strList(o.lines, 'lines', 16)}),
	setKeep: o => ({keep: bool(o.keep, 'keep')}),
	commands: o => ({list: arr(o.list, 'list', 500).map(readCommandInfo)}),
	rpc: o => readRpc(o),
	bridgeResult: o => ({id: ident(o.id, 'id'), result: readRunResult(o.result)}),
	bridgeConfirm: o => ({id: ident(o.id, 'id'), ok: bool(o.ok, 'ok')}),
	close: () => ({}),
	stop: () => ({}),
	status: () => ({}),
	credentials: o => ({bundle: readBundle(o.bundle)}),
};

const RUNNER: Record<string, Reader> = {
	snapshot: o => ({...readSnapshot(o)}),
	event: o => {
		const event = readChatEvent(o.event);
		return event ? {event} : null;
	},
	rpcResult: o => {
		const ok = bool(o.ok, 'ok');
		return {
			id: ident(o.id, 'id'),
			ok,
			...(ok && o.value !== undefined && {value: o.value}),
			...(!ok && {error: str(o.error, 'error', 4096)}),
		};
	},
	bridgeRun: o => {
		const approved = optBool(o, 'approved');
		return {id: ident(o.id, 'id'), line: str(o.line, 'line', 4096), timeoutMs: num(o.timeoutMs, 'timeoutMs'), ...(approved !== undefined && {approved})};
	},
	bridgeAbort: o => ({id: ident(o.id, 'id')}),
	bridgeAsk: o => ({id: ident(o.id, 'id'), request: readConfirmRequest(o.request)}),
	stateUpdate: o => ({patch: readStatePatch(o.patch)}),
	log: o => ({
		level: oneOf(o.level, LOG_LEVELS, 'level'),
		msg: str(o.msg, 'msg', 4096),
		...(has(o, 'fields') && {fields: readLogFields(o.fields)}),
	}),
	statusReply: o => ({status: readStatus(o.status)}),
	bye: o => ({reason: str(o.reason, 'reason', 1024)}),
};

export const validateFrame = (raw: unknown, direction: FrameDirection): Frame | null => {
	const o = rec(raw, 'frame');
	if (o.v !== PROTOCOL_VERSION) fail('unsupported version');
	if (typeof o.type !== 'string') fail('missing type');
	const table = direction === 'toRunner' ? CLIENT : RUNNER;
	if (!Object.hasOwn(table, o.type as string)) return null;
	let body: Rec | null;
	try {
		body = table[o.type as string]!(o);
	} catch (err) {
		if (err instanceof ContractError) throw new ProtocolError(`Invalid frame: ${err.detail}`);
		throw err;
	}
	return body === null ? null : ({v: 1, type: o.type, ...body} as Frame);
};

export const encodeFrame = (frame: Frame): string => {
	const line = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new ProtocolError('Frame is too large');
	return line;
};

export type FrameDecoder = {
	push(chunk: Buffer | string): Frame[];
};

export const createDecoder = (direction: FrameDirection): FrameDecoder => {
	let pending: Buffer = Buffer.alloc(0);
	let failed: ProtocolError | undefined;
	return {
		push(chunk) {
			if (failed) throw failed;
			try {
				pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, Buffer.from(chunk)]);
				const frames: Frame[] = [];
				let start = 0;
				for (;;) {
					const nl = pending.indexOf(0x0a, start);
					if (nl === -1) break;
					if (nl - start > MAX_FRAME_BYTES) throw new ProtocolError('Frame is too large');
					if (nl > start) frames.push(...decodeLine(pending.subarray(start, nl), direction));
					start = nl + 1;
				}
				pending = pending.subarray(start);
				if (pending.length > MAX_FRAME_BYTES) throw new ProtocolError('Frame is too large');
				if (pending.length > 0) pending = Buffer.from(pending);
				return frames;
			} catch (err) {
				failed = err instanceof ProtocolError ? err : new ProtocolError('Invalid frame');
				throw failed;
			}
		},
	};
};

const decodeLine = (line: Buffer, direction: FrameDirection): Frame[] => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line.toString('utf8'));
	} catch {
		throw new ProtocolError('Invalid frame: not JSON');
	}
	const frame = validateFrame(parsed, direction);
	return frame ? [frame] : [];
};
