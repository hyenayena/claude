import type {Logger} from '../../../../src/api.js';
import {serveControl, type ControlServer, type ControlStatus} from './control.js';
import {acquireLock, isSessionId, type LockInfo, type LockKind, type LockWhere, type SessionLock} from './lock.js';

export type TurnLock = {
	acquire(): void;
	release(): void;
	readonly held: boolean;
};

export type TurnLockOptions = {
	dir: string | undefined;
	kind: LockKind;
	where: LockWhere;
	socket?: string;
	sessionId?: () => string | undefined;
	status: (startedAt: number) => ControlStatus | Promise<ControlStatus>;
	stop: () => void | Promise<void>;
	busy: (holder: LockInfo | undefined) => string;
	log: Logger;
};

export function createTurnLock(opts: TurnLockOptions): TurnLock {
	let lock: SessionLock | undefined;
	let server: ControlServer | undefined;
	let held = false;
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
