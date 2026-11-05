import {initialAgents, type AgentsState} from './agents.js';
import {createStore, type Store} from './store.js';

export type AgentStore = Store<AgentsState>;

export function createAgentStore(initial: AgentsState = initialAgents()): AgentStore {
	return createStore(initial);
}
