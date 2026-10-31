import {initialAgents, type AgentsState} from './agents.js';

export type AgentStore = {
	get(): AgentsState;
	set(next: AgentsState): void;
	subscribe(listener: () => void): () => void;
};

export function createAgentStore(initial: AgentsState = initialAgents()): AgentStore {
	let state = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set: next => {
			if (next === state) return;
			state = next;
			for (const l of [...listeners]) l();
		},
		subscribe: listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
