import {randomBytes} from 'node:crypto';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

export const atomicWriteFile = async (file: string, data: string, mode = 0o600): Promise<void> => {
	await mkdir(dirname(file), {recursive: true});
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		await writeFile(tmp, data, {flag: 'wx', mode});
		await rename(tmp, file);
	} catch (err) {
		await rm(tmp, {force: true});
		throw err;
	}
};
