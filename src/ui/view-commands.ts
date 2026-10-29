export type ViewCommandInfo = {name: string; description: string; usage?: string; aliases?: string[]; subcommands?: ViewCommandInfo[]};

export type CommandHost = {
	runLine(line: string): boolean;
	listCommands(): ViewCommandInfo[];
};

export function commandHost(host: unknown): CommandHost | undefined {
	const h = host as {runLine?: unknown; listCommands?: unknown} | null | undefined;
	if (typeof h?.runLine !== 'function' || typeof h.listCommands !== 'function') return undefined;
	const runLine = h.runLine as (line: string) => unknown;
	const listCommands = h.listCommands as () => unknown;
	return {
		runLine: line => {
			try {
				return runLine.call(h, line) === true;
			} catch {
				return false;
			}
		},
		listCommands: () => {
			try {
				const list = listCommands.call(h);
				return Array.isArray(list)
					? list.filter((c): c is ViewCommandInfo => typeof c?.name === 'string' && typeof c.description === 'string')
					: [];
			} catch {
				return [];
			}
		},
	};
}
