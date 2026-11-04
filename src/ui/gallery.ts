import type {GallerySection} from '../kit.js';

const scrub = (s: string): string => s;

const todos = [
	{content: 'Read the parser', status: 'completed' as const},
	{content: 'Patch parse()', status: 'in_progress' as const, activeForm: 'Patching parse()'},
	{content: 'Run the tests', status: 'pending' as const},
];

const patch = {hunks: [{oldStart: 11, newStart: 11, lines: [' const rows = split(text);', '-return rows[0];', '+return rows.at(0) ?? "";']}]};

// present.ts stays out of the plugin start: it is loaded when the gallery is shown.
export const chatGallerySection: GallerySection = {
	name: 'chat',
	title: 'Chat transcript',
	description: 'The pieces of the claude chat as they are drawn today',
	load: async () => {
		const p = await import('./present.js');
		return ({width}) => {
			const blocks = [
				p.formatUserLine('Fix the failing test in parse.ts', scrub),
				p.formatAssistantBlock('Here is the plan:\n\n- read the **test**\n- patch `parse()`', scrub, false, width),
				p.formatThinking('Looking at the parser first.', scrub),
				p.formatToolBlock({name: 'Edit', input: {file_path: 'src/parse.ts', old_string: 'return rows[0];', new_string: 'return rows.at(0) ?? "";'}, isError: false, text: '', patch}, scrub, width),
				p.formatToolBlock({name: 'Bash', input: {command: 'npm test'}, isError: true, text: '1 test failed'}, scrub, width),
				p.todoLines(todos, scrub, 4).join('\n'),
				p.formatNotice('Notice: the model is unchanged', scrub),
				p.formatWarning('Warning: the session is almost full', scrub),
				p.formatError('The request failed', scrub),
			];
			return blocks.flatMap(b => b.split('\n'));
		};
	},
};

const editPatch = {
	hunks: [
		{oldStart: 11, newStart: 11, lines: [' const rows = split(text);', '-const first = rows[0];', '+const first = rows.at(0) ?? "";', ' return first.trim();']},
		{oldStart: 48, newStart: 48, lines: [' function split(text: string): string[] {', '-\treturn text.split("\\n");', '+\treturn text.split(/\\r?\\n/);', '+\t// keeps empty lines', ' }']},
	],
};

const newFile = [
	'import {readFileSync} from "node:fs";',
	'',
	'export type Row = {id: number; name: string};',
	'',
	'export function load(path: string): Row[] {',
	'\tconst text = readFileSync(path, "utf8");',
	'\t// one JSON object per line',
	'\treturn text.split("\\n").filter(Boolean).map((line, i) => ({id: i + 1, ...JSON.parse(line)}));',
	'}',
	'',
	'export const LIMIT = 100;',
	'export default load;',
].join('\n');

const longPatch = {hunks: [{oldStart: 1, newStart: 1, lines: Array.from({length: 60}, (_, i) => `+export const value${i} = ${i * 7};`)}]};

export const diffGallerySection: GallerySection = {
	name: 'diff',
	title: 'File changes',
	description: 'Edit and Write results as file cards: tinted lines, word and syntax colours, folds',
	load: async () => {
		const [card, hl, p] = await Promise.all([import('./file-card.js'), import('./highlight.js'), import('./present.js')]);
		await hl.preloadHighlighter();
		const edit = {name: 'Edit', input: {file_path: 'src/parse.ts'}, isError: false, patch: editPatch};
		const created = {name: 'Write', input: {file_path: 'src/load.ts', content: newFile}, isError: false, patch: {hunks: [], created: true as const}};
		const long = {name: 'Edit', input: {file_path: 'src/values.ts'}, isError: false, patch: longPatch};
		return ({width}) => {
			const unified = card.formatFileCard(edit, scrub, Math.min(width, 158));
			const side =
				width >= 159 ? card.formatFileCard(edit, scrub, width) : `${p.sgr().muted}side-by-side from 160 columns${p.sgr().reset}`;
			const blocks = [unified, side, card.formatFileCard(created, scrub, width), card.formatFileCard(long, scrub, width)];
			return blocks.flatMap(b => b.split('\n'));
		};
	},
};
