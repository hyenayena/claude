export type PinWatch = {
	current(): string | undefined;
	refresh(): void;
	subscribe(cb: () => void): () => void;
};

export function createPinWatch(read: () => string | undefined): PinWatch {
	const subs = new Set<() => void>();
	const safeRead = (fallback: string | undefined): string | undefined => {
		try {
			return read();
		} catch {
			return fallback;
		}
	};
	let value = safeRead(undefined);
	return {
		current: () => value,
		refresh: () => {
			const next = safeRead(value);
			if (next === value) return;
			value = next;
			for (const cb of [...subs]) cb();
		},
		subscribe: cb => {
			subs.add(cb);
			return () => {
				subs.delete(cb);
			};
		},
	};
}
