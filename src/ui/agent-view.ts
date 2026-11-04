import {wrapLines} from '../kit.js';
import type {AgentBox, AgentEntry} from './agents.js';
import {formatNotice, formatOut, formatThinkingText, formatUserLine, sgr, type Scrub} from './present.js';
import {formatToolGroup, runningToolRow} from './tool-card.js';
import {isFoldable} from './tool-kind.js';
import {glyph} from '../kit.js';
import type {ToolOut} from './transcript.js';

const blockOf = (e: AgentEntry, scrub: Scrub, reveal: Scrub, width: number): string => {
	switch (e.kind) {
		case 'text':
			return formatOut({kind: 'assistant', text: e.text, interrupted: false}, scrub, reveal, width);
		case 'thinking':
			return formatThinkingText(e.text, scrub);
		case 'notice':
			return formatNotice(e.text, scrub);
		case 'tool':
			if (!e.done) return runningToolRow({id: e.toolUseId, name: e.name, input: e.input, elapsedSeconds: 0}, scrub, width, `${sgr().muted}${glyph('bullet')}${sgr().reset}`, 0);
			return formatOut(
				{kind: 'tool', name: e.name, input: e.input, isError: e.isError === true, text: e.text ?? '', ...(e.patch !== undefined && {patch: e.patch})},
				scrub,
				reveal,
				width,
			);
	}
};

const lastText = (box: AgentBox): string | undefined => {
	for (let i = box.history.length - 1; i >= 0; i--) {
		const e = box.history[i]!;
		if (e.kind === 'text') return e.text;
		if (e.kind === 'tool') return undefined;
	}
	return undefined;
};

const foldableEntry = (e: AgentEntry): e is Extract<AgentEntry, {kind: 'tool'}> => e.kind === 'tool' && e.done && e.isError !== true && isFoldable(e.name);

const toolOut = (e: Extract<AgentEntry, {kind: 'tool'}>): ToolOut => ({kind: 'tool', name: e.name, input: e.input, isError: false, text: e.text ?? ''});

// Runs of two or more finished Read/Grep/Glob/LS calls become one row, as in the main chat.
function foldedHistory(history: readonly AgentEntry[]): (AgentEntry | ToolOut[])[] {
	const out: (AgentEntry | ToolOut[])[] = [];
	let run: Extract<AgentEntry, {kind: 'tool'}>[] = [];
	const flush = (): void => {
		if (run.length >= 2) out.push(run.map(toolOut));
		else out.push(...run);
		run = [];
	};
	for (const e of history) {
		if (foldableEntry(e)) run.push(e);
		else {
			flush();
			out.push(e);
		}
	}
	flush();
	return out;
}

export function agentViewBlocks(box: AgentBox, scrub: Scrub, reveal: Scrub, width: number): string[] {
	const sg = sgr();
	const blocks: string[] = [];
	if (box.prompt.trim() !== '') blocks.push(formatUserLine(box.prompt, scrub));
	if (box.dropped > 0) blocks.push(`${sg.muted}… ${box.dropped} earlier message${box.dropped === 1 ? '' : 's'}${sg.reset}`);
	for (const item of foldedHistory(box.history)) {
		blocks.push(Array.isArray(item) ? formatToolGroup(item, scrub, width) : blockOf(item, scrub, reveal, width));
	}
	if (box.report !== undefined && box.report.trim() !== lastText(box)?.trim()) {
		blocks.push(formatOut({kind: 'assistant', text: box.report, interrupted: false}, scrub, reveal, width));
	}
	return blocks;
}

const cache = new WeakMap<AgentBox, {width: number; length: number; rows: string[]}>();

export function agentViewLines(box: AgentBox, scrub: Scrub, reveal: Scrub, width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const hit = cache.get(box);
	if (hit && hit.width === w && hit.length === box.history.length) return hit.rows;
	const lines = agentViewBlocks(box, scrub, reveal, w).flatMap((block, i) => [...(i > 0 ? [''] : []), ...block.split('\n')]);
	const rows = wrapLines(lines, w, {mode: 'char'});
	cache.set(box, {width: w, length: box.history.length, rows});
	return rows;
}
