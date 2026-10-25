import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';
import type {ChatState} from './events.js';

export type StatusSnapshot = {
	state: ChatState;
	sessionId: string | undefined;
	tasks: readonly {status: string; taskType?: string}[];
};

/** What `./yena kill` prints for a process with an open chat, e.g. `chat 9cc5de25: working, 2 subagents`. */
export function statusLine(s: StatusSnapshot): string {
	const id = (s.sessionId ?? '').replace(/[^0-9a-f]/gi, '').slice(0, 8) || 'new';
	if (s.state !== 'running') return `chat ${id}: idle`;
	const agents = s.tasks.filter(t => t.status === 'running' && t.taskType === 'local_agent').length;
	return agents > 0 ? `chat ${id}: working, ${agents} ${agents === 1 ? 'subagent' : 'subagents'}` : `chat ${id}: working`;
}

export type ProcessStatus = {set: (line: string) => void; clear: () => void};

/**
 * Keeps `<dir>/<pid>` holding one line about this process for `./yena kill` (the yena script sets
 * YENA_STATUS_DIR). Without a directory it does nothing; a failed write is logged once and the chat goes on.
 */
export function createProcessStatus(dir: string | undefined, log: Logger, pid = process.pid): ProcessStatus {
	if (!dir) return {set() {}, clear() {}};
	const file = path.join(dir, String(pid));
	let last: string | undefined;
	let warned = false;
	return {
		set(line) {
			if (line === last) return;
			try {
				mkdirSync(dir, {recursive: true, mode: 0o700});
				const tmp = `${file}.tmp`;
				writeFileSync(tmp, `${line}\n`, {mode: 0o600});
				renameSync(tmp, file);
				last = line;
			} catch (err) {
				if (!warned) log.warn('process status write failed', {err});
				warned = true;
			}
		},
		clear() {
			last = undefined;
			try {
				rmSync(file, {force: true});
			} catch (err) {
				log.warn('process status remove failed', {err});
			}
		},
	};
}
