import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createChatEngine} from '../chat/engine.js';
import type {ConsoleSdk} from '../chat/console-tools.js';
import {ensureShellTmp} from '../chat/shell-tmp.js';
import {probeLogin, type LoginProbe} from '../claude-login.js';
import {cliEnv, resolvePaths, runtimeInfo} from '../config.js';
import {createTurnLock} from '../sessions/turn-lock.js';
import {createStore} from '../store.js';
import type {ChatQueryFn} from '../types.js';
import {runnerSocketPath} from './spawn.js';
import {runRunner} from './server.js';

const isMissingModule = (err: unknown): boolean => {
	const code = (err as {code?: unknown} | null)?.code;
	return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
};

const loadChatQuery = async (): Promise<ChatQueryFn> => {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return sdk.query as unknown as ChatQueryFn;
};

const loadConsoleSdk = async (): Promise<ConsoleSdk> => {
	const [sdk, {z}] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]);
	return {createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z};
};

const main = async (): Promise<number> => {
	const dir = process.env.YENA_RUNNER_DIR;
	if (!dir || !path.isAbsolute(dir)) return 2;
	const env = {...process.env};
	delete env.YENA_RUNNER_DIR;

	const moduleDir = fileURLToPath(new URL('../..', import.meta.url));
	const home = env.YENA_HOME ?? process.cwd();
	const dataDir = path.join(env.YENA_DATA ?? path.join(home, '.yena'), 'claude');

	try {
		const store = createStore(dataDir);
		const probe: LoginProbe = async () => {
			const paths = resolvePaths(dataDir, moduleDir);
			return runtimeInfo(paths).cli ? probeLogin({bin: paths.runtimeBin, env: cliEnv(env, paths)}) : undefined;
		};
		const runner = await runRunner({
			dir,
			store,
			createEngine: (open, io, log, control) =>
				createChatEngine(
					open,
					{
						dataDir,
						env,
						moduleDir,
						log,
						loadChatQuery,
						loadConsoleSdk,
						store,
						probeLogin: probe,
						isMissingModule,
						shellTmp: ensureShellTmp,
						// The session lock is held per turn, like a chat in yena: an idle runner blocks nobody.
						turnLock: session =>
							createTurnLock({
								dir,
								kind: 'chat',
								where: 'runner',
								socket: runnerSocketPath(dir),
								sessionId: () => session()?.sessionId,
								status: () => control.status(),
								stop: control.stop,
								busy: () => 'Another session is working right now; send the message when it is done.',
								log,
							}),
					},
					io,
				),
		});
		await runner.done;
		return 0;
	} catch {
		return 1;
	}
};

// No signal listeners: SIGTERM keeps its default action and the SDK child ends when its stdin closes.
process.exitCode = await main();
process.exit();
