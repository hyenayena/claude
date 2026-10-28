import type {BuildInfo} from '../../../../src/api.js';
import {stringCells, truncateCells} from '../kit.js';
import {SGR, type Scrub} from './present.js';

// A paw print in the same shadowed block style as the wordmark.
export const MASCOT = [
	'     ███╗ ███╗',
	'███╗ ███║ ███║ ███╗',
	'███║ ╚══╝ ╚══╝ ███║',
	'╚══╝  ███████╗ ╚══╝',
	'    ███████████╗',
	'    ╚══════════╝',
];

export const WORDMARK = [
	'██╗   ██╗███████╗███╗   ██╗ █████╗',
	'╚██╗ ██╔╝██╔════╝████╗  ██║██╔══██╗',
	' ╚████╔╝ █████╗  ██╔██╗ ██║███████║',
	'  ╚██╔╝  ██╔══╝  ██║╚██╗██║██╔══██║',
	'   ██║   ███████╗██║ ╚████║██║  ██║',
	'   ╚═╝   ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝',
];

export const PLAIN_LOGO = 'YENA';

const MAX_WIDTH = 100;
// Between the paw and the wordmark, and between the logo and the info on its right.
const ART_GAP = ' ';
const INFO_GAP = '   ';
const MODULES_LABEL = 'modules  ';
const DEV_LABEL = 'dev      ';

export type BannerInfo = {
	build?: BuildInfo;
	model?: string;
	columns: number;
};

const blockWidth = (rows: readonly string[]): number => Math.max(0, ...rows.map(stringCells));
const padTo = (s: string, cells: number): string => s + ' '.repeat(Math.max(0, cells - stringCells(s)));

const pawWithWordmark = (): string[] => {
	const paw = blockWidth(MASCOT);
	return MASCOT.map((m, i) => (padTo(m, paw) + ART_GAP + (WORDMARK[i] ?? '')).trimEnd());
};

/** The logos from widest to narrowest; the banner uses the first that fits. */
export const LOGOS: readonly (readonly string[])[] = [pawWithWordmark(), MASCOT, [PLAIN_LOGO]];

// Plain text and its style are kept apart so padding is measured on the visible cells only.
type Segment = {text: string; style?: string};
type Row = Segment[];

const rowCells = (row: Row): number => row.reduce((n, s) => n + stringCells(s.text), 0);

// Greedy wrap of `items` joined by " · ", continuation lines indented under the first item.
function wrapItems(label: string, items: string[], width: number): string[] {
	const indent = ' '.repeat(stringCells(label));
	const lines: string[] = [];
	let line = label;
	let fresh = true;
	for (const item of items) {
		const piece = fresh ? item : ` · ${item}`;
		if (!fresh && stringCells(line + piece) > width) {
			lines.push(line);
			line = indent + item;
		} else line += piece;
		fresh = false;
	}
	lines.push(line);
	return lines;
}

// The most compact form that fits `width`: the head splits into version and model, the module list
// moves under its label, and is left out when even that does not fit (`complete` is then false).
function infoLines(info: BannerInfo, scrub: Scrub, width: number): {rows: Row[]; complete: boolean} {
	const version = `yena ${scrub(info.build?.version ?? 'unknown')}`;
	const model = `model ${scrub(info.model ?? 'default')}`;
	const head = `${version} · ${model}`;
	const rows: Row[] =
		stringCells(head) <= width ? [[{text: head, style: SGR.bold}]] : [[{text: version, style: SGR.bold}], [{text: model, style: SGR.bold}]];
	if (info.build?.root?.mode === 'dev') rows.push([{text: DEV_LABEL, style: SGR.dim}, {text: scrub(info.build.root.path), style: SGR.yellow}]);
	const modules = (info.build?.modules ?? []).map(m => `${scrub(m.name)} ${scrub(m.version)}`);
	if (modules.length === 0) return {rows, complete: true};
	const fits = (lines: string[]): boolean => lines.every(l => stringCells(l) <= width);
	const beside = wrapItems(MODULES_LABEL, modules, width);
	if (fits(beside)) {
		const list = beside.map((line, i): Row =>
			i === 0 ? [{text: MODULES_LABEL, style: SGR.dim}, {text: line.slice(MODULES_LABEL.length)}] : [{text: line}],
		);
		return {rows: [...rows, ...list], complete: true};
	}
	const under = wrapItems('', modules, width);
	if (!fits(under)) return {rows, complete: false};
	return {rows: [...rows, [{text: MODULES_LABEL.trimEnd(), style: SGR.dim}], ...under.map((line): Row => [{text: line}])], complete: true};
}

const truncateRow = (row: Row, width: number): Row => {
	let left = width;
	return row.map(s => {
		const text = truncateCells(s.text, Math.max(0, left));
		left -= stringCells(text);
		return {...s, text};
	});
};

/**
 * The box shown at the top of a new chat: the widest logo that fits (paw with wordmark, paw, or the
 * plain word), with the versions and model on its right when all of it fits there, else below it.
 */
export function formatBanner(info: BannerInfo, scrub: Scrub): string {
	const width = Math.min(Math.max(info.columns, 0), MAX_WIDTH);
	const inner = width - 4;
	if (inner < PLAIN_LOGO.length) return '';
	const logo = LOGOS.find(l => blockWidth(l) <= inner)!;
	const logoWidth = blockWidth(logo);
	const logoStyle = logo.length === 1 ? SGR.bold + SGR.yellow : SGR.yellow;

	const rightWidth = inner - logoWidth - INFO_GAP.length;
	// The right side takes the info only whole: a module list it would have to drop goes below instead.
	const side = rightWidth > 0 ? infoLines(info, scrub, rightWidth) : {rows: [], complete: false};
	const right = side.rows;
	const fitsRight = side.complete && right.length > 0 && right.length <= logo.length && right.every(r => rowCells(r) <= rightWidth);

	let rows: Row[];
	if (fitsRight) {
		const top = Math.floor((logo.length - right.length) / 2);
		rows = logo.map((l, i) => {
			const side = right[i - top];
			return side ? [{text: padTo(l, logoWidth), style: logoStyle}, {text: INFO_GAP}, ...side] : [{text: l, style: logoStyle}];
		});
	} else {
		rows = [...logo.map(l => [{text: l, style: logoStyle}]), [], ...infoLines(info, scrub, inner).rows.map(r => truncateRow(r, inner))];
	}

	const border = (s: string): string => `${SGR.dim}${s}${SGR.reset}`;
	const paint = (s: Segment): string => (s.style && s.text ? `${s.style}${s.text}${SGR.reset}` : s.text);
	const body = rows.map(r => `${border('│')} ${r.map(paint).join('')}${' '.repeat(inner - rowCells(r))} ${border('│')}`);
	return [border(`╭${'─'.repeat(inner + 2)}╮`), ...body, border(`╰${'─'.repeat(inner + 2)}╯`)].join('\n');
}
