import {allDone, clipId, clipText, MAX_PLAN_ID, MAX_PLAN_ITEMS, parseTodos, PLAN_STATUSES, PLAN_TOOLS, type PlanItem, type PlanStatus, statusOf, type UiEvent} from '../deps/chat.js';

export const MAX_PLAN_PENDING = 64;
const CREATED = new RegExp(`^Task #([\\w.-]{1,${MAX_PLAN_ID}}) created successfully`);
const LIST_LINE = /^#(\S+) \[(pending|in_progress|completed)\] (.*)$/;
const BLOCKED = / \[blocked by [^\]]*\]$/;

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
