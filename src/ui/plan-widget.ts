import {checklistRows, type ChecklistItem} from '../kit.js';
import type {PlanItem} from '../chat/plan.js';
import type {Scrub} from './tool-args.js';

export const PLAN = {
	minRows: 10,
	minColumns: 30,
	summaryMinRows: 24,
	expandedMax: 10,
	expandedShare: 0.3,
	flashMs: 3000,
	meterMax: 10,
} as const;

export type PlanFlash = {text: string; until: number};

export type PlanView = {
	items: readonly PlanItem[];
	running: boolean;
	stale: boolean;
	expanded: boolean;
	flash?: PlanFlash;
};

export type PlanLook = {columns: number; rows: number; scrub: Scrub; spinner?: string; now: number};

const TITLE = 'Plan';

export const planDone = (items: readonly PlanItem[]): boolean => items.length > 0 && items.every(i => i.status === 'completed');

export function planVisible(view: PlanView): boolean {
	if (view.items.length === 0 || view.stale) return false;
	return view.running || !planDone(view.items);
}

function entries(items: readonly PlanItem[], scrub: Scrub): ChecklistItem[] {
	return items.map(i => ({
		text: scrub(i.status === 'in_progress' ? (i.activeForm ?? i.content) : i.content),
		state: i.status === 'completed' ? 'done' : i.status === 'in_progress' ? 'active' : 'open',
	}));
}

export function planWidgetRows(view: PlanView, look: PlanLook): string[] {
	if (!planVisible(view) || look.rows < PLAN.minRows || look.columns < PLAN.minColumns) return [];
	const width = Math.max(1, look.columns - 1);
	const live = view.flash !== undefined && look.now < view.flash.until ? view.flash : undefined;
	const base = {
		title: TITLE,
		items: entries(view.items, look.scrub),
		width,
		...(view.running && look.spinner !== undefined && {spinner: look.spinner}),
		...(live !== undefined && {flash: look.scrub(live.text)}),
		doneLabel: 'done',
	};
	if (view.expanded) {
		const maxRows = Math.min(PLAN.expandedMax, Math.floor(look.rows * PLAN.expandedShare));
		if (maxRows >= 2) return checklistRows({...base, mode: 'full', maxRows});
	}
	return checklistRows({...base, mode: look.rows < PLAN.summaryMinRows ? 'line' : 'summary'});
}

export function planViewerRows(items: readonly PlanItem[], width: number, scrub: Scrub): string[] {
	if (items.length === 0) return [];
	return checklistRows({title: TITLE, items: entries(items, scrub), width: Math.max(1, width), mode: 'full', doneLabel: 'done'});
}
