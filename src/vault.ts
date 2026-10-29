import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import type {CredentialAccount, Credentials, Logger} from '../../../src/api.js';
import {type Account, type AccountKind, ACCOUNT_NAME_RE, checkAccountName, freeNames, RESERVED, secretType, toAccountName} from './accounts.js';
import {registerLogValues} from './credentials.js';
import {errClass, noopLog} from './log.js';
import {type LoginSlot, parseSlot, sameClaudeAccount, slotEmail, slotKind, slotLeaves} from './login-slot.js';

/**
 * The Claude credentials of the account module, read through the host's credential channel and kept
 * in memory only (a bundle): never logged, never written except the login working copy in config/.
 * The background runner has no channel; it gets the bundle pushed by the yena it is attached to.
 */

export type VaultStatus = 'ok' | 'no-provider' | 'no-grant' | 'old-host' | 'error';
export type EntryType = 'key' | 'token' | 'login';

export type VaultEntry = {
	readonly name: string;
	readonly type: EntryType;
	readonly kind: AccountKind;
	readonly email?: string;
	readonly disabled: boolean;
	/** Named like an environment account (env-key, env-token): listed, never used. */
	readonly reserved?: boolean;
	/** Hidden from JSON and inspect. */
	readonly value?: string;
	/** Hidden from JSON and inspect. */
	readonly slot?: LoginSlot;
};

export type CredentialBundle = {readonly status: VaultStatus; readonly entries: readonly VaultEntry[]};

/** A bundle with its values in the open: only for the runner socket (runner/protocol.ts). */
export type WireEntry = {name: string; type: EntryType; kind: AccountKind; email?: string; disabled: boolean; reserved?: boolean; value?: string; slot?: LoginSlot};
export type WireBundle = {status: VaultStatus; entries: WireEntry[]};

export type ClaudeVault = {
	load(): Promise<CredentialBundle>;
	current(): CredentialBundle;
	saveLogin(name: string, slot: LoginSlot): Promise<void>;
	adoptLogin(name: string | undefined, slot: LoginSlot): Promise<Account>;
	addSecret(name: string | undefined, value: string): Promise<Account>;
	remove(name: string): Promise<void>;
	removeAll(): Promise<number>;
	onChange(cb: (bundle: CredentialBundle) => void): () => void;
	/** The channel itself, in yena only (the one-time migration writes through it). */
	readonly channel?: Credentials;
};

export const KIND_OF: Record<EntryType, string> = {key: 'anthropic-key', token: 'anthropic-token', login: 'claude-login'};
export const FIELD_OF: Record<EntryType, string> = {key: 'key', token: 'token', login: 'login'};
const TYPE_LABEL: Record<EntryType, string> = {key: 'API key', token: 'subscription token', login: 'login'};
export const MAX_ENTRIES = 50;
const LOAD_WAIT_MS = 5000;

export const degradedReason = (status: VaultStatus): string | undefined => {
	switch (status) {
		case 'no-provider':
			return 'Stored Claude credentials live in the account module, which is not installed (mod install account); until then only ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN work.';
		case 'old-host':
			return 'Stored Claude credentials need a yena host with the credential channel (update yena); until then only ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN work.';
		case 'no-grant':
			return 'claude may not use stored credentials yet. Allow it (only you can): account grant claude';
		case 'error':
			return 'Stored Claude credentials cannot be decrypted; see: account vault status';
		default:
			return undefined;
	}
};

export const isAccessError = (err: unknown): boolean => (err as {code?: unknown} | null)?.code === 'CREDENTIAL_ACCESS';

export function makeEntry(pub: Omit<WireEntry, 'value' | 'slot'>, secret: {value?: string; slot?: LoginSlot} = {}): VaultEntry {
	const entry: Record<string | symbol, unknown> = {
		name: pub.name,
		type: pub.type,
		kind: pub.kind,
		...(pub.email !== undefined && {email: pub.email}),
		disabled: pub.disabled,
		...(pub.reserved && {reserved: true}),
	};
	if (secret.value !== undefined) Object.defineProperty(entry, 'value', {value: secret.value, enumerable: false});
	if (secret.slot !== undefined) Object.defineProperty(entry, 'slot', {value: secret.slot, enumerable: false});
	Object.defineProperty(entry, inspect.custom, {value: () => `VaultEntry<${pub.type} ${pub.name}> [redacted]`, enumerable: false});
	return Object.freeze(entry) as unknown as VaultEntry;
}

export const encodeBundle = (b: CredentialBundle): WireBundle => ({
	status: b.status,
	entries: b.entries.map(e => ({
		name: e.name,
		type: e.type,
		kind: e.kind,
		...(e.email !== undefined && {email: e.email}),
		disabled: e.disabled,
		...(e.reserved && {reserved: true}),
		...(e.value !== undefined && {value: e.value}),
		...(e.slot !== undefined && {slot: e.slot}),
	})),
});

export const decodeBundle = (w: WireBundle): CredentialBundle => ({
	status: w.status,
	entries: w.entries.map(({value, slot, ...pub}) => makeEntry(pub, {...(value !== undefined && {value}), ...(slot !== undefined && {slot})})),
});

/** Every secret string in the bundle (values and the tokens inside logins), for redaction. */
export const bundleSecrets = (b: CredentialBundle): string[] =>
	b.entries.flatMap(e => [...(e.value !== undefined ? [e.value] : []), ...(e.slot ? slotLeaves(e.slot) : [])]);

// In memory only, to tell whether a bundle changed.
const bundleDigest = (b: CredentialBundle): string => createHash('sha256').update(JSON.stringify(encodeBundle(b))).digest('hex');

const empty = (status: VaultStatus): CredentialBundle => ({status, entries: []});

function entryOf(a: CredentialAccount, type: EntryType, raw: string | undefined): VaultEntry | undefined {
	if (!ACCOUNT_NAME_RE.test(a.name)) return undefined;
	const reserved = RESERVED.has(a.name);
	const pub = {name: a.name, type, disabled: a.disabled, ...(reserved && {reserved: true})};
	if (type !== 'login') {
		const value = raw?.trim() ? raw.trim() : undefined;
		return makeEntry({...pub, kind: type === 'key' ? 'api-key' : 'oauth'}, value !== undefined ? {value} : {});
	}
	const slot = raw !== undefined ? parseSlot(raw) : undefined;
	const email = slot ? slotEmail(slot) : typeof a.fields.email === 'string' ? a.fields.email.slice(0, 320) : undefined;
	const kind: AccountKind = slot ? slotKind(slot) : a.fields.method === 'console' ? 'api-key' : 'oauth';
	return makeEntry({...pub, kind, ...(email !== undefined && {email})}, slot ? {slot} : {});
}

/**
 * Creates an account and sets its secret; without `explicit` the next free name (`-2`, `-3`…) is tried
 * when the store refuses one (it may belong to an account of a kind claude cannot see). A secret that
 * cannot be set removes the new account again.
 */
export async function createCredential(
	creds: Credentials,
	p: {base: string; explicit: boolean; taken: ReadonlySet<string>; type: EntryType; fields?: Record<string, string>; value: string},
): Promise<string> {
	const names = p.explicit ? [p.base] : freeNames(p.base, p.taken, 10);
	let first: unknown;
	for (const name of names) {
		try {
			await creds.create({name, kind: KIND_OF[p.type], ...(p.fields && {fields: p.fields})});
		} catch (err) {
			if (isAccessError(err) || p.explicit) throw err;
			first ??= err;
			continue;
		}
		try {
			await creds.write(name, FIELD_OF[p.type], p.value);
		} catch (err) {
			await creds.remove(name).catch(() => undefined);
			throw err;
		}
		return name;
	}
	throw first ?? new Error('No free account name');
}

const loginFields = (slot: LoginSlot): Record<string, string> => {
	const email = slotEmail(slot);
	return {method: slotKind(slot) === 'oauth' ? 'claude.ai' : 'console', ...(email !== undefined && {email})};
};

/** The vault of a yena process: the module's credential channel (absent in hosts older than it). */
export function hostVault(creds: Credentials | undefined, log: Logger = noopLog): ClaudeVault {
	let current = empty(creds ? 'error' : 'old-host');
	let digest = '';
	let queue: Promise<unknown> = Promise.resolve();
	const listeners = new Set<(b: CredentialBundle) => void>();

	const fetch = async (): Promise<CredentialBundle> => {
		if (!creds) return empty('old-host');
		if (!creds.available()) return empty('no-provider');
		try {
			const grants = await creds.grants();
			const types = (Object.keys(KIND_OF) as EntryType[]).filter(t => grants.some(g => g.kind === KIND_OF[t] && g.granted !== undefined));
			if (types.length === 0) return empty('no-grant');
			const entries: VaultEntry[] = [];
			for (const type of types) {
				for (const a of await creds.list(KIND_OF[type])) {
					if (a.kind !== KIND_OF[type] || entries.length >= MAX_ENTRIES) continue;
					const raw = a.disabled ? undefined : await creds.read(a.name, FIELD_OF[type]);
					const entry = entryOf(a, type, raw);
					if (entry) entries.push(entry);
				}
			}
			return {status: 'ok', entries};
		} catch (err) {
			if (isAccessError(err)) return empty('no-grant');
			log.warn('credential store unavailable', {errClass: errClass(err)});
			return empty('error');
		}
	};

	const refresh = async (): Promise<CredentialBundle> => {
		const next = await fetch();
		registerLogValues(log, bundleSecrets(next));
		current = next;
		const d = bundleDigest(next);
		if (d !== digest) {
			digest = d;
			for (const cb of [...listeners]) {
				try {
					cb(next);
				} catch {
					// a listener must not break loading
				}
			}
		}
		return next;
	};

	const load = (): Promise<CredentialBundle> => {
		const run = queue.then(refresh, refresh);
		queue = run.catch(() => undefined);
		return run;
	};

	const usable = (): {creds: Credentials; bundle: CredentialBundle} => {
		const reason = degradedReason(current.status);
		if (reason || !creds) throw new Error(reason ?? 'No credential store');
		return {creds, bundle: current};
	};

	return {
		channel: creds,
		load,
		current: () => current,
		onChange: cb => {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		async saveLogin(name, slot) {
			const {creds: c} = usable();
			await c.write(name, FIELD_OF.login, JSON.stringify(slot));
			await load();
		},
		async adoptLogin(rawName, slot) {
			const {creds: c, bundle} = usable();
			const same = bundle.entries.find(e => e.type === 'login' && e.slot !== undefined && sameClaudeAccount(e.slot, slot));
			const blob = JSON.stringify(slot);
			let name: string;
			if (rawName !== undefined) {
				name = checkAccountName(rawName);
				const taken = bundle.entries.find(e => e.name === name);
				if (taken && taken !== same && taken.type !== 'login') throw new Error(`"${name}" is already ${taken.type === 'key' ? 'an' : 'a'} ${TYPE_LABEL[taken.type]} account`);
				if (taken) await c.write(name, FIELD_OF.login, blob);
				else await createCredential(c, {base: name, explicit: true, taken: new Set(), type: 'login', fields: loginFields(slot), value: blob});
			} else if (same) {
				name = same.name;
				await c.write(name, FIELD_OF.login, blob);
			} else {
				const email = slotEmail(slot);
				const base = toAccountName(email?.split('@')[0] ?? 'login', 'login');
				name = await createCredential(c, {base, explicit: false, taken: new Set(bundle.entries.map(e => e.name)), type: 'login', fields: loginFields(slot), value: blob});
			}
			if (same && same.name !== name) await c.remove(same.name);
			await load();
			const email = slotEmail(slot);
			return {name, type: 'login', kind: slotKind(slot), ...(email !== undefined && {email})};
		},
		async addSecret(rawName, raw) {
			const value = raw.trim();
			const type = secretType(value);
			if (rawName !== undefined) checkAccountName(rawName);
			const {creds: c, bundle} = usable();
			const dup = bundle.entries.find(e => e.value === value);
			if (dup && dup.name !== rawName) throw new Error(`That ${type === 'key' ? 'key' : 'token'} is already account "${dup.name}"`);
			let name: string;
			const existing = rawName !== undefined ? bundle.entries.find(e => e.name === rawName) : undefined;
			if (existing && existing.type !== type) throw new Error(`"${existing.name}" is ${existing.type === 'key' ? 'an' : 'a'} ${TYPE_LABEL[existing.type]} account; choose another name`);
			if (existing) {
				name = existing.name;
				await c.write(name, FIELD_OF[type], value);
			} else {
				name = await createCredential(c, {
					base: rawName ?? type,
					explicit: rawName !== undefined,
					taken: new Set(bundle.entries.map(e => e.name)),
					type,
					value,
				});
			}
			await load();
			return {name, type, kind: type === 'key' ? 'api-key' : 'oauth'};
		},
		async remove(name) {
			const {creds: c, bundle} = usable();
			if (!bundle.entries.some(e => e.name === name)) throw new Error(`No account "${name}"; "claude auth status" lists them`);
			await c.remove(name);
			await load();
		},
		async removeAll() {
			if (current.status !== 'ok' || !creds) return 0;
			let n = 0;
			for (const e of current.entries) {
				if (e.reserved) continue;
				await creds.remove(e.name);
				n++;
			}
			await load();
			return n;
		},
	};
}

export type RunnerVault = ClaudeVault & {push(bundle: CredentialBundle): void};

/**
 * The runner's vault: the last bundle the attached yena pushed. It never writes: changes to accounts
 * are made in yena, which pushes a fresh bundle.
 */
export function bundleVault(log: Logger = noopLog, waitMs = LOAD_WAIT_MS): RunnerVault {
	let current: CredentialBundle | undefined;
	const waiting = new Set<() => void>();
	const listeners = new Set<(b: CredentialBundle) => void>();
	const readOnly = async (): Promise<never> => {
		throw new Error('Changing accounts needs yena; run it there');
	};
	return {
		push(bundle) {
			registerLogValues(log, bundleSecrets(bundle));
			current = bundle;
			for (const wake of [...waiting]) wake();
			for (const cb of [...listeners]) {
				try {
					cb(bundle);
				} catch {
					// a listener must not break the runner
				}
			}
		},
		current: () => current ?? empty('error'),
		async load() {
			if (current) return current;
			await new Promise<void>(resolve => {
				const timer = setTimeout(done, waitMs);
				timer.unref();
				function done(): void {
					clearTimeout(timer);
					waiting.delete(done);
					resolve();
				}
				waiting.add(done);
			});
			return current ?? empty('error');
		},
		onChange: cb => {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		saveLogin: readOnly,
		adoptLogin: readOnly,
		addSecret: readOnly,
		remove: readOnly,
		removeAll: readOnly,
	};
}
