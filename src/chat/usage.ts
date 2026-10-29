export type Usage = {calls: number; input: number; cacheWrite: number; cacheRead: number; output: number};

export type ChatUsage = {main: Usage; agents: Usage};

export const emptyUsage = (): Usage => ({calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0});
export const emptyChatUsage = (): ChatUsage => ({main: emptyUsage(), agents: emptyUsage()});

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const MAX_SEEN = 2000;

export class UsageMeter {
	private readonly seen = new Set<string>();
	total: ChatUsage = emptyChatUsage();

	add(message: unknown): void {
		if (!isRecord(message) || message['type'] !== 'assistant') return;
		const inner = message['message'];
		if (!isRecord(inner) || !isRecord(inner['usage'])) return;
		const id = typeof inner['id'] === 'string' ? inner['id'] : undefined;
		if (id !== undefined) {
			if (this.seen.has(id)) return;
			if (this.seen.size >= MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
			this.seen.add(id);
		}
		const u = inner['usage'];
		const into = message['parent_tool_use_id'] == null ? this.total.main : this.total.agents;
		into.calls++;
		into.input += n(u['input_tokens']);
		into.cacheWrite += n(u['cache_creation_input_tokens']);
		into.cacheRead += n(u['cache_read_input_tokens']);
		into.output += n(u['output_tokens']);
	}
}

export const subtract = (a: Usage, b: Usage): Usage => ({
	calls: a.calls - b.calls,
	input: a.input - b.input,
	cacheWrite: a.cacheWrite - b.cacheWrite,
	cacheRead: a.cacheRead - b.cacheRead,
	output: a.output - b.output,
});

const k = (v: number): string => (v < 1000 ? `${v}` : v < 1_000_000 ? `${(v / 1000).toFixed(1)}k` : `${(v / 1_000_000).toFixed(2)}M`);

export const usageLines = (u: ChatUsage): string[] =>
	(['main', 'agents'] as const).map(part => {
		const x = u[part];
		const context = x.input + x.cacheWrite + x.cacheRead;
		return `${part}: ${x.calls} calls, context ${k(context)} (cache write ${k(x.cacheWrite)}), output ${k(x.output)}`;
	});
