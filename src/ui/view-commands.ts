// A structural copy of core's optional ViewHost members for console commands (core 0.6.0+);
// older cores do not have them, and the chat then sends every line to Claude.
// `subcommands` and `aliases` come from core 0.7.0+; older cores list the top level only.
export type ViewCommandInfo = {name: string; description: string; usage?: string; aliases?: string[]; subcommands?: ViewCommandInfo[]};

export type CommandHost = {
	runLine(line: string): boolean;
	listCommands(): ViewCommandInfo[];
};

/** The host's console-command members, or undefined when the host has none. */
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
