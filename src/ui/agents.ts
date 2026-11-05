import {HANDBACK_TOOL, SPAWN_TOOLS} from '../chat/agent-policy.js';
import type {AgentItem, ChatEvent, TaskStatus, ToolPatch, UiEvent} from '../chat/events.js';

export type AgentStatus = TaskStatus;

export type AgentEntry =
	| {kind: 'text'; text: string}
	| {kind: 'thinking'; text: string}
	| {kind: 'notice'; text: string}
	| {kind: 'tool'; toolUseId: string; name: string; input: unknown; isError?: boolean; text?: string; patch?: ToolPatch; done: boolean};

export type AgentBox = {
	id: string;
	name: string;
	description: string;
	prompt: string;
	model?: string;
	modelReported: boolean;
	subagentType?: string;
	background: boolean;
	status: AgentStatus;
	parent?: string;
	depth: number;
	taskId?: string;
	finishedTurn?: number;
	history: AgentEntry[];
	dropped: number;
	bytes: number;
	pending: Map<string, {name: string; input: unknown}>;
	report?: string;
	spawnName?: string;
	aliases?: string[];
	placeholder?: true;
	touchedAt?: number;
	reopened?: {status: AgentStatus; finishedTurn?: number; report?: string; entries: number};
	staleStopped?: true;
};

export type AgentsState = {
	boxes: Map<string, AgentBox>;
	order: string[];
	turn: number;
	lastTurnEnd: number;
	running: boolean;
	selected?: string;
	open?: string;
	scroll: number;
};

export type SeedTask = {id?: string; status: string; background: boolean; taskType?: string; toolUseId?: string; subagentType?: string; description?: string};

export const AGENTS_CAPS = {
	boxes: 32,
	depth: 4,
	entries: 300,
	bytes: 512 * 1024,
	entryText: 64 * 1024,
	pending: 64,
	report: 64 * 1024,
	field: 16 * 1024,
	name: 256,
	aliases: 16,
} as const;

export const AGENT_STALE_GRACE_MS = 10_000;
export const RESUMED_NOTICE = 'Resumed';
export const SEED_NOTICE = 'Earlier messages are not available';

export const initialAgents = (): AgentsState => ({boxes: new Map(), order: [], turn: 0, lastTurnEnd: 0, running: false, scroll: 0});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, cap: number): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, cap) : undefined);
const serializedSize = (v: unknown): number => {
	try {
		return JSON.stringify(v)?.length ?? 0;
	} catch {
		return 0;
	}
};

const inputSizes = new WeakMap<object, number>();
const inputBytes = (input: unknown): number => {
	if (typeof input !== 'object' || input === null) return serializedSize(input);
	let size = inputSizes.get(input);
	if (size === undefined) {
		size = serializedSize(input);
		inputSizes.set(input, size);
	}
	return size;
};

const capInput = (input: unknown): unknown => {
	if (inputBytes(input) <= AGENTS_CAPS.entryText) return input;
	if (typeof input === 'string') return input.slice(0, AGENTS_CAPS.entryText);
	if (!isRecord(input)) return undefined;
	const capped: Record<string, unknown> = {};
	let room = AGENTS_CAPS.entryText;
	for (const [key, value] of Object.entries(input)) {
		room -= key.length + 6;
		if (room <= 0) break;
		if (typeof value === 'string') {
			const kept = value.slice(0, room);
			capped[key] = kept;
			room -= kept.length;
		} else {
			const size = serializedSize(value);
			if (size > room) continue;
			capped[key] = value;
			room -= size;
		}
	}
	return capped;
};

const entryBytes = (e: AgentEntry): number => (e.kind === 'tool' ? (e.text?.length ?? 0) + inputBytes(e.input) : e.text.length);

const uniqueName = (state: AgentsState, base: string): string => {
	const used = new Set([...state.boxes.values()].map(b => b.name));
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
};

const prune = (state: AgentsState): AgentsState => {
	const order = state.order.filter(id => state.boxes.has(id));
	const selected = state.selected !== undefined && state.boxes.has(state.selected) ? state.selected : undefined;
	const open = state.open !== undefined && state.boxes.has(state.open) ? state.open : undefined;
	const next: AgentsState = {boxes: state.boxes, order, turn: state.turn, lastTurnEnd: state.lastTurnEnd, running: state.running, scroll: state.scroll};
	if (selected !== undefined) next.selected = selected;
	if (open !== undefined) next.open = open;
	return next;
};

const withRoom = (state: AgentsState): AgentsState | undefined => {
	if (state.boxes.size < AGENTS_CAPS.boxes) return state;
	const victim = state.order.find(id => state.boxes.get(id)?.status !== 'running');
	if (victim === undefined) return undefined;
	const boxes = new Map(state.boxes);
	boxes.delete(victim);
	return prune({...state, boxes});
};

const addBox = (state: AgentsState, box: AgentBox): AgentsState => {
	const room = withRoom(state);
	if (!room) return state;
	const boxes = new Map(room.boxes);
	boxes.set(box.id, box);
	return {...room, boxes, order: [...room.order, box.id]};
};

const putBox = (state: AgentsState, box: AgentBox): AgentsState => {
	const boxes = new Map(state.boxes);
	boxes.set(box.id, box);
	return {...state, boxes};
};

const newBox = (state: AgentsState, id: string, base: string, fields: Partial<AgentBox> = {}): AgentBox => ({
	id,
	name: uniqueName(state, base.slice(0, AGENTS_CAPS.name)),
	description: '',
	prompt: '',
	modelReported: false,
	background: false,
	status: 'running',
	depth: 0,
	history: [],
	dropped: 0,
	bytes: 0,
	pending: new Map(),
	...fields,
});

const touch = (box: AgentBox, now?: number): AgentBox => (now === undefined ? box : {...box, touchedAt: now});

const spawnBox = (state: AgentsState, id: string, input: unknown, parent?: string, now?: number): AgentsState => {
	if (state.boxes.has(id)) return state;
	const o = isRecord(input) ? input : {};
	const parentBox = parent !== undefined ? state.boxes.get(parent) : undefined;
	const model = text(o['model'], AGENTS_CAPS.name);
	const subagentType = text(o['subagent_type'], AGENTS_CAPS.name);
	const spawnName = text(o['name'], AGENTS_CAPS.name);
	const box = newBox(state, id, spawnName ?? subagentType ?? 'agent', {
		...(spawnName !== undefined && {spawnName}),
		...(now !== undefined && {touchedAt: now}),
		description: text(o['description'], AGENTS_CAPS.field) ?? '',
		prompt: text(o['prompt'], AGENTS_CAPS.field) ?? '',
		background: o['run_in_background'] === true,
		...(model !== undefined && {model}),
		...(subagentType !== undefined && {subagentType}),
		...(parentBox && {parent: parentBox.id, depth: Math.min(AGENTS_CAPS.depth, parentBox.depth + 1)}),
	});
	return addBox(state, box);
};

const finish = (box: AgentBox, status: AgentStatus, turn: number, report?: string): AgentBox => ({
	...box,
	status,
	finishedTurn: turn,
	...(box.report === undefined && report !== undefined && report.trim() !== '' && {report: report.slice(0, AGENTS_CAPS.report)}),
});

const evict = (box: AgentBox, history: AgentEntry[], bytes: number): AgentBox => {
	let dropped = box.dropped;
	while (history.length > 1 && (history.length > AGENTS_CAPS.entries || bytes > AGENTS_CAPS.bytes)) {
		bytes -= entryBytes(history.shift()!);
		dropped++;
	}
	return {...box, history, bytes, dropped};
};

const appendEntries = (box: AgentBox, entries: AgentEntry[]): AgentBox => {
	if (entries.length === 0) return box;
	return evict(box, [...box.history, ...entries], box.bytes + entries.reduce((n, e) => n + entryBytes(e), 0));
};

const fillResult = (box: AgentBox, item: Extract<AgentItem, {type: 'tool-result'}>): AgentBox => {
	const result = {
		isError: item.isError,
		text: item.text.slice(0, AGENTS_CAPS.entryText),
		...(item.patch !== undefined && {patch: item.patch}),
		done: true,
	};
	const pending = new Map(box.pending);
	const call = pending.get(item.toolUseId);
	pending.delete(item.toolUseId);
	let at = box.history.length - 1;
	for (; at >= 0; at--) {
		const e = box.history[at]!;
		if (e.kind === 'tool' && e.toolUseId === item.toolUseId && !e.done) break;
	}
	if (at < 0) {
		if (!call) return {...box, pending};
		return appendEntries({...box, pending}, [{kind: 'tool', toolUseId: item.toolUseId, name: call.name, input: call.input, ...result}]);
	}
	const history = [...box.history];
	const entry = history[at] as Extract<AgentEntry, {kind: 'tool'}>;
	const filled = {...entry, ...result};
	history[at] = filled;
	return evict({...box, pending}, history, box.bytes - entryBytes(entry) + entryBytes(filled));
};

const applyItems = (box: AgentBox, items: readonly AgentItem[]): AgentBox => {
	let next = box;
	for (const item of items) {
		if (item.type === 'text' || item.type === 'thinking') {
			if (item.text.trim() === '') continue;
			next = appendEntries(next, [{kind: item.type, text: item.text.slice(0, AGENTS_CAPS.entryText)}]);
		} else if (item.type === 'tool-use') {
			const input = capInput(item.input);
			const pending = new Map(next.pending);
			pending.set(item.toolUseId, {name: item.name, input});
			while (pending.size > AGENTS_CAPS.pending) pending.delete(pending.keys().next().value!);
			next = appendEntries({...next, pending}, [{kind: 'tool', toolUseId: item.toolUseId, name: item.name, input, done: false}]);
		} else {
			next = fillResult(next, item);
		}
	}
	return next;
};

const finishFromResult = (state: AgentsState, id: string, isError: boolean, report: string): AgentsState => {
	const box = state.boxes.get(id);
	if (!box || box.background || box.status !== 'running') return state;
	return putBox(state, finish(box, isError ? 'failed' : 'completed', state.turn, report));
};

const findBox = (state: AgentsState, id?: string, taskId?: string): AgentBox | undefined => {
	const boxes = [...state.boxes.values()];
	return (
		(id !== undefined ? (state.boxes.get(id) ?? boxes.find(b => b.aliases?.includes(id))) : undefined) ??
		(taskId !== undefined ? boxes.find(b => b.taskId === taskId) : undefined)
	);
};

const isKnownId = (box: AgentBox, id: string): boolean => box.id === id || (box.aliases?.includes(id) ?? false);

const withAlias = (box: AgentBox, id?: string): AgentBox => {
	if (id === undefined || isKnownId(box, id)) return box;
	const aliases = [...(box.aliases ?? []), id];
	while (aliases.length > AGENTS_CAPS.aliases) aliases.shift();
	return {...box, aliases};
};

const reopen = (box: AgentBox, now?: number, alias?: string): AgentBox => {
	const aliased = withAlias(box, alias);
	if (box.status === 'running') return touch(aliased, now);
	const {finishedTurn, report, ...rest} = aliased;
	const noticed = appendEntries({...rest, status: 'running', background: true}, [{kind: 'notice', text: RESUMED_NOTICE}]);
	return touch(
		{
			...noticed,
			reopened: {
				status: box.status,
				entries: noticed.dropped + noticed.history.length,
				...(finishedTurn !== undefined && {finishedTurn}),
				...(report !== undefined && {report}),
			},
		},
		now,
	);
};

const sendMessage = (state: AgentsState, callId: string, input: unknown, now?: number): AgentsState => {
	const to = isRecord(input) ? text(input['to'], AGENTS_CAPS.name) : undefined;
	if (to === undefined) return state;
	const boxes = state.order.map(i => state.boxes.get(i)!).filter(b => b !== undefined).reverse();
	const box = boxes.find(b => b.spawnName === to) ?? boxes.find(b => b.taskId === to) ?? boxes.find(b => b.name === to);
	return box ? putBox(state, reopen(box, now, callId)) : state;
};

const agentMessage = (state: AgentsState, e: Extract<UiEvent, {kind: 'agent-message'}>, now?: number): AgentsState => {
	let next = state;
	let found = findBox(next, e.agentId, e.taskId);
	if (!found) {
		next = addBox(next, newBox(next, e.agentId, 'agent', {placeholder: true, ...(e.taskId !== undefined && {taskId: e.taskId}), ...(now !== undefined && {touchedAt: now})}));
		found = next.boxes.get(e.agentId);
		if (!found) return state;
	} else {
		const resumed = !isKnownId(found, e.agentId);
		let box: AgentBox;
		if (found.staleStopped) {
			// The safety net stopped it during a long silent step: the agent was alive after all.
			const {staleStopped: _stale, finishedTurn: _turn, ...rest} = withAlias(found, resumed ? e.agentId : undefined);
			box = touch({...rest, status: 'running'}, now);
		} else box = resumed ? reopen(withAlias(found, e.agentId), now) : found;
		if (box.taskId === undefined && e.taskId !== undefined) box = {...box, taskId: e.taskId};
		if (box !== found) next = putBox(next, box);
		found = box;
	}
	const ownId = found.id;
	for (const item of e.items) {
		if (item.type === 'tool-use' && SPAWN_TOOLS.has(item.name)) next = spawnBox(next, item.toolUseId, item.input, ownId, now);
		else if (item.type === 'tool-use' && item.name === 'SendMessage') next = sendMessage(next, item.toolUseId, item.input, now);
		if (item.type === 'tool-result' && item.toolUseId !== ownId && next.boxes.has(item.toolUseId)) {
			next = finishFromResult(next, item.toolUseId, item.isError, item.text);
		}
	}
	const box = next.boxes.get(ownId);
	if (!box) return next;
	let updated = touch(applyItems(box, e.items), now);
	if (e.model !== undefined && !updated.modelReported) updated = {...updated, model: e.model, modelReported: true};
	const handback = e.items.find(i => i.type === 'tool-use' && i.name === HANDBACK_TOOL);
	if (handback?.type === 'tool-use' && updated.status === 'running') {
		const message = isRecord(handback.input) ? text(handback.input['message'], AGENTS_CAPS.report) : undefined;
		updated = finish(updated, 'completed', next.turn, message);
	}
	return putBox(next, updated);
};

const taskEvent = (state: AgentsState, e: Extract<UiEvent, {kind: 'task'}>, now?: number): AgentsState => {
	let box = findBox(state, e.toolUseId, e.id);
	if (!box) return state;
	if (e.toolUseId !== undefined && !isKnownId(box, e.toolUseId)) {
		const resumed = e.status === 'running' && box.status !== 'running';
		box = withAlias(box, e.toolUseId);
		if (resumed) box = reopen(box, now);
	}
	if (e.status === 'running') box = touch(box, now);
	const parentBox = e.parentTaskId !== undefined ? [...state.boxes.values()].find(b => b.taskId === e.parentTaskId && b.id !== box.id) : undefined;
	let next: AgentBox = {
		...box,
		taskId: e.id,
		...(e.subagentType !== undefined && {subagentType: e.subagentType}),
		...(box.prompt === '' && e.prompt !== undefined && {prompt: e.prompt.slice(0, AGENTS_CAPS.field)}),
		...(e.background === true && {background: true}),
		...(parentBox && {parent: parentBox.id, depth: Math.min(AGENTS_CAPS.depth, parentBox.depth + 1)}),
	};
	if (e.status !== 'running' && next.status === 'running') next = finish(next, e.status, state.turn, e.summary);
	else if (e.summary !== undefined && next.report === undefined && e.status !== 'running') next = {...next, report: e.summary.slice(0, AGENTS_CAPS.report)};
	return putBox(state, next);
};

const removeWhere = (state: AgentsState, drop: (b: AgentBox) => boolean): AgentsState => {
	const victims = [...state.boxes.values()].filter(drop);
	if (victims.length === 0) return state;
	const boxes = new Map(state.boxes);
	for (const b of victims) boxes.delete(b.id);
	for (const [id, b] of boxes) {
		if (b.parent === undefined || boxes.has(b.parent)) continue;
		const {parent: _gone, ...orphan} = b;
		boxes.set(id, orphan);
	}
	return prune({...state, boxes});
};

export function reconcileAgents(state: AgentsState, tasks: readonly SeedTask[], now: number): {state: AgentsState; recheckAt?: number} {
	if (state.running) return {state};
	const mapped = (b: AgentBox): boolean =>
		tasks.some(t => t.status === 'running' && ((t.id !== undefined && t.id === b.taskId) || (t.toolUseId !== undefined && isKnownId(b, t.toolUseId))));
	const gone = new Set<string>();
	const changed = new Map<string, AgentBox>();
	let recheckAt: number | undefined;
	for (const b of state.boxes.values()) {
		if (b.status !== 'running' || mapped(b)) continue;
		const expiry = (b.touchedAt ?? 0) + AGENT_STALE_GRACE_MS;
		if (now < expiry) {
			recheckAt = recheckAt === undefined ? expiry : Math.min(recheckAt, expiry);
			continue;
		}
		if (b.placeholder) gone.add(b.id);
		else if (b.reopened && b.reopened.entries === b.dropped + b.history.length) {
			const {reopened, ...rest} = b;
			changed.set(b.id, {
				...rest,
				status: reopened.status,
				...(reopened.finishedTurn !== undefined && {finishedTurn: reopened.finishedTurn}),
				...(reopened.report !== undefined && {report: reopened.report}),
			});
		} else changed.set(b.id, {...finish(b, 'stopped', state.turn), staleStopped: true});
	}
	let next = state;
	if (changed.size > 0) {
		const boxes = new Map(state.boxes);
		for (const [id, b] of changed) boxes.set(id, b);
		next = {...state, boxes};
	}
	next = removeWhere(next, b => gone.has(b.id));
	return {state: next, ...(recheckAt !== undefined && {recheckAt})};
}

export function reduceAgents(state: AgentsState, event: ChatEvent, now?: number): AgentsState {
	switch (event.type) {
		case 'state':
			if (event.state === 'running' && !state.running) return {...state, running: true, turn: state.turn + 1};
			if (event.state !== 'running' && state.running) return {...state, running: false};
			return state;
		case 'sent':
			return removeWhere(state, b => b.status !== 'running' && (!b.background || b.placeholder === true));
		case 'turn-end': {
			const stop = event.outcome === 'interrupted' || event.outcome === 'error' || event.outcome === 'timeout';
			let next: AgentsState = {...state, running: false, lastTurnEnd: state.turn};
			next = removeWhere(next, b => b.background && b.status !== 'running' && (b.finishedTurn ?? 0) < state.turn);
			if (!stop) return next;
			const boxes = new Map(next.boxes);
			for (const [id, b] of boxes) if (b.status === 'running' && !b.background) boxes.set(id, finish(b, 'stopped', state.turn));
			return {...next, boxes};
		}
		case 'ui': {
			const e = event.event;
			switch (e.kind) {
				case 'tool-use':
					if (SPAWN_TOOLS.has(e.name)) return spawnBox(state, e.toolUseId, e.input, undefined, now);
					return e.name === 'SendMessage' ? sendMessage(state, e.toolUseId, e.input, now) : state;
				case 'tool-result':
					return finishFromResult(state, e.toolUseId, e.isError, e.text);
				case 'agent-message':
					return agentMessage(state, e, now);
				case 'task':
					return taskEvent(state, e, now);
				default:
					return state;
			}
		}
		default:
			return state;
	}
}

export function seedFromTasks(state: AgentsState, tasks: readonly SeedTask[]): AgentsState {
	let next = state;
	for (const t of tasks) {
		if (t.status !== 'running' || t.taskType !== 'local_agent' || t.toolUseId === undefined || next.boxes.has(t.toolUseId)) continue;
		const box = newBox(next, t.toolUseId, text(t.subagentType, AGENTS_CAPS.name) ?? 'agent', {
			description: text(t.description, AGENTS_CAPS.field) ?? '',
			background: t.background,
			...(t.id !== undefined && {taskId: t.id}),
			...(t.subagentType !== undefined && {subagentType: t.subagentType.slice(0, AGENTS_CAPS.name)}),
			history: [{kind: 'notice', text: SEED_NOTICE}],
			bytes: SEED_NOTICE.length,
		});
		next = addBox(next, box);
	}
	return next;
}

export const agentChildren = (state: AgentsState, id: string): AgentBox[] =>
	state.order.map(i => state.boxes.get(i)!).filter(b => b !== undefined && b.parent === id);

export const anyRunning = (state: AgentsState): boolean => [...state.boxes.values()].some(b => b.status === 'running');

export function focusAgent(state: AgentsState, focus: {selected?: string | undefined; open?: string | undefined}): AgentsState {
	const next: AgentsState = {boxes: state.boxes, order: state.order, turn: state.turn, lastTurnEnd: state.lastTurnEnd, running: state.running, scroll: state.scroll};
	if (focus.selected !== undefined && state.boxes.has(focus.selected)) next.selected = focus.selected;
	if (focus.open !== undefined && state.boxes.has(focus.open)) next.open = focus.open;
	return next.selected === state.selected && next.open === state.open ? state : next;
}
