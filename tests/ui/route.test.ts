import {SGR} from '../helpers/sgr16.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatEvent, RouteInfo} from '../../src/chat/events.js';
import type {Tier} from '../../src/chat/tiers.js';
import {formatOut, formatRouteBlock, routeBarText, routeBlockOf, statusBarText, toolHeader, toolRunningText} from '../../src/ui/present.js';
import {initialTranscript, reduceTranscript, ROUTE_TOOL_ID, type Out, type TranscriptState} from '../../src/ui/transcript.js';
import {stringCells} from '../../src/kit.js';

const ESC = String.fromCharCode(27);
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[\\d;]*m`, 'g'), '');
const scrub = (s: string): string => s;

const run = (events: ChatEvent[], from: TranscriptState = initialTranscript()): {state: TranscriptState; out: Out[]} => {
	let state = from;
	const out: Out[] = [];
	for (const e of events) {
		const step = reduceTranscript(state, e);
		state = step.state;
		out.push(...step.out);
	}
	return {state, out};
};

const block = (route: RouteInfo, previous?: Tier): string => plain(formatRouteBlock(routeBlockOf(route, previous), scrub));

test('route-start shows a running Routing tool that the route event removes', () => {
	const started = run([{type: 'state', state: 'running'}, {type: 'route-start'}]);
	const tool = started.state.tools.get(ROUTE_TOOL_ID);
	assert.deepEqual(tool, {id: ROUTE_TOOL_ID, name: 'Routing', input: undefined, elapsedSeconds: 0});
	assert.equal(toolRunningText(tool!, scrub), 'Routing…');
	assert.equal(toolHeader('Routing', undefined, scrub), 'Routing…');
	const routed = run([{type: 'route', route: {outcome: 'rated', main: 'standard', rated: 'standard'}, source: 'message'}], started.state);
	assert.equal(routed.state.tools.has(ROUTE_TOOL_ID), false);
	assert.deepEqual(routed.out, [{kind: 'route-block', route: {outcome: 'rated', main: 'standard', rated: 'standard'}}]);
	const off = run([{type: 'route', route: {outcome: 'off'}, source: 'message'}], started.state);
	assert.equal(off.state.tools.has(ROUTE_TOOL_ID), false);
	assert.deepEqual(off.out, []);
	const ended = run([{type: 'turn-end', outcome: 'interrupted'}], started.state);
	assert.equal(ended.state.tools.size, 0);
});

test('a command route prints a notice', () => {
	const pinned = run([{type: 'route', route: {outcome: 'pinned', main: 'max', pinned: 'max'}, previous: 'standard', source: 'command'}]);
	assert.deepEqual(pinned.out, [{kind: 'route', pinned: 'max'}]);
	assert.equal(plain(formatOut(pinned.out[0]!, scrub)), 'Tier pinned: max');
	const auto = run([{type: 'route', route: {outcome: 'kept', main: 'max'}, source: 'command'}]);
	assert.deepEqual(auto.out, [{kind: 'route'}]);
	assert.equal(plain(formatOut(auto.out[0]!, scrub)), 'Tier: back to the router');
});

test('every route block variant reads like a finished tool', () => {
	assert.equal(block({outcome: 'rated', main: 'strong', rated: 'strong'}, 'standard'), '● Routing(strong) · chat standard -> strong');
	assert.equal(block({outcome: 'rated', main: 'standard', rated: 'standard'}, 'standard'), '● Routing(standard)');
	assert.equal(block({outcome: 'rated', main: 'standard', rated: 'standard', newTask: true}), '● Routing(standard)');
	assert.equal(block({outcome: 'rated', main: 'strong', rated: 'standard', held: true}, 'strong'), '● Routing(standard) · held, chat strong');
	assert.equal(block({outcome: 'rated', main: 'strong', rated: 'light', held: true, newTask: true}, 'strong'), '● Routing(light) · held, chat strong, new task');
	assert.equal(block({outcome: 'rated', main: 'light', rated: 'light', newTask: true}, 'strong'), '● Routing(light) · chat strong -> light, new task');
	assert.equal(block({outcome: 'rated', main: 'standard', rated: 'standard', newTask: true}, 'standard'), '● Routing(standard) · new task');
	assert.equal(block({outcome: 'kept', failed: true, main: 'standard', rated: 'standard'}, 'standard'), '● Routing(standard) · kept');
	assert.equal(block({outcome: 'kept', failed: true}), '● Routing · failed, model unchanged');
	assert.equal(block({outcome: 'pinned', main: 'max', pinned: 'max'}, 'max'), '● Routing(max) · pinned');
	assert.equal(block({outcome: 'pinned', main: 'max', pinned: 'max'}, 'strong'), '● Routing(max) · pinned, chat strong -> max');
});

test('the route dot is green when rated or pinned and dim when kept; rows stay inside the width', () => {
	assert.ok(formatRouteBlock(routeBlockOf({outcome: 'rated', rated: 'light', main: 'light'}), scrub).startsWith(`${SGR.green}●`));
	assert.ok(formatRouteBlock(routeBlockOf({outcome: 'pinned', main: 'max', pinned: 'max'}), scrub).startsWith(`${SGR.green}●`));
	assert.ok(formatRouteBlock(routeBlockOf({outcome: 'kept', failed: true}), scrub).startsWith(`${SGR.dim}●`));
	const out: Out = {kind: 'route-block', route: {outcome: 'rated', main: 'strong', rated: 'light', held: true, newTask: true}, previous: 'strong'};
	for (const width of [12, 20, 30]) assert.ok(stringCells(plain(formatOut(out, scrub, scrub, width))) <= width, String(width));
});

test('the status bar shows the task tier, a held chat tier and a pin', () => {
	assert.equal(routeBarText(undefined), '');
	assert.equal(routeBarText({outcome: 'off'}), '');
	assert.equal(routeBarText({outcome: 'rated', main: 'standard', rated: 'standard'}), 'task: standard');
	assert.equal(routeBarText({outcome: 'rated', main: 'strong', rated: 'standard', held: true}), 'task: standard · chat: strong');
	assert.equal(routeBarText({outcome: 'pinned', main: 'max', pinned: 'max'}), 'tier: max (pinned)');
	const base = {model: 'm', sessionId: '0123456789', phase: 'idle' as const};
	assert.equal(statusBarText({...base, route: 'task: light'}, scrub), '01234567 · m · task: light · idle');
	assert.equal(statusBarText({...base, route: ''}, scrub), '01234567 · m · idle');
});
