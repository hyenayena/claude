import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import type {CredentialAccount, Credentials, Logger} from '../../../src/api.js';
import {type Account, type AccountKind, ACCOUNT_NAME_RE, checkAccountName, freeNames, RESERVED, secretType} from './accounts.js';
import {registerLogValues} from './credentials.js';
import {errClass, noopLog} from './log.js';

export type VaultStatus = 'ok' | 'no-provider' | 'no-grant' | 'old-host' | 'error';
export type EntryType = 'key';

export type VaultEntry = {
	readonly name: string;
	readonly type: EntryType;
	readonly kind: AccountKind;
	readonly email?: string;
	readonly disabled: boolean;
	readonly reserved?: boolean;
	readonly value?: string;
};

export type CredentialBundle = {readonly status: VaultStatus; readonly entries: readonly VaultEntry[]};

export type WireEntry = {name: string; type: EntryType; kind: AccountKind; email?: string; disabled: boolean; reserved?: boolean; value?: string};
export type WireBundle = {status: VaultStatus; entries: WireEntry[]};

export type ClaudeVault = {
	load(): Promise<CredentialBundle>;
	current(): CredentialBundle;
	addSecret(name: string | undefined, value: string): Promise<Account>;
	remove(name: string): Promise<void>;
	onChange(cb: (bundle: CredentialBundle) => void): () => void;
	readonly channel?: Credentials;
};

export const KIND_OF: Record<EntryType, string> = {key: 'anthropic-key'};
export const FIELD_OF: Record<EntryType, string> = {key: 'key'};
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

export function makeEntry(pub: Omit<WireEntry, 'value'>, secret: {value?: string} = {}): VaultEntry {
	const entry: Record<string | symbol, unknown> = {
		name: pub.name,
		type: pub.type,
		kind: pub.kind,
		...(pub.email !== undefined && {email: pub.email}),
		disabled: pub.disabled,
		...(pub.reserved && {reserved: true}),
	};
	if (secret.value !== undefined) Object.defineProperty(entry, 'value', {value: secret.value, enumerable: false});
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
	})),
});

export const decodeBundle = (w: WireBundle): CredentialBundle => ({
	status: w.status,
	entries: w.entries.map(({value, ...pub}) => makeEntry(pub, value !== undefined ? {value} : {})),
});

export const bundleSecrets = (b: CredentialBundle): string[] =>
	b.entries.flatMap(e => (e.value !== undefined ? [e.value] : []));

const bundleDigest = (b: CredentialBundle): string => createHash('sha256').update(JSON.stringify(encodeBundle(b))).digest('hex');

const empty = (status: VaultStatus): CredentialBundle => ({status, entries: []});

function entryOf(a: CredentialAccount, type: EntryType, raw: string | undefined): VaultEntry | undefined {
	if (!ACCOUNT_NAME_RE.test(a.name)) return undefined;
	const reserved = RESERVED.has(a.name);
	const value = raw?.trim() ? raw.trim() : undefined;
	return makeEntry({name: a.name, type, kind: 'api-key', disabled: a.disabled, ...(reserved && {reserved: true})}, value !== undefined ? {value} : {});
}

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
		async addSecret(rawName, raw) {
			const value = raw.trim();
			const type = secretType(value);
			if (rawName !== undefined) checkAccountName(rawName);
			const {creds: c, bundle} = usable();
			const dup = bundle.entries.find(e => e.value === value);
			if (dup && dup.name !== rawName) throw new Error(`That key is already account "${dup.name}"`);
			let name: string;
			const existing = rawName !== undefined ? bundle.entries.find(e => e.name === rawName) : undefined;
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
			return {name, type, kind: 'api-key'};
		},
		async remove(name) {
			const {creds: c, bundle} = usable();
			if (!bundle.entries.some(e => e.name === name)) throw new Error(`No account "${name}"; "claude auth status" lists them`);
			await c.remove(name);
			await load();
		},
	};
}

export type RunnerVault = ClaudeVault & {push(bundle: CredentialBundle): void};

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
		addSecret: readOnly,
		remove: readOnly,
	};
}
