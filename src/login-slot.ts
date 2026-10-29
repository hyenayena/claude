import {createHash, randomBytes} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export type LoginSlot = {credentials: unknown; oauthAccount?: unknown; primaryApiKey?: string};

const FILE_MAX = 1024 * 1024;
const SLOT_MAX = 64 * 1024;
const LOGIN_FIELDS = ['oauthAccount', 'primaryApiKey'] as const;
const ORG_CACHES = /^(policy-limits|remote-settings)\.json/;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const loginCredentialsFile = (configDir: string): string => path.join(configDir, '.credentials.json');
export const claudeJsonFile = (configDir: string): string => path.join(configDir, '.claude.json');

export function writeAtomic(file: string, data: string): void {
	mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(tmp, data, {flag: 'wx', mode: 0o600});
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, {force: true});
		throw err;
	}
}

type Read = {state: 'none'} | {state: 'bad'} | {state: 'ok'; value: unknown};

function readJsonState(file: string): Read {
	let size: number;
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size > FILE_MAX) return {state: 'bad'};
		size = st.size;
	} catch {
		return {state: 'none'};
	}
	try {
		if (size === 0) return {state: 'bad'};
		return {state: 'ok', value: JSON.parse(readFileSync(file, 'utf8')) as unknown};
	} catch {
		return {state: 'bad'};
	}
}

export function readJson(file: string): unknown {
	const r = readJsonState(file);
	return r.state === 'ok' ? r.value : undefined;
}

const slotFrom = (credentials: unknown, claude: unknown): LoginSlot | undefined => {
	const c = isRecord(claude) ? claude : {};
	const primaryApiKey = typeof c.primaryApiKey === 'string' && c.primaryApiKey !== '' ? c.primaryApiKey : undefined;
	const hasOauth = isRecord(credentials) && isRecord(credentials.claudeAiOauth);
	if (!hasOauth && primaryApiKey === undefined) return undefined;
	return {
		credentials: hasOauth ? credentials : null,
		...(c.oauthAccount !== undefined && {oauthAccount: c.oauthAccount}),
		...(primaryApiKey !== undefined && {primaryApiKey}),
	};
};

export type WorkingCopy = {state: 'none'} | {state: 'bad'} | {state: 'ok'; slot: LoginSlot};

export function readWorkingCopy(configDir: string): WorkingCopy {
	const credentials = readJsonState(loginCredentialsFile(configDir));
	const claude = readJsonState(claudeJsonFile(configDir));
	if (credentials.state === 'bad' || claude.state === 'bad') return {state: 'bad'};
	const slot = slotFrom(credentials.state === 'ok' ? credentials.value : undefined, claude.state === 'ok' ? claude.value : undefined);
	return slot ? {state: 'ok', slot} : {state: 'none'};
}

export function snapshotLogin(configDir: string): LoginSlot | undefined {
	const wc = readWorkingCopy(configDir);
	return wc.state === 'ok' ? wc.slot : undefined;
}

export function workingCopyStamp(configDir: string): string {
	return [loginCredentialsFile(configDir), claudeJsonFile(configDir)]
		.map(f => {
			try {
				const st = statSync(f);
				return `${st.size}:${st.mtimeMs}`;
			} catch {
				return '-';
			}
		})
		.join('|');
}

export function parseSlot(raw: unknown): LoginSlot | undefined {
	let v = raw;
	if (typeof raw === 'string') {
		if (raw.length > SLOT_MAX) return undefined;
		try {
			v = JSON.parse(raw) as unknown;
		} catch {
			return undefined;
		}
	}
	if (!isRecord(v)) return undefined;
	const credentials = isRecord(v.credentials) && isRecord(v.credentials.claudeAiOauth) ? v.credentials : null;
	const primaryApiKey = typeof v.primaryApiKey === 'string' && v.primaryApiKey !== '' ? v.primaryApiKey : undefined;
	if (!credentials && primaryApiKey === undefined) return undefined;
	return {credentials, ...(v.oauthAccount !== undefined && {oauthAccount: v.oauthAccount}), ...(primaryApiKey !== undefined && {primaryApiKey})};
}

export const slotKind = (slot: LoginSlot): 'api-key' | 'oauth' => (slot.credentials ? 'oauth' : 'api-key');

export const slotEmail = (slot: LoginSlot): string | undefined => {
	const a = slot.oauthAccount;
	return isRecord(a) && typeof a.emailAddress === 'string' && a.emailAddress.length <= 320 ? a.emailAddress : undefined;
};

export const slotUuid = (slot: LoginSlot): string | undefined => {
	const a = slot.oauthAccount;
	return isRecord(a) && typeof a.accountUuid === 'string' && a.accountUuid.length <= 64 ? a.accountUuid : undefined;
};

export const expiresAt = (slot: LoginSlot): number | undefined => {
	const c = slot.credentials;
	const oauth = isRecord(c) ? c.claudeAiOauth : undefined;
	return isRecord(oauth) && typeof oauth.expiresAt === 'number' && Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : undefined;
};

export const sameClaudeAccount = (a: LoginSlot, b: LoginSlot): boolean => {
	const [ua, ub] = [slotUuid(a), slotUuid(b)];
	if (ua !== undefined && ub !== undefined) return ua === ub;
	const [ea, eb] = [slotEmail(a), slotEmail(b)];
	if (ea !== undefined && eb !== undefined) return ea.toLowerCase() === eb.toLowerCase();
	return a.primaryApiKey !== undefined && a.primaryApiKey === b.primaryApiKey;
};

const canonical = (v: unknown): unknown => {
	if (Array.isArray(v)) return v.map(canonical);
	if (!isRecord(v)) return v;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
	return out;
};

export const slotDigest = (slot: LoginSlot): string => createHash('sha256').update(JSON.stringify(canonical(slot))).digest('hex');

export function slotLeaves(slot: LoginSlot): string[] {
	const out: string[] = [];
	const walk = (v: unknown, depth: number): void => {
		if (depth > 8) return;
		if (typeof v === 'string') {
			if (v.length >= 16) out.push(v);
		} else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
		else if (isRecord(v)) for (const x of Object.values(v)) walk(x, depth + 1);
	};
	walk(slot.credentials, 0);
	if (slot.primaryApiKey !== undefined) out.push(slot.primaryApiKey);
	return out;
}

export function installSlot(configDir: string, slot: LoginSlot): void {
	if (slot.credentials) writeAtomic(loginCredentialsFile(configDir), JSON.stringify(slot.credentials, null, 2));
	else rmSync(loginCredentialsFile(configDir), {force: true});
	const claude = readJson(claudeJsonFile(configDir));
	const next: Record<string, unknown> = isRecord(claude) ? {...claude} : {};
	for (const k of LOGIN_FIELDS) delete next[k];
	if (slot.oauthAccount !== undefined) next.oauthAccount = slot.oauthAccount;
	if (slot.primaryApiKey !== undefined) next.primaryApiKey = slot.primaryApiKey;
	writeAtomic(claudeJsonFile(configDir), JSON.stringify(next, null, 2));
	try {
		for (const f of readdirSync(configDir)) if (ORG_CACHES.test(f)) rmSync(path.join(configDir, f), {force: true});
	} catch {
	}
}

export function clearLogin(configDir: string): void {
	rmSync(loginCredentialsFile(configDir), {force: true});
	const claude = readJson(claudeJsonFile(configDir));
	if (!isRecord(claude) || !LOGIN_FIELDS.some(k => k in claude)) return;
	const next = {...claude};
	for (const k of LOGIN_FIELDS) delete next[k];
	writeAtomic(claudeJsonFile(configDir), JSON.stringify(next, null, 2));
}
