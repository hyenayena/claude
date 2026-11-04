import path from 'node:path';
import {chooseAccount, listAccounts, type Account, type AccountsCtx, type AccountView, type ChooseOpts} from './accounts.js';
import {isRecord, readJson, writeAtomic} from './login-slot.js';

// A session (with its resumes, forks and rewinds) uses at most one Claude subscription for its whole life.
// API keys are billed per use, so a session may move to any of them at any time.

export type SessionSub = {account: string; email?: string};

type SessionsFile = {v: 1; sessions: Record<string, SessionSub & {at: number}>};

const MAX_SESSIONS = 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const sessionAccountsFile = (dataDir: string): string => path.join(dataDir, 'session-accounts.json');

function readFile(dataDir: string): SessionsFile {
	const raw = readJson(sessionAccountsFile(dataDir));
	const out: SessionsFile = {v: 1, sessions: {}};
	if (!isRecord(raw) || !isRecord(raw.sessions)) return out;
	for (const [id, s] of Object.entries(raw.sessions)) {
		if (!ID_RE.test(id) || !isRecord(s) || typeof s.account !== 'string' || !NAME_RE.test(s.account)) continue;
		out.sessions[id] = {
			account: s.account,
			...(typeof s.email === 'string' && s.email !== '' && {email: s.email.slice(0, 320)}),
			at: typeof s.at === 'number' ? s.at : 0,
		};
	}
	return out;
}

export function sessionSubscription(dataDir: string, sessionId: string | undefined): SessionSub | undefined {
	if (sessionId === undefined) return undefined;
	const s = readFile(dataDir).sessions[sessionId];
	return s && {account: s.account, ...(s.email !== undefined && {email: s.email})};
}

const sameSub = (a: Account, sub: SessionSub): boolean =>
	a.name === sub.account && (a.email === undefined || sub.email === undefined || a.email === sub.email);

// Records the subscription a session runs on. Returns false when the session already has another one.
export function bindSession(dataDir: string, sessionId: string, account: Account, now = Date.now()): boolean {
	if (account.kind !== 'oauth' || !ID_RE.test(sessionId)) return true;
	const f = readFile(dataDir);
	const known = f.sessions[sessionId];
	if (known) {
		if (!sameSub(account, known)) return false;
		if (known.email !== undefined || account.email === undefined) return true;
	}
	f.sessions[sessionId] = {account: account.name, ...((account.email ?? known?.email) !== undefined && {email: account.email ?? known?.email}), at: now};
	const ids = Object.keys(f.sessions);
	if (ids.length > MAX_SESSIONS) {
		ids.sort((a, b) => f.sessions[a]!.at - f.sessions[b]!.at);
		for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete f.sessions[id];
	}
	writeAtomic(sessionAccountsFile(dataDir), JSON.stringify(f) + '\n');
	return true;
}

export const subscriptionLocked = (sub: SessionSub): string =>
	`This chat runs on the Claude subscription "${sub.account}", which is not available now. A chat uses only one Claude subscription for its whole life; it may move to an API key. Sign in to that subscription again, pin an API key ("claude auth use <name>"), or start a new chat ("claude new").`;

export type SessionChoice = {account: AccountView; kept?: {wanted: string}};

// The account a session uses next: the usual choice, unless that would be a second subscription.
export function chooseForSession(ctx: AccountsCtx, sub: SessionSub | undefined, opts: ChooseOpts = {}): SessionChoice | undefined {
	const wanted = chooseAccount(ctx, opts);
	if (!wanted) return undefined;
	if (!sub || wanted.kind === 'api-key' || sameSub(wanted, sub)) return {account: wanted};
	const own = opts.apiKeyOnly ? undefined : listAccounts(ctx).find(a => a.unusable === undefined && a.kind === 'oauth' && sameSub(a, sub));
	if (!own) throw new Error(subscriptionLocked(sub));
	return {account: own, kept: {wanted: wanted.name}};
}
