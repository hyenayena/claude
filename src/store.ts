import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Logger} from '../../../src/api.js';
import {isEffort, isOutputStyle} from './chat-prefs.js';
import {atomicWriteFile} from './fsutil.js';
import {noopLog} from './log.js';
import type {ClaudeState} from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRINTABLE = /^[\x20-\x7e]+$/;
const MAX_RULES = 200;
const MAX_RULE = 2000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,99}$/;

export const isModelId = (value: string): boolean => MODEL_ID.test(value);

const sanitize = (raw: unknown): ClaudeState => {
	const state: ClaudeState = {};
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state;
	const r = raw as Record<string, unknown>;
	if (typeof r.lastSessionId === 'string' && UUID.test(r.lastSessionId)) state.lastSessionId = r.lastSessionId;
	if (typeof r.lastModel === 'string' && r.lastModel.length <= 200 && PRINTABLE.test(r.lastModel)) {
		state.lastModel = r.lastModel;
	}
	if (typeof r.chatModel === 'string' && isModelId(r.chatModel)) state.chatModel = r.chatModel;
	if (isEffort(r.chatEffort)) state.chatEffort = r.chatEffort;
	if (r.chatThinking === 'disabled') state.chatThinking = 'disabled';
	if (r.chatFastMode === true) state.chatFastMode = true;
	if (isOutputStyle(r.chatOutputStyle)) state.chatOutputStyle = r.chatOutputStyle;
	if (r.chatPermissionMode === 'acceptEdits' || r.chatPermissionMode === 'plan' || r.chatPermissionMode === 'auto') {
		state.chatPermissionMode = r.chatPermissionMode;
	}
	if (r.chatInputMode === 'vim') state.chatInputMode = 'vim';
	if (r.chatMcp === 'off') state.chatMcp = 'off';
	if (r.chatHooks === 'on') state.chatHooks = 'on';
	if (Array.isArray(r.allowedCommands)) {
		const list = r.allowedCommands.filter(
			(c): c is string => typeof c === 'string' && c.trim() !== '' && c.length <= MAX_RULE && !/[\n\0]/.test(c),
		);
		if (list.length > 0) state.allowedCommands = [...new Set(list)].slice(-MAX_RULES);
	}
	if (typeof r.subscriptionNoticeShown === 'boolean') state.subscriptionNoticeShown = r.subscriptionNoticeShown;
	return state;
};

// Module-level so that several stores over the same file still serialise.
let chain: Promise<unknown> = Promise.resolve();

export const createStore = (dataDir: string, log: Logger = noopLog) => {
	const file = join(dataDir, 'state.json');

	const read = async (): Promise<ClaudeState> => {
		try {
			return sanitize(JSON.parse(await readFile(file, 'utf8')));
		} catch {
			return {};
		}
	};

	const update = (patch: Partial<ClaudeState>): Promise<ClaudeState> => {
		const run = async (): Promise<ClaudeState> => {
			const next = sanitize({...(await read()), ...patch});
			try {
				await atomicWriteFile(file, JSON.stringify(next, null, '\t') + '\n');
			} catch (err) {
				const code = (err as {code?: unknown} | null)?.code;
				log.warn('state write failed', {code: typeof code === 'string' ? code : undefined});
				throw err;
			}
			return next;
		};
		const result = chain.then(run, run);
		chain = result.catch(() => {});
		return result;
	};

	return {read, update};
};
