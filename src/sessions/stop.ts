import type {Logger} from '../../../../src/api.js';
import {noopLog} from '../log.js';
import {readHolder, type LockInfo} from './lock.js';
import {pidAlive, procCmdline, procStart} from './proc.js';
import {requestStop} from './control.js';

// A runner is recognised in /proc/<pid>/cmdline by this path tail; the spawner must start it with
// the entry file as an argument.
export const RUNNER_ENTRY_TAIL = 'src/runner/main.ts';

export type StopDeps = {
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	alive?: (pid: number) => boolean;
	procStartOf?: (pid: number) => string | undefined;
	cmdlineOf?: (pid: number) => string[] | undefined;
	sleep?: (ms: number) => Promise<void>;
	stopRequest?: (dir: string) => Promise<void>;
	socketWaitMs?: number;
	termWaitMs?: number;
	pollMs?: number;
	log?: Logger;
};

export type StopResult = {via: 'socket' | 'signal'; ok: boolean};

const sleepFor = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** The lock file is the same lock (same process, same start), still held. */
const stillHeld = (dir: string, info: LockInfo): boolean => {
	const now = readHolder(dir);
	return now.holder !== undefined && now.holder.pid === info.pid && now.holder.procStart === info.procStart;
};

/**
 * Stops the lock holder over its control socket. A runner that does not stop in time gets SIGTERM, then
 * SIGKILL; a chat running inside another yena is only ever asked over the socket.
 */
export async function stopHolder(dir: string, holder: LockInfo, deps: StopDeps = {}): Promise<StopResult> {
	const log = deps.log ?? noopLog;
	const sleep = deps.sleep ?? sleepFor;
	const poll = deps.pollMs ?? 100;
	const waitFor = async (ms: number): Promise<boolean> => {
		for (let waited = 0; waited <= ms; waited += poll) {
			if (!stillHeld(dir, holder)) return true;
			await sleep(poll);
		}
		return !stillHeld(dir, holder);
	};

	let asked = false;
	try {
		await (deps.stopRequest ?? ((d: string) => requestStop(d)))(dir);
		asked = true;
	} catch {
		// unreachable socket: fall through to the signal path for a runner
	}
	if (asked && (await waitFor(deps.socketWaitMs ?? 5000))) {
		log.info('session stop', {where: holder.where, via: 'socket', ok: true});
		return {via: 'socket', ok: true};
	}
	if (holder.where !== 'runner') {
		log.info('session stop', {where: holder.where, via: 'socket', ok: false});
		return {via: 'socket', ok: false};
	}

	const alive = deps.alive ?? pidAlive;
	const startOf = deps.procStartOf ?? procStart;
	const cmdlineOf = deps.cmdlineOf ?? procCmdline;
	const kill = deps.kill ?? ((pid, signal) => void process.kill(pid, signal));
	// Re-checked before each signal: the pid may have been reused since the lock was written.
	const isRunner = (): boolean =>
		alive(holder.pid) &&
		startOf(holder.pid) === holder.procStart &&
		(cmdlineOf(holder.pid) ?? []).some(arg => arg.endsWith(RUNNER_ENTRY_TAIL));

	if (!isRunner()) {
		log.info('session stop', {where: holder.where, via: 'signal', ok: !stillHeld(dir, holder)});
		return {via: 'signal', ok: !stillHeld(dir, holder)};
	}
	try {
		kill(holder.pid, 'SIGTERM');
	} catch {
		// already gone
	}
	let ok = await waitFor(deps.termWaitMs ?? 3000);
	if (!ok && isRunner()) {
		try {
			kill(holder.pid, 'SIGKILL');
		} catch {
			// already gone
		}
		ok = await waitFor(1000);
	}
	// A killed runner cannot release its lock; the next acquire removes it as stale.
	if (!ok && !alive(holder.pid)) ok = true;
	log.info('session stop', {where: holder.where, via: 'signal', ok});
	return {via: 'signal', ok};
}
