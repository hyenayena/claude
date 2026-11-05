export type Store<T> = {
	get(): T;
	set(next: T): void;
	subscribe(listener: () => void): () => void;
};

// A header element is a separate React tree, so it re-renders only through a store like this one.
export function createStore<T>(initial: T): Store<T> {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set: next => {
			if (Object.is(next, state)) return;
			state = next;
			for (const l of [...listeners]) l();
		},
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
