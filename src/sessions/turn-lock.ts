import type {Logger} from '../../../../src/api.js';
import {serveControl, type ControlServer, type ControlStatus} from './control.js';
import {acquireLock, isSessionId, type LockInfo, type LockKind, type LockWhere, type SessionLock} from './lock.js';

/**
 * A session is active only while it works: the one-session lock (and the control socket that
 * `claude stop` and the waiting view talk to) is taken when a turn starts and given back once the
 * chat is idle again, so an idle chat in another terminal never blocks anyone.
 */
export type TurnLock = {
	/** Takes the lock; throws, with a message for the user, while another session is working. */
	acquire(): void;
	/** Idempotent. */
	release(): void;
	readonly held: boolean;
};

export type TurnLockOptions = {
	/** The session directory; undefined means no lock across processes (best effort, as before). */
	dir: string | undefined;
	kind: LockKind;
	where: LockWhere;
	/** Stored in the lock (the runner's chat socket); a local chat stores its control socket instead. */
	socket?: string;
	sessionId?: () => string | undefined;
	status: (startedAt: number) => ControlStatus | Promise<ControlStatus>;
	stop: () => void | Promise<void>;
	/** The refusal shown while another session holds the lock. */
	busy: (holder: LockInfo | undefined) => string;
	log: Logger;
};

export function createTurnLock(opts: TurnLockOptions): TurnLock {
	let lock: SessionLock | undefined;
	let server: ControlServer | undefined;
	let held = false;
	// Bumped on every release, so a control server that comes up late is closed again.
	let epoch = 0;

	const syncId = (): void => {
		const id = opts.sessionId?.();
		if (lock && id && isSessionId(id) && id !== lock.info.sessionId) lock.update({sessionId: id});
	};

	return {
		get held() {
			return held;
		},
		acquire() {
			if (held) return;
			if (opts.dir) {
				const id = opts.sessionId?.();
				let got: ReturnType<typeof acquireLock> | undefined;
				try {
					got = acquireLock({
						dir: opts.dir,
						kind: opts.kind,
						where: opts.where,
						...(opts.socket && {socket: opts.socket}),
						...(id && isSessionId(id) && {sessionId: id}),
						log: opts.log,
					});
				} catch (err) {
					// An unusable lock directory falls back to no lock across processes, as before.
					opts.log.warn('session lock unavailable', {error: (err as {code?: unknown}).code ?? 'unknown'});
				}
				if (got && !got.ok) throw new Error(opts.busy(got.holder));
				if (got?.ok) lock = got.lock;
			}
			held = true;
			const mine = ++epoch;
			const dir = opts.dir;
			if (!dir || !lock) return;
			const owned = lock;
			void serveControl({
				dir,
				log: opts.log,
				handlers: {
					status: () => {
						syncId();
						return opts.status(owned.info.startedAt);
					},
					stop: opts.stop,
				},
			}).then(
				s => {
					if (mine !== epoch || !held) void s.close();
					else {
						server = s;
						if (opts.where === 'local') owned.update({socket: s.path});
					}
				},
				err => opts.log.warn('control socket unavailable', {err}),
			);
		},
		release() {
			if (!held) return;
			held = false;
			epoch++;
			void server?.close();
			server = undefined;
			syncId();
			lock?.release();
			lock = undefined;
		},
	};
}
