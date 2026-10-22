import {spawn} from 'node:child_process';
import {realpathSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';
import {noopLog} from '../log.js';
import {readHolder} from '../sessions/lock.js';
import {RUNNER_ENTRY_TAIL} from '../sessions/stop.js';

export const RUNNER_SOCKET = 'runner.sock';
export const runnerSocketPath = (dir: string): string => path.join(dir, RUNNER_SOCKET);

const START_ERROR = 'Could not start the background chat';
const POLL_MS = 50;

export type SpawnRunnerOptions = {
	moduleDir: string;
	sessionDir: string;
	env: NodeJS.ProcessEnv;
	log?: Logger;
	timeoutMs?: number;
};

// The entry is resolved through realpath so a symlinked src/ cannot point the spawn outside the module.
const entryPath = (moduleDir: string): string => {
	const root = realpathSync(moduleDir);
	const entry = realpathSync(path.join(root, RUNNER_ENTRY_TAIL));
	if (!entry.startsWith(root + path.sep)) throw new Error(START_ERROR);
	return entry;
};

const accepts = (file: string): Promise<boolean> =>
	new Promise(resolve => {
		const s = net.createConnection(file);
		s.once('connect', () => {
			s.destroy();
			resolve(true);
		});
		s.once('error', () => resolve(false));
	});

/** Starts a detached runner for the chat and resolves once it listens and holds the session lock. */
export async function spawnRunner(opts: SpawnRunnerOptions): Promise<{socketPath: string; pid: number}> {
	const log = opts.log ?? noopLog;
	const started = Date.now();
	const socketPath = runnerSocketPath(opts.sessionDir);
	let entry: string;
	try {
		entry = entryPath(opts.moduleDir);
	} catch {
		log.warn('runner spawn failed', {reason: 'entry'});
		throw new Error(START_ERROR);
	}
	const child = spawn(process.execPath, ['--import', 'tsx', entry], {
		cwd: process.cwd(),
		detached: true,
		stdio: 'ignore',
		env: {...opts.env, YENA_RUNNER_DIR: opts.sessionDir},
	});
	child.unref();
	let exited = false;
	let spawnError = false;
	child.once('exit', () => {
		exited = true;
	});
	child.once('error', () => {
		spawnError = true;
	});

	const fail = (reason: string): Error => {
		if (!exited && child.pid !== undefined) {
			try {
				process.kill(child.pid, 'SIGKILL');
			} catch {
				// already gone
			}
		}
		log.warn('runner spawn failed', {reason});
		return new Error(START_ERROR);
	};

	const deadline = started + (opts.timeoutMs ?? 10_000);
	for (;;) {
		if (spawnError) throw fail('spawn');
		if (exited) throw fail('exited');
		const pid = child.pid;
		if (pid !== undefined && (await accepts(socketPath))) {
			const holder = readHolder(opts.sessionDir).holder;
			if (holder && holder.pid === pid && holder.where === 'runner') {
				log.info('runner spawned', {ms: Date.now() - started});
				return {socketPath, pid};
			}
		}
		if (Date.now() >= deadline) throw fail('timeout');
		await new Promise(r => setTimeout(r, POLL_MS));
	}
}
