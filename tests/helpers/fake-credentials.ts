import type {CredentialAccount, CredentialGrant, Credentials} from '../../../../src/api.js';

const FIELDS: Record<string, {secret: string; public: string[]}> = {
	'anthropic-key': {secret: 'key', public: []},
	'anthropic-token': {secret: 'token', public: []},
	'claude-login': {secret: 'login', public: ['email', 'method']},
	github: {secret: 'token', public: ['user']},
};

const DECLARED = ['anthropic-key', 'anthropic-token', 'claude-login'];

type Stored = {kind: string; fields: Record<string, string>; secrets: Record<string, string>; disabled: boolean};

export type FakeCredentials = Credentials & {
	accounts: Map<string, Stored>;
	granted: Set<string>;
	calls: string[];
	installed: boolean;
	broken: boolean;
	corrupt?: string;
};

const accessError = (kind: string, change: boolean): Error =>
	Object.assign(new Error(`claude may not ${change ? 'change' : 'read'} credentials of kind "${kind}". Allow it (only you can, not an assistant): account grant claude`), {
		code: 'CREDENTIAL_ACCESS',
	});

export function fakeCredentials(o: {granted?: string[]; installed?: boolean} = {}): FakeCredentials {
	const accounts = new Map<string, Stored>();
	const granted = new Set(o.granted ?? DECLARED);
	const calls: string[] = [];
	const fake: FakeCredentials = {
		accounts,
		granted,
		calls,
		installed: o.installed ?? true,
		broken: false,
		available: () => fake.installed,
		async grants(): Promise<CredentialGrant[]> {
			calls.push('grants');
			return DECLARED.map(kind => ({kind, declared: 'write' as const, ...(granted.has(kind) && {granted: 'write' as const})}));
		},
		async list(kind?: string): Promise<CredentialAccount[]> {
			calls.push(`list ${kind ?? '*'}`);
			if (kind && !granted.has(kind)) throw accessError(kind, false);
			return [...accounts]
				.filter(([, a]) => granted.has(a.kind) && (kind === undefined || a.kind === kind))
				.map(([name, a]) => ({name, kind: a.kind, fields: {...a.fields}, secrets: Object.keys(a.secrets), disabled: a.disabled, missing: a.secrets[FIELDS[a.kind]!.secret] ? [] : [FIELDS[a.kind]!.secret]}));
		},
		async read(name, field) {
			calls.push(`read ${name}`);
			const a = accounts.get(name);
			if (!a) throw new Error(`Account "${name}" does not exist. See: account list`);
			if (!granted.has(a.kind)) throw accessError(a.kind, false);
			if (fake.broken) throw Object.assign(new Error(`A stored secret of account "${name}" cannot be decrypted (tampered or a different vault key)`), {code: 'VAULT_DECRYPT'});
			if (a.disabled) return undefined;
			const v = a.secrets[field];
			return v !== undefined && fake.corrupt === name ? `${v}x` : v;
		},
		async write(name, field, value) {
			calls.push(`write ${name}`);
			const a = accounts.get(name);
			if (!a) throw new Error(`No account "${name}"`);
			if (!granted.has(a.kind)) throw accessError(a.kind, true);
			if (FIELDS[a.kind]!.secret !== field) throw new Error(`Accounts of kind ${a.kind} have no secret field "${field}"`);
			if (value === undefined) delete a.secrets[field];
			else a.secrets[field] = value;
		},
		async create(input) {
			calls.push(`create ${input.name}`);
			if (!granted.has(input.kind)) throw accessError(input.kind, true);
			if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.name)) throw new Error('Invalid account name');
			if (accounts.has(input.name)) throw new Error(`Account "${input.name}" already exists`);
			const fields = {...input.fields};
			for (const k of Object.keys(fields)) if (!FIELDS[input.kind]!.public.includes(k)) throw new Error(`Unknown field "${k}"`);
			accounts.set(input.name, {kind: input.kind, fields, secrets: {}, disabled: false});
			return {name: input.name, kind: input.kind, fields, secrets: [], disabled: false, missing: [FIELDS[input.kind]!.secret]};
		},
		async remove(name) {
			calls.push(`remove ${name}`);
			const a = accounts.get(name);
			if (!a) throw new Error(`No account "${name}"`);
			if (!granted.has(a.kind)) throw accessError(a.kind, true);
			accounts.delete(name);
		},
	};
	return fake;
}

export const seed = (f: FakeCredentials, name: string, kind: string, secret?: string, extra: Partial<Stored> = {}): void => {
	f.accounts.set(name, {kind, fields: {}, secrets: secret === undefined ? {} : {[FIELDS[kind]!.secret]: secret}, disabled: false, ...extra});
};
