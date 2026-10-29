import type {Logger, MountControl, UiElement} from '../../../../src/api.js';
import {errClass, noopLog} from '../log.js';
import type {ShellWatch} from './shell-watch.js';

export const SHOW_AFTER_MS = 500;

type Fallback = 'busy' | 'focus' | 'tmp';

export type ShellPanelOptions = {
	watch: ShellWatch;
	mount: (build: (control: MountControl) => UiElement, options: {target: 'panel'; activity: true}) => Promise<void>;
	isFocused: () => boolean;
	build: (watch: ShellWatch, control: MountControl) => UiElement;
	hasTmp: boolean;
	log?: Logger;
	now?: () => number;
	showAfterMs?: number;
};

export interface ShellPanel {
	dispose(): void;
}

export function createShellPanel(opts: ShellPanelOptions): ShellPanel {
	const log = opts.log ?? noopLog;
	const now = opts.now ?? Date.now;
	const after = opts.showAfterMs ?? SHOW_AFTER_MS;
	let closeView: (() => void) | undefined;
	let mounting = false;
	let attempted = false;
	let timer: NodeJS.Timeout | undefined;
	let seen = new Set<string>();
	let shownAt = 0;
	let maxCalls = 0;
	let startBytes = 0;
	let disposed = false;

	const clearTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const evaluate = (): void => {
		if (disposed) return;
		const calls = opts.watch.get().calls;
		const ids = new Set(calls.map(c => c.toolUseId));
		for (const id of ids) {
			if (!seen.has(id)) attempted = false;
		}
		seen = ids;
		if (calls.length === 0) {
			clearTimer();
			attempted = false;
			closeView?.();
			return;
		}
		if (closeView || mounting || attempted) return;
		const oldest = Math.min(...calls.map(c => c.startedAt));
		const wait = after - (now() - oldest);
		if (wait > 0) {
			clearTimer();
			timer = setTimeout(evaluate, wait);
			timer.unref();
			return;
		}
		attempted = true;
		if (!opts.isFocused()) {
			log.debug('shell view', {shown: false, calls: calls.length, ms: 0, outputBytes: 0, fallback: 'focus' satisfies Fallback});
			return;
		}
		show();
	};

	const show = (): void => {
		mounting = true;
		shownAt = now();
		maxCalls = opts.watch.get().calls.length;
		startBytes = opts.watch.totalBytes;
		let rejected = false;
		const bound = opts.watch.get().calls[0]?.bound;
		const unsub = opts.watch.subscribe(() => {
			const calls = opts.watch.get().calls;
			maxCalls = Math.max(maxCalls, calls.length);
		});
		let promise: Promise<void>;
		try {
			promise = opts.mount(
				control => {
					closeView = control.close;
					return opts.build(opts.watch, control);
				},
				{target: 'panel', activity: true},
			);
		} catch (err) {
			promise = Promise.reject(err);
		}
		promise.then(
			() => undefined,
			err => {
				rejected = true;
				log.debug('shell view', {
					shown: false,
					calls: maxCalls,
					ms: 0,
					outputBytes: 0,
					fallback: 'busy' satisfies Fallback,
					err: errClass(err),
				});
			},
		).finally(() => {
			unsub();
			mounting = false;
			closeView = undefined;
			if (!rejected) {
				const fallback: Fallback | undefined = !opts.hasTmp ? 'tmp' : undefined;
				log.debug('shell view', {
					shown: true,
					calls: maxCalls,
					ms: now() - shownAt,
					outputBytes: opts.watch.totalBytes - startBytes,
					...(bound !== undefined && {bound}),
					...(fallback !== undefined && {fallback}),
				});
			}
		});
	};

	const unsubscribe = opts.watch.subscribe(evaluate);
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			clearTimer();
			closeView?.();
		},
	};
}
