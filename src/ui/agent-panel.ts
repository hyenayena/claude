import {boxRows, frameAround, gridLayout, joinBlocks, type BoxBadge, type SpanRow} from '../kit.js';
import type {AgentBox, AgentEntry, AgentsState} from './agents.js';
import {shortModel, toolOneLiner, verbFor, type Scrub} from './present.js';

export type PanelLook = {columns: number; rows: number; scrub: Scrub; spinner?: string; corner?: string};

type Place = {id: string; x0: number; x1: number};
type Unit = {lines: SpanRow[]; places: Place[]};

export type PanelLayout = {
	height: number;
	rows: SpanRow[];
	ids: string[];
	visibleIds: string[];
	scroll: number;
	maxScroll: number;
	units: readonly {places: readonly Place[]}[];
	hit(x: number, y: number): string | undefined;
};

export const PANEL = {
	minRows: 12,
	share: 0.4,
	minWidth: 12,
	minBoxWidth: 28,
	fullHeight: 7,
	shortHeight: 4,
	tinyHeight: 3,
} as const;

const EMPTY: PanelLayout = {height: 0, rows: [], ids: [], visibleIds: [], scroll: 0, maxScroll: 0, units: [], hit: () => undefined};

const GLYPH: Record<AgentBox['status'], string> = {running: '', completed: '✓', failed: '✗', stopped: '■'};
const BADGE: Record<Exclude<AgentBox['status'], 'running'>, BoxBadge> = {
	completed: {word: 'DONE', tone: 'add'},
	failed: {word: 'FAILED', tone: 'del'},
	stopped: {word: 'STOPPED', tone: 'warn'},
};

const firstLine = (text: string): string => (text.split('\n').find(l => l.trim() !== '') ?? '').trim();

const entryLine = (e: AgentEntry, scrub: Scrub): SpanRow | undefined => {
	switch (e.kind) {
		case 'text':
			return [{text: `● ${firstLine(scrub(e.text))}`, tone: 'dim'}];
		case 'notice':
			return [{text: firstLine(scrub(e.text)), tone: 'dim'}];
		case 'tool':
			return [{text: firstLine(toolOneLiner(e.name, e.input, scrub)), ...(e.isError === true && {tone: 'del' as const})}];
		case 'thinking':
			return undefined;
	}
};

const bodyOf = (box: AgentBox, height: number, look: PanelLook): SpanRow[] => {
	const room = Math.max(0, height - 2 - 1);
	const lines: SpanRow[] = [];
	for (let i = box.history.length - 1; i >= 0 && lines.length < room; i--) {
		const line = entryLine(box.history[i]!, look.scrub);
		if (line) lines.unshift(line);
	}
	if (lines.length === 0 && room > 0 && box.description !== '') lines.push([{text: firstLine(look.scrub(box.description)), tone: 'dim'}]);
	return [...lines, [{text: `${look.corner ?? '◰'} ${verbFor(box.id, box.history.length)}…`, tone: 'dim'}]];
};

const renderBox = (state: AgentsState, box: AgentBox, width: number, height: number, look: PanelLook): SpanRow[] => {
	const running = box.status === 'running';
	const name = look.scrub(box.name);
	const lead = running ? (look.spinner ?? '✻') : GLYPH[box.status];
	const parent = box.parent !== undefined ? state.boxes.get(box.parent) : undefined;
	const calls = state.order.filter(id => state.boxes.get(id)?.parent === box.id).length;
	const footer = [parent ? `by ${look.scrub(parent.name)}` : '', calls > 0 ? `calls ${calls}` : ''].filter(Boolean).join(' · ');
	const highlight = state.open === box.id ? ('open' as const) : state.selected === box.id ? ('selected' as const) : undefined;
	return boxRows({
		width,
		height,
		title: [{text: `${lead} `, ...(running && {tone: 'info' as const})}, {text: name, bold: true}],
		...(box.model !== undefined && {meta: shortModel(box.model, look.scrub)}),
		...(footer !== '' && {footer}),
		body: running ? bodyOf(box, height, look) : [],
		...(box.status !== 'running' && {tone: 'dim' as const, badge: BADGE[box.status]}),
		...(highlight !== undefined && {highlight}),
	});
};

const gridUnits = (state: AgentsState, list: AgentBox[], width: number, height: number, look: PanelLook, offset: number): Unit[] => {
	const grid = gridLayout({count: list.length, width, minBoxWidth: PANEL.minBoxWidth});
	return grid.rows.map(row => {
		const boxes = list.slice(row.start, row.start + row.count);
		const places: Place[] = [];
		let x = offset;
		boxes.forEach((b, i) => {
			const w = row.widths[i]!;
			places.push({id: b.id, x0: x, x1: x + w});
			x += w;
		});
		const blocks = boxes.map((b, i) => renderBox(state, b, row.widths[i]!, height, look));
		return {lines: joinBlocks(blocks, row.widths), places};
	});
};

type Band = {kind: 'grid'; boxes: AgentBox[]} | {kind: 'group'; root: AgentBox; boxes: AgentBox[]};

const bandsOf = (state: AgentsState): Band[] => {
	const all = state.order.map(id => state.boxes.get(id)).filter((b): b is AgentBox => b !== undefined);
	const isRoot = (b: AgentBox) => b.parent === undefined || !state.boxes.has(b.parent);
	const lone: AgentBox[] = [];
	const groups: Band[] = [];
	for (const root of all.filter(isRoot)) {
		const members = [root];
		for (let i = 0; i < members.length; i++) for (const b of all) if (b.parent === members[i]!.id && !members.includes(b)) members.push(b);
		if (members.length === 1) lone.push(root);
		else groups.push({kind: 'group', root, boxes: members});
	}
	return [...(lone.length > 0 ? [{kind: 'grid' as const, boxes: lone}] : []), ...groups];
};

const unitsFor = (state: AgentsState, bands: Band[], width: number, height: number, look: PanelLook): Unit[] => {
	const units: Unit[] = [];
	for (const band of bands) {
		if (band.kind === 'grid') {
			units.push(...gridUnits(state, band.boxes, width, height, look, 0));
			continue;
		}
		const inner = gridUnits(state, band.boxes, width - 2, height, look, 1);
		const framed = frameAround(
			inner.flatMap(u => u.lines),
			width,
			{title: `${look.scrub(band.root.name)} · ${band.boxes.length} agents`},
		);
		units.push({lines: [framed[0]!], places: []});
		let at = 1;
		for (const u of inner) {
			units.push({lines: framed.slice(at, at + u.lines.length), places: u.places});
			at += u.lines.length;
		}
		units.push({lines: [framed[framed.length - 1]!], places: []});
	}
	return units;
};

const linesOf = (units: Unit[]): number => units.reduce((n, u) => n + u.lines.length, 0);

const windowFrom = (units: Unit[], budget: number, start: number): number => {
	let used = start > 0 ? 1 : 0;
	let end = start;
	while (end < units.length) {
		const more = end + 1 < units.length ? 1 : 0;
		if (used + units[end]!.lines.length + more > budget) break;
		used += units[end]!.lines.length;
		end++;
	}
	return end;
};

const countBoxes = (units: Unit[]): number => units.reduce((n, u) => n + u.places.length, 0);

const fitUnits = (state: AgentsState, look: PanelLook): {units: Unit[]; budget: number; fits: boolean} | undefined => {
	const width = Math.floor(look.columns) - 1;
	if (state.boxes.size === 0 || !(look.rows >= PANEL.minRows) || !(width >= PANEL.minWidth)) return undefined;
	const budget = Math.floor(look.rows * PANEL.share);
	const bands = bandsOf(state);
	let units = unitsFor(state, bands, width, PANEL.fullHeight, look);
	if (linesOf(units) > budget) units = unitsFor(state, bands, width, PANEL.shortHeight, look);
	if (linesOf(units) > budget && budget < PANEL.shortHeight + 2) units = unitsFor(state, bands, width, PANEL.tinyHeight, look);
	return {units, budget, fits: linesOf(units) <= budget};
};

const maxScrollOf = (units: Unit[], budget: number): number => {
	let max = 0;
	while (max < units.length - 1 && windowFrom(units, budget, max) < units.length) max++;
	return max;
};

const clampScroll = (scroll: number, max: number): number => Math.min(Math.max(0, Math.floor(scroll) || 0), max);

export function revealAgent(state: AgentsState, look: PanelLook): AgentsState {
	const fit = fitUnits(state, look);
	const target = state.open ?? state.selected;
	if (!fit || fit.fits || target === undefined) return state;
	const {units, budget} = fit;
	const u = units.findIndex(unit => unit.places.some(p => p.id === target));
	if (u < 0) return state;
	let scroll = clampScroll(state.scroll, maxScrollOf(units, budget));
	if (u < scroll) scroll = u > 0 && units[u - 1]!.places.length === 0 ? u - 1 : u;
	while (scroll < u && windowFrom(units, budget, scroll) <= u) scroll++;
	return scroll === state.scroll ? state : {...state, scroll};
}

export function layoutPanel(state: AgentsState, look: PanelLook): PanelLayout {
	const fit = fitUnits(state, look);
	if (!fit) return EMPTY;
	const {units, budget, fits} = fit;
	const ids = units.flatMap(u => u.places.map(p => p.id));

	let scroll = 0;
	let end = units.length;
	let maxScroll = 0;
	if (!fits) {
		maxScroll = maxScrollOf(units, budget);
		scroll = clampScroll(state.scroll, maxScroll);
		end = windowFrom(units, budget, scroll);
		if (end === scroll) end = scroll + 1;
	}

	const shown = units.slice(scroll, end);
	const rows: SpanRow[] = [];
	const cells: Place[][] = [];
	const above = countBoxes(units.slice(0, scroll));
	const below = countBoxes(units.slice(end));
	const room = budget - (scroll > 0 ? 1 : 0) - (end < units.length ? 1 : 0);
	const indicators = !fits && linesOf(shown) <= room;
	if (indicators && scroll > 0) {
		rows.push([{text: above > 0 ? `↑ ${above} more` : '↑', tone: 'dim'}]);
		cells.push([]);
	}
	for (const u of shown) {
		for (const line of u.lines) {
			rows.push(line);
			cells.push(u.places);
		}
	}
	if (indicators && end < units.length) {
		rows.push([{text: below > 0 ? `↓ ${below} more` : '↓', tone: 'dim'}]);
		cells.push([]);
	}
	const capped = rows.slice(0, budget);
	return {
		height: capped.length,
		rows: capped,
		ids,
		visibleIds: shown.flatMap(u => u.places.map(p => p.id)),
		scroll,
		maxScroll,
		units: units.map(u => ({places: u.places})),
		hit: (x, y) => {
			if (!Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= capped.length) return undefined;
			return cells[y]!.find(p => x >= p.x0 && x < p.x1)?.id;
		},
	};
}

export type PanelMove = 'left' | 'right' | 'up' | 'down';

export function navigate(layout: PanelLayout, from: string, move: PanelMove): string | undefined {
	const at = layout.ids.indexOf(from);
	if (at < 0) return layout.ids[0];
	if (move === 'left') return layout.ids[Math.max(0, at - 1)];
	if (move === 'right') return layout.ids[Math.min(layout.ids.length - 1, at + 1)];
	const unit = layout.units.findIndex(u => u.places.some(p => p.id === from));
	const place = layout.units[unit]!.places.find(p => p.id === from)!;
	const step = move === 'up' ? -1 : 1;
	let next = unit + step;
	while (next >= 0 && next < layout.units.length && layout.units[next]!.places.length === 0) next += step;
	if (next < 0) return undefined;
	if (next >= layout.units.length) return from;
	const center = (place.x0 + place.x1) / 2;
	let best = layout.units[next]!.places[0]!;
	for (const p of layout.units[next]!.places) if (Math.abs((p.x0 + p.x1) / 2 - center) < Math.abs((best.x0 + best.x1) / 2 - center)) best = p;
	return best.id;
}
