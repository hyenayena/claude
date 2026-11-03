import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {routeAgentInput, type AgentRouteCtx} from '../../src/chat/agent-route.js';
import {DEFAULT_TIERS, tierMapFromState} from '../../src/chat/tiers.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-route-'));
after(() => rmSync(root, {recursive: true, force: true}));
const project = path.join(root, 'project');
const user = path.join(root, 'user');
mkdirSync(project, {recursive: true});
mkdirSync(user, {recursive: true});
const agent = (dir: string, file: string, head: string) => writeFileSync(path.join(dir, file), `---\n${head}\n---\nWork.\n`);
agent(project, 'ranged.md', 'name: ranged\ndescription: d\nmodel: standard/strong');
agent(project, 'capped.md', 'name: capped\ndescription: d\nmodel: light/standard/STRONG/max');
agent(project, 'fixed.md', 'description: d\nmodel: light');
agent(project, 'modeled.md', 'name: modeled\ndescription: d\nmodel: opus');
agent(project, 'inherits.md', 'name: inherits\ndescription: d\nmodel: inherit');
agent(project, 'plain.md', 'name: plain\ndescription: d');
agent(project, 'bad.md', 'name: bad\ndescription: d\nmodel: strong/light');
agent(project, 'old.md', 'name: old\ndescription: d\ntier: max');
agent(project, 'shared.md', 'name: shared\ndescription: project\nmodel: max');
agent(user, 'shared.md', 'name: shared\ndescription: user\nmodel: light');
agent(user, 'mine.md', 'name: mine\ndescription: d\nmodel: strong');

const ctx = (o: Partial<AgentRouteCtx> = {}): AgentRouteCtx => ({routerOn: true, map: DEFAULT_TIERS, dirs: [project, user], ...o});
const input = (type?: string, extra: Record<string, unknown> = {}) => ({description: 'x', prompt: 'p', ...(type !== undefined && {subagent_type: type}), ...extra});
const at = (type: string, model: string, effort: string, extra: Record<string, unknown> = {}) => ({...input(type, extra), model, effort});

test('a rating or a pin is clamped into the range', async () => {
	assert.deepEqual(await routeAgentInput(input('ranged'), ctx({rating: 'light'})), at('ranged', 'sonnet', 'medium'));
	assert.deepEqual(await routeAgentInput(input('ranged'), ctx({rating: 'max'})), at('ranged', 'opus', 'medium'));
	assert.deepEqual(await routeAgentInput(input('capped'), ctx({rating: 'light'})), at('capped', 'haiku', 'medium'));
	assert.deepEqual(await routeAgentInput(input('capped'), ctx({rating: 'max'})), at('capped', 'opus', 'high'));
});

test('without a rating a range uses its default: the CAPS entry, else the lower of two', async () => {
	assert.deepEqual(await routeAgentInput(input('ranged'), ctx()), at('ranged', 'sonnet', 'medium'));
	assert.deepEqual(await routeAgentInput(input('capped'), ctx()), at('capped', 'opus', 'medium'));
});

test('with the router off tier-syntax agents get their default tier and the rating is ignored', async () => {
	const off = ctx({routerOn: false, rating: 'max'});
	assert.deepEqual(await routeAgentInput(input('ranged'), off), at('ranged', 'sonnet', 'medium'));
	assert.deepEqual(await routeAgentInput(input('capped'), off), at('capped', 'opus', 'medium'));
	assert.deepEqual(await routeAgentInput(input('fixed'), off), at('fixed', 'haiku', 'medium'));
	for (const type of ['modeled', 'inherits', 'plain', 'general-purpose', 'Explore', 'bad']) assert.equal(await routeAgentInput(input(type), off), undefined, type);
	assert.equal(await routeAgentInput(input(), off), undefined);
});

test('a fixed tier follows the current map and overwrites what the model passed', async () => {
	const map = tierMapFromState({tierLightModel: 'sonnet', tierLightEffort: 'low'});
	const log = makeFakeLog();
	const out = await routeAgentInput(input('fixed', {model: 'opus', effort: 'max'}), ctx({map, rating: 'max', log}));
	assert.deepEqual(out, at('fixed', 'sonnet', 'low'));
	assert.ok(log.records.some(r => r.msg === 'agent routed' && r.fields.tier === 'light' && r.fields.source === 'fixed'));
});

test('concrete models, inherit, built-ins other than general-purpose and forks stay unchanged', async () => {
	for (const type of ['modeled', 'inherits', 'Explore', 'Plan']) assert.equal(await routeAgentInput(input(type), ctx({rating: 'max'})), undefined, type);
	assert.equal(await routeAgentInput(input('fork', {model: 'haiku'}), ctx({rating: 'max'})), undefined);
});

test('general-purpose, a missing type and agents without model: follow the rating', async () => {
	for (const type of ['general-purpose', undefined, 'plain', 'old']) {
		assert.deepEqual(await routeAgentInput(input(type), ctx({rating: 'strong'})), {...input(type), model: 'opus', effort: 'medium'}, String(type));
		assert.equal(await routeAgentInput(input(type), ctx()), undefined, `${String(type)} without a rating`);
	}
});

test('a project agent overrides a user agent; user agents are found too', async () => {
	assert.deepEqual(await routeAgentInput(input('shared'), ctx()), at('shared', 'opus', 'high'));
	assert.deepEqual(await routeAgentInput(input('mine'), ctx()), at('mine', 'opus', 'medium'));
});

test('invalid tier syntax counts as an unknown model and is left unchanged', async () => {
	const log = makeFakeLog();
	assert.equal(await routeAgentInput(input('bad'), ctx({rating: 'light', log})), undefined);
	assert.ok(log.records.some(r => r.msg === 'agent tier invalid' && r.level === 'debug'));
});
