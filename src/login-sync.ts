import type {Logger} from '../../../src/api.js';
import {adoptLoginAccount, readAuth, storedEntries, workingCopyDirty, writeAuth, type AccountsCtx} from './accounts.js';
import {errClass, noopLog} from './log.js';
import {expiresAt, readWorkingCopy, sameClaudeAccount, slotDigest, workingCopyStamp} from './login-slot.js';
import type {ClaudeVault} from './vault.js';

export type SyncOutcome = 'clean' | 'saved' | 'adopted' | 'skipped' | 'failed';

export type LoginSync = {
	/** The working copy holds a login the store does not have yet. */
	dirty(): boolean;
	/** The working copy's files changed (size, mtime) since the last sync or check. */
	changed(): boolean;
	/** Saves a refreshed login back, or adopts a login made in Claude Code directly; one at a time. */
	sync(): Promise<SyncOutcome>;
};

export type LoginSyncOpts = {dataDir: string; configDir: string; env?: NodeJS.ProcessEnv; vault: ClaudeVault; log?: Logger};

export function createLoginSync(o: LoginSyncOpts): LoginSync {
	const log = o.log ?? noopLog;
	const ctx = (): AccountsCtx => ({dataDir: o.dataDir, configDir: o.configDir, env: o.env ?? {}, bundle: o.vault.current()});
	let stamp = '';
	let queue: Promise<unknown> = Promise.resolve();

	const run = async (): Promise<SyncOutcome> => {
		stamp = workingCopyStamp(o.configDir);
		const bundle = o.vault.current();
		if (bundle.status !== 'ok') return 'skipped';
		const wc = readWorkingCopy(o.configDir);
		if (wc.state === 'none') return 'clean';
		// The CLI may be writing the files; the next sync point tries again.
		if (wc.state === 'bad') return 'skipped';
		const f = readAuth(o.dataDir);
		const logins = storedEntries(bundle).filter(e => e.type === 'login' && e.slot !== undefined);
		const inst = logins.find(e => e.name === f.installed);
		if (inst?.slot && slotDigest(inst.slot) === slotDigest(wc.slot)) return 'clean';
		const owner = inst?.slot && sameClaudeAccount(wc.slot, inst.slot) ? inst : logins.find(e => sameClaudeAccount(wc.slot, e.slot!));
		if (owner?.slot) {
			if (owner.name !== f.installed) {
				f.installed = owner.name;
				writeAuth(o.dataDir, f);
			}
			if (slotDigest(owner.slot) === slotDigest(wc.slot)) return 'clean';
			// Never regress the stored login: two writers (yena, another yena) may race.
			if ((expiresAt(wc.slot) ?? 0) < (expiresAt(owner.slot) ?? 0)) return 'skipped';
			await o.vault.saveLogin(owner.name, wc.slot);
			return 'saved';
		}
		await adoptLoginAccount(ctx(), o.vault, undefined, wc.slot);
		return 'adopted';
	};

	const guarded = async (): Promise<SyncOutcome> => {
		let outcome: SyncOutcome;
		try {
			outcome = await run();
		} catch (err) {
			log.warn('login sync failed', {errClass: errClass(err)});
			outcome = 'failed';
		}
		if (outcome !== 'clean') log.info('login sync', {outcome});
		return outcome;
	};

	return {
		dirty: () => workingCopyDirty(ctx()),
		changed: () => {
			const now = workingCopyStamp(o.configDir);
			if (now === stamp) return false;
			stamp = now;
			return true;
		},
		sync: () => {
			const next = queue.then(guarded, guarded);
			queue = next;
			return next;
		},
	};
}

const shared = new WeakMap<ClaudeVault, LoginSync>();

/** One sync per vault, so the chat, ask and the auth commands of a yena never sync at the same time. */
export function loginSyncFor(o: LoginSyncOpts): LoginSync {
	let s = shared.get(o.vault);
	if (!s) shared.set(o.vault, (s = createLoginSync(o)));
	return s;
}
