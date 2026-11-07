import type {Command, CommandContext} from '../../../../src/api.js';
import {createClaude, type ClaudeDeps} from '../../src/commands.js';
import type {ChatSession, OpenedChat, OpenEnv, OpenRequest} from '../../src/deps/chat.js';

export type Props = {
	controller: ChatSession;
	scrub: OpenedChat['scrub'];
	reveal: OpenedChat['reveal'];
	projectDir: string;
	print: CommandContext['print'];
	pin?: OpenedChat['pin'];
	initialModel?: string;
	initialAccount?: string;
	initialSessionId?: string;
};

type Opts = {onProps?: (p: Props) => void; extra?: Partial<OpenRequest>};

// Stands in for the chat module's view half: opens through the provider the way "chat" does and mounts through ctx.mount.
export function shimClaude(deps: ClaudeDeps, opts: Opts = {}) {
	const {commands, provider} = createClaude(deps);
	const claude = commands.find(c => c.name === 'claude')!;

	const open = async (req: Partial<OpenRequest>, ctx: CommandContext): Promise<void> => {
		if (!ctx.mount) throw new Error('"chat" needs an interface that can show views');
		const env: OpenEnv = {print: t => ctx.print(t), notice: t => ctx.print(t), wait: async () => false, ...(ctx.commandBridge && {commandBridge: ctx.commandBridge})};
		const origin = req.origin ?? 'user';
		await provider.admit(origin);
		const opened = await provider.open({fresh: true, ...opts.extra, ...req, origin}, env);
		if (!opened) return;
		try {
			await ctx.mount(() => {
				opts.onProps?.({
					controller: opened.session,
					scrub: opened.scrub,
					reveal: opened.reveal,
					projectDir: opened.projectDir,
					print: ctx.print,
					...(opened.pin && {pin: opened.pin}),
					...(opened.model !== undefined && {initialModel: opened.model}),
					...(opened.account !== undefined && {initialAccount: opened.account}),
					...(opened.resume && !req.fork && {initialSessionId: opened.resume}),
				});
				return {} as never;
			});
		} finally {
			opened.close();
			await opened.flush();
		}
	};

	const chat: Command = {
		...claude,
		name: 'chat',
		settings: undefined,
		run: (args, ctx) => open({fresh: true, attach: args.length === 0, ...(args[0] && {model: args[0]})}, ctx),
	};
	Object.defineProperty(chat, 'settings', {get: () => claude.settings});

	const shim: Command = {
		...claude,
		run: async (args, ctx) => {
			const [sub, ...rest] = args;
			if (sub === 'chat') {
				const fresh = rest.includes('--new');
				return open({fresh, attach: !fresh}, ctx);
			}
			if (sub === 'new') return open({fresh: true}, ctx);
			if (sub === 'ask') {
				const fresh = rest[0] === '--new';
				return provider.ask({origin: 'user', text: (fresh ? rest.slice(1) : rest).join(' '), fresh}, {print: t => ctx.print(t)});
			}
			return claude.run(args, ctx);
		},
	};
	Object.defineProperty(shim, 'settings', {get: () => claude.settings});
	return {claude: shim, chat, provider, open};
}
