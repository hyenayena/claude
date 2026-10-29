import type {Logger} from '../../../../src/api.js';

export type LogRecord = {level: 'error' | 'warn' | 'info' | 'debug'; scope: string; msg: string; fields: Record<string, unknown>};

export type FakeLog = Logger & {
	records: LogRecord[];
	redactors: Array<(text: string) => string>;
	trail: string[];
};

export const makeFakeLog = (): FakeLog => {
	const records: LogRecord[] = [];
	const redactors: Array<(text: string) => string> = [];
	const trail: string[] = [];
	const build = (scope: string): Logger => {
		const at = (level: LogRecord['level']) => (msg: string, fields: Record<string, unknown> = {}) => {
			records.push({level, scope, msg, fields});
			trail.push(msg);
		};
		return {
			error: at('error'),
			warn: at('warn'),
			info: at('info'),
			debug: at('debug'),
			child: s => build(scope ? `${scope}.${s}` : s),
			addRedactor: fn => {
				redactors.push(fn);
				trail.push('<addRedactor>');
			},
		};
	};
	return Object.assign(build(''), {records, redactors, trail});
};

export const serialized = (log: FakeLog): string => JSON.stringify(log.records);
