export type AutoMode = {environment: string[]; allow: string[]};

export type AutoModeInput = {
	hub: string;
	configDir: string;
	scratch?: string;
	workplace?: string;
	stage?: string;
	accountDir?: string;
};

const join = (parts: string[]): string =>
	parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

export function buildAutoMode(p: AutoModeInput): AutoMode {
	const places = [
		...(p.workplace === undefined
			? []
			: [`projects under ${p.workplace}/<name> once the user isolated them with the yena console command "project isolate" (yena's permission layer refuses writes to other projects)`]),
		...(p.stage === undefined ? [] : [`their stage copies under ${p.stage}`]),
		`the md hub ${p.hub} (yena's instructions, notes, project docs and task files)`,
		...(p.scratch === undefined ? [] : [`this chat's scratch folder ${p.scratch}`]),
	];
	const secrets = [
		...(p.accountDir === undefined ? [] : [`${p.accountDir} (encrypted, owned by yena's account module)`]),
		`Claude Code's config ${p.configDir} (its login files and backups)`,
	];
	const scope = [
		...(p.workplace === undefined ? [] : [`the isolated projects under ${p.workplace}`]),
		...(p.stage === undefined ? [] : [`their stages under ${p.stage}`]),
		`the md hub ${p.hub}`,
		...(p.scratch === undefined ? [] : [`the scratch folder ${p.scratch}`]),
	];
	return {
		environment: [
			'$defaults',
			"Organization: yena, a single user's developer assistant (a terminal app). Primary use: software development on the user's own projects.",
			"Host containment: Claude Code runs as root inside yena's Docker container. Bash runs in Claude Code's bubblewrap sandbox: it writes only to the trusted locations below and /tmp, reads of secrets are denied, and the network reaches only github.com and registry.npmjs.org. The user's host machine and home are outside the container.",
			`Trusted local working locations: ${join(places)}.`,
			"Source control: github.com/hyenayena and every repository under it (yena and its modules); the user's other projects push to their own configured remotes.",
			`Secrets management: credentials live in ${join(secrets)}; the assistant never reads, prints or copies them, and git uses the account yena configures.`,
			'Project rules: .yenarules files and the project rules kept by yena list paths under deny read, ask read, deny write and ask write; only the user edits them.',
		],
		allow: [
			'$defaults',
			`Local Operations in yena: ${join(scope)} are all in project scope (not other repositories). Creating, editing, moving and deleting files and folders there for the user's task is a Local Operation. This does not cover paths under any deny or ask rule, the rules files themselves, discarding uncommitted work (git reset --hard, git clean, git checkout -- .) the user did not ask for, commits or pushes the user did not ask for, or anything else a BLOCK rule names.`,
		],
	};
}
