import type {OpenedChat, ChatProvider, OpenEnv} from '../../src/deps/chat.js';

type Script = (close: () => void) => void | Promise<void>;
export type ShimProps = {controller: OpenedChat['session']; scrub: OpenedChat['scrub']};
export type ShimWait = {check: () => Promise<{free: boolean; title?: string}>; onFree: () => void; onCancel: () => void};

// Stands in for the chat module's view half: opens through the provider the way "chat" does, then lets a script close the view.
export function chatShim(provider: ChatProvider, opts: {keep?: boolean} = {}) {
	const printed: string[] = [];
	const props: ShimProps[] = [];
	const waits: ShimWait[] = [];
	const scripts: Script[] = [];
	let mounts = 0;

	const view = async (): Promise<void> => {
		const n = mounts++;
		let close!: () => void;
		const done = new Promise<void>(r => (close = r));
		void Promise.resolve(scripts[n] ? scripts[n]!(close) : close());
		await done;
	};

	const env: OpenEnv = {
		print: t => void printed.push(t),
		notice: t => void printed.push(t),
		wait: async check => {
			let freed = false;
			let close!: () => void;
			const done = new Promise<void>(r => (close = r));
			waits.push({check, onFree: () => ((freed = true), close()), onCancel: () => close()});
			const n = mounts++;
			void Promise.resolve(scripts[n] ? scripts[n]!(close) : close());
			await done;
			return freed;
		},
	};

	const open = async (fresh: boolean, attach: boolean, origin: 'user' | 'unattended' = 'user'): Promise<void> => {
		await provider.admit(origin);
		const opened = await provider.open({origin, fresh, attach, ...(opts.keep && {keep: true})}, env);
		if (!opened) return;
		props.push({controller: opened.session, scrub: opened.scrub});
		if (opened.reattached) printed.push(`Reattached to a session working since ${opened.reattached.startedAt}`);
		try {
			await view();
		} finally {
			opened.close();
			await opened.flush();
			printed.push('[chat closed]');
		}
	};

	const chat = {
		run: async (args: string[], _ctx?: unknown): Promise<void> => {
			const [sub, ...rest] = args;
			if (sub === 'ask') {
				await provider.ask({origin: 'user', text: rest.join(' '), fresh: false}, {print: t => void printed.push(t)});
				return;
			}
			const fresh = sub === 'new' || rest.includes('--new');
			await open(fresh, sub === 'chat' && !fresh);
		},
	};
	return {chat, printed, props, waits, scripts, mounts: () => mounts, env};
}
