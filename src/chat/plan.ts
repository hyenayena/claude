import {sanitizeText} from '../kit.js';
import type {UiEvent} from './events.js';

export type PlanStatus = 'pending' | 'in_progress' | 'completed';
export type PlanItem = {id?: string; content: string; activeForm?: string; status: PlanStatus};

export const MAX_PLAN_ITEMS = 50;
export const MAX_PLAN_TEXT = 200;
export const MAX_PLAN_ID = 32;
export const MAX_PLAN_PENDING = 64;
export const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed'];

export const PLAN_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

const CREATED = new RegExp(`^Task #([\\w.-]{1,${MAX_PLAN_ID}}) created successfully`);
const LIST_LINE = /^#(\S+) \[(pending|in_progress|completed)\] (.*)$/;
const BLOCKED = / \[blocked by [^\]]*\]$/;

function clipText(value: unknown): string {
	return typeof value === 'string' ? sanitizeText(value.replace(/\s+/g, ' '), MAX_PLAN_TEXT) : '';
}

function clipId(value: unknown): string {
	const s = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
	return /^[\w.-]{1,32}$/.test(s) ? s : '';
}

function statusOf(value: unknown): PlanStatus {
	return value === 'in_progress' || value === 'completed' ? value : 'pending';
}

export function parseTodos(input: unknown): PlanItem[] {
	const list = (input as {todos?: unknown} | null)?.todos;
	if (!Array.isArray(list)) return [];
	const out: PlanItem[] = [];
	for (const raw of list.slice(0, MAX_PLAN_ITEMS)) {
		const t = raw as {content?: unknown; status?: unknown; activeForm?: unknown} | null;
		const content = clipText(t?.content);
		if (content === '') continue;
		const activeForm = clipText(t?.activeForm);
		out.push({content, status: statusOf(t?.status), ...(activeForm !== '' && {activeForm})});
	}
	return out;
}

export type PlanNote =
	| {kind: 'new'; steps: number}
	| {kind: 'added'; steps: number}
	| {kind: 'done'; text: string}
	| {kind: 'more-done'; count: number}
	| {kind: 'finished'; done: number; total: number};

const MAX_DONE_NOTES = 3;

const keyOf = (i: PlanItem): string => i.id ?? i.content;
const allDone = (items: readonly PlanItem[]): boolean => items.length > 0 && items.every(i => i.status === 'completed');

export function planChanges(prev: readonly PlanItem[], next: readonly PlanItem[]): PlanNote[] {
	if (next.length === 0) return [];
	const before = new Map(prev.map(i => [keyOf(i), i]));
	const fresh = prev.length === 0 || allDone(prev) || !next.some(i => before.has(keyOf(i)));
	if (fresh) {
		if (allDone(next)) return [];
		return [{kind: 'new', steps: next.length}];
	}
	const notes: PlanNote[] = [];
	const added = next.filter(i => !before.has(keyOf(i))).length;
	if (added > 0) notes.push({kind: 'added', steps: added});
	const finished = next.filter(i => i.status === 'completed' && before.get(keyOf(i)) !== undefined && before.get(keyOf(i))!.status !== 'completed');
	for (const i of finished.slice(0, MAX_DONE_NOTES)) notes.push({kind: 'done', text: i.content});
	if (finished.length > MAX_DONE_NOTES) notes.push({kind: 'more-done', count: finished.length - MAX_DONE_NOTES});
	if (allDone(next)) notes.push({kind: 'finished', done: next.length, total: next.length});
	return notes;
}

type Call = {name: string; input: unknown};

export class PlanTracker {
	private list: PlanItem[] = [];
	private readonly calls = new Map<string, Call>();

	get items(): readonly PlanItem[] {
		return this.list;
	}

	reset(): void {
		this.list = [];
		this.calls.clear();
	}

	onUi(ev: UiEvent): PlanItem[] | undefined {
		if (ev.kind === 'tool-use') {
			if (!PLAN_TOOLS.has(ev.name)) return undefined;
			this.calls.set(ev.toolUseId, {name: ev.name, input: ev.input});
			if (this.calls.size > MAX_PLAN_PENDING) this.calls.delete(this.calls.keys().next().value!);
			return undefined;
		}
		if (ev.kind !== 'tool-result') return undefined;
		const call = this.calls.get(ev.toolUseId);
		if (call === undefined) return undefined;
		this.calls.delete(ev.toolUseId);
		if (ev.isError) return undefined;
		const next = this.apply(call, ev.text);
		if (next === undefined || JSON.stringify(next) === JSON.stringify(this.list)) return undefined;
		this.list = next;
		return next.map(i => ({...i}));
	}

	private apply(call: Call, text: string): PlanItem[] | undefined {
		const input = (call.input ?? {}) as Record<string, unknown>;
		switch (call.name) {
			case 'TodoWrite':
				return Array.isArray(input['todos']) ? parseTodos(input) : undefined;
			case 'TaskCreate': {
				const content = clipText(input['subject']);
				if (content === '') return undefined;
				const activeForm = clipText(input['activeForm']);
				const id = CREATED.exec(text)?.[1];
				const item: PlanItem = {...(id !== undefined && {id}), content, status: 'pending', ...(activeForm !== '' && {activeForm})};
				const base = this.list.length === 0 || allDone(this.list) ? [] : this.list;
				return [...base, item].slice(0, MAX_PLAN_ITEMS);
			}
			case 'TaskUpdate': {
				const id = clipId(input['taskId']);
				if (id === '' || !/^Updated task/.test(text)) return undefined;
				const at = this.list.findIndex(i => i.id === id);
				if (at < 0) return undefined;
				if (input['status'] === 'deleted') return this.list.filter((_, n) => n !== at);
				const cur = this.list[at]!;
				const subject = clipText(input['subject']);
				const activeForm = clipText(input['activeForm']);
				const patched: PlanItem = {
					...cur,
					...(subject !== '' && {content: subject}),
					...(activeForm !== '' && {activeForm}),
					...(PLAN_STATUSES.includes(input['status'] as PlanStatus) && {status: input['status'] as PlanStatus}),
				};
				return this.list.map((i, n) => (n === at ? patched : i));
			}
			case 'TaskList':
				return this.fromList(text);
			default:
				return undefined;
		}
	}

	private fromList(text: string): PlanItem[] | undefined {
		if (/^\s*No tasks found/.test(text)) return [];
		const known = new Map(this.list.filter(i => i.id !== undefined).map(i => [i.id!, i]));
		const out: PlanItem[] = [];
		for (const line of text.split('\n')) {
			const m = LIST_LINE.exec(line.trimEnd());
			if (!m) continue;
			const id = clipId(m[1]);
			if (id === '') continue;
			const old = known.get(id);
			const subject = old?.content ?? clipText((m[3] ?? '').replace(BLOCKED, ''));
			if (subject === '') continue;
			out.push({id, content: subject, status: statusOf(m[2]), ...(old?.activeForm !== undefined && {activeForm: old.activeForm})});
			if (out.length >= MAX_PLAN_ITEMS) break;
		}
		return out.length > 0 ? out : undefined;
	}
}
