import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import type {UiEvent} from './events.js';

type Loose = Record<string, unknown>;

const TOOL_RESULT_CAP = 64 * 1024;

const isRecord = (v: unknown): v is Loose => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const resultText = (content: unknown): string => {
	let text: string;
	if (typeof content === 'string') text = content;
	else if (Array.isArray(content)) {
		text = content
			.filter(isRecord)
			.map(b => (b['type'] === 'text' ? (str(b['text']) ?? '') : b['type'] === 'image' ? '[image]' : ''))
			.filter(s => s !== '')
			.join('\n');
	} else text = '';
	return text.length > TOOL_RESULT_CAP ? text.slice(0, TOOL_RESULT_CAP) : text;
};

const blocks = (msg: Loose): Loose[] => {
	const inner = msg['message'];
	if (!isRecord(inner) || !Array.isArray(inner['content'])) return [];
	return inner['content'].filter(isRecord);
};

const fromSystem = (msg: Loose): UiEvent[] => {
	switch (msg['subtype']) {
		case 'init': {
			const sessionId = str(msg['session_id']);
			if (!sessionId) return [];
			const model = str(msg['model']);
			const apiKeySource = str(msg['apiKeySource']);
			const commands = msg['slash_commands'];
			const slashCommands = Array.isArray(commands) ? commands.filter((c): c is string => typeof c === 'string') : undefined;
			return [
				{
					kind: 'session',
					sessionId,
					...(model !== undefined && {model}),
					...(apiKeySource !== undefined && {apiKeySource}),
					...(slashCommands !== undefined && {slashCommands}),
				},
			];
		}
		case 'task_started':
		case 'task_progress':
		case 'task_notification': {
			const id = str(msg['task_id']);
			if (!id) return [];
			const status = msg['subtype'] === 'task_notification' ? str(msg['status']) : 'running';
			if (status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'stopped') return [];
			const description = str(msg['description']);
			const summary = str(msg['summary']);
			return [
				{
					kind: 'task',
					id,
					status,
					...(description !== undefined && {description}),
					...(msg['is_backgrounded'] === true && {background: true}),
					...(summary !== undefined && {summary}),
				},
			];
		}
		case 'local_command_output':
		case 'informational': {
			// Output of a Claude Code command run from the console; info-level banners stay hidden as in Claude Code.
			const content = str(msg['content']);
			if (!content || msg['level'] === 'info') return [];
			return [{kind: 'text', messageId: str(msg['uuid']) ?? 'local', text: content}];
		}
		case 'status': {
			const s = msg['status'];
			if (s === null || s === 'compacting' || s === 'requesting') return [{kind: 'status', status: s}];
			return [];
		}
		case 'api_retry': {
			const code = str(msg['error']);
			return [
				{
					kind: 'retry',
					attempt: num(msg['attempt']) ?? 0,
					maxRetries: num(msg['max_retries']) ?? 0,
					delayMs: num(msg['retry_delay_ms']) ?? 0,
					...(code !== undefined && {errorCode: code}),
				},
			];
		}
		default:
			return [];
	}
};

const fromStream = (msg: Loose): UiEvent[] => {
	const ev = msg['event'];
	if (!isRecord(ev)) return [];
	if (ev['type'] === 'content_block_delta') {
		const d = ev['delta'];
		if (isRecord(d) && d['type'] === 'text_delta') {
			const text = str(d['text']);
			return text ? [{kind: 'text-delta', text}] : [];
		}
		return [];
	}
	if (ev['type'] === 'content_block_start') {
		const b = ev['content_block'];
		if (isRecord(b) && (b['type'] === 'thinking' || b['type'] === 'redacted_thinking')) return [{kind: 'thinking'}];
	}
	return [];
};

const fromAssistant = (msg: Loose): UiEvent[] => {
	const err = str(msg['error']);
	if (err) return [{kind: 'api-error', code: err}];
	const inner = isRecord(msg['message']) ? msg['message'] : {};
	const messageId = str(inner['id']) ?? str(msg['uuid']) ?? '';
	const out: UiEvent[] = [];
	for (const b of blocks(msg)) {
		if (b['type'] === 'thinking') {
			const thought = str(b['thinking']);
			if (thought && thought.trim()) out.push({kind: 'thinking-text', text: thought});
		} else if (b['type'] === 'text') {
			const text = str(b['text']);
			if (text) out.push({kind: 'text', messageId, text, ...(msg['aborted'] === true && {aborted: true})});
		} else if (b['type'] === 'tool_use') {
			const toolUseId = str(b['id']);
			if (toolUseId) out.push({kind: 'tool-use', toolUseId, name: str(b['name']) ?? '', input: b['input']});
		}
	}
	return out;
};

const agentActivity = (parent: string, msg: Loose): UiEvent[] => {
	const uses = blocks(msg).filter(b => b['type'] === 'tool_use');
	const last = uses.at(-1);
	if (!last) return [];
	return [{kind: 'agent-activity', toolUseId: parent, name: str(last['name']) ?? '', input: last['input']}];
};

const fromUser = (msg: Loose): UiEvent[] => {
	const out: UiEvent[] = [];
	for (const b of blocks(msg)) {
		if (b['type'] !== 'tool_result') continue;
		const toolUseId = str(b['tool_use_id']);
		if (!toolUseId) continue;
		out.push({kind: 'tool-result', toolUseId, isError: b['is_error'] === true, text: resultText(b['content'])});
	}
	return out;
};

const fromResult = (msg: Loose): UiEvent[] => {
	const subtype = str(msg['subtype']) ?? 'unknown';
	const ok = subtype === 'success' && msg['is_error'] !== true;
	const text = str(msg['result']);
	const errors = Array.isArray(msg['errors']) ? msg['errors'].map(String) : undefined;
	const sessionId = str(msg['session_id']);
	const costUsd = num(msg['total_cost_usd']);
	const numTurns = num(msg['num_turns']);
	const terminalReason = str(msg['terminal_reason']);
	return [
		{
			kind: 'result',
			ok,
			subtype,
			...(text !== undefined && {text}),
			...(errors !== undefined && {errors}),
			...(sessionId !== undefined && {sessionId}),
			...(costUsd !== undefined && {costUsd}),
			...(numTurns !== undefined && {numTurns}),
			...(terminalReason !== undefined && {terminalReason}),
		},
	];
};

export const normalize = (message: SDKMessage): UiEvent[] => {
	const msg = message as unknown as Loose;
	if (!isRecord(msg)) return [];
	const parent = msg['parent_tool_use_id'];
	// Subagent messages are not shown; only their latest tool call, next to the Agent call that runs them.
	if (parent != null) return typeof parent === 'string' && msg['type'] === 'assistant' ? agentActivity(parent, msg) : [];
	switch (msg['type']) {
		case 'system':
			return fromSystem(msg);
		case 'stream_event':
			return fromStream(msg);
		case 'assistant':
			return fromAssistant(msg);
		case 'user':
			return fromUser(msg);
		case 'tool_progress': {
			const toolUseId = str(msg['tool_use_id']);
			if (!toolUseId) return [];
			return [
				{
					kind: 'tool-progress',
					toolUseId,
					name: str(msg['tool_name']) ?? '',
					elapsedSeconds: num(msg['elapsed_time_seconds']) ?? 0,
				},
			];
		}
		case 'result':
			return fromResult(msg);
		default:
			return [];
	}
};
