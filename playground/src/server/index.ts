import type { FileSystemTree, WebContainerProcess } from '@webcontainer/api';

import { WebContainer } from '@webcontainer/api';

import constants from './linter/constants.json';

/**
 * Extracts a JSON object from the linter output.
 */
const extractJson = (str: string) => {
	const { DIRECTIVE_OPEN, DIRECTIVE_CLOSE } = constants;
	if (str.startsWith(DIRECTIVE_OPEN) && str.endsWith(DIRECTIVE_CLOSE)) {
		return JSON.parse(str.slice(DIRECTIVE_OPEN.length, -DIRECTIVE_CLOSE.length));
	} else {
		return null;
	}
};

let webContainer: WebContainer;

type ConsoleMethods = Readonly<{
	appendLine: (string: string) => void;
	append: (string: string) => void;
	clear: () => void;
}>;

export const setupContainerServer = async ({ appendLine, append, clear }: ConsoleMethods) => {
	clear();
	appendLine('Starting WebContainer...');
	try {
		webContainer = await WebContainer.boot();
		appendLine('WebContainer started');
	} catch {
		// For local development
		// eslint-disable-next-line no-console
		console.warn('WebContainer already booted');
		appendLine('WebContainer already booted');
		// appendLine('Reloading...');
		// window.location.reload();
	}

	const linterFiles = import.meta.glob('./linter/*', { as: 'raw', eager: true });
	const linterDir: FileSystemTree = {};
	for (const [path, load] of Object.entries(linterFiles)) {
		const file = path.split('/').pop() as string;
		linterDir[file] = {
			file: { contents: load },
		};
	}
	const serverFiles: FileSystemTree = {
		linter: { directory: linterDir },
		code: { directory: {} },
	};
	await webContainer.mount(serverFiles);

	const linterServer = new LinterServer();
	let installProcess: WebContainerProcess | undefined;
	let updatingDeps = Promise.resolve<Record<string, string>>({});
	let updatingConfig = Promise.resolve();
	let restartingServer = Promise.resolve();
	let configFilename = '.markuplintrc';

	const containerServer = {
		installationExit: Promise.resolve(-1),
		updateDeps: async (packages: readonly string[], reset = false) => {
			updatingDeps = (async () => {
				if (installProcess) {
					installProcess.kill();
				}
				clear();
				const args = ['install', '-D', ...packages];
				appendLine(`npm ${args.join(' ')}`);

				if (reset) {
					try {
						await webContainer.fs.rm('node_modules', { recursive: true });
					} catch {
						// ignore if it doesn't exist
					}
					try {
						await webContainer.fs.rm('package-lock.json');
					} catch {
						// ignore if it doesn't exist
					}
				}

				installProcess = await webContainer.spawn('npm', args);
				void installProcess.output.pipeTo(
					new WritableStream({
						write(data) {
							append(data);
						},
					}),
				);
				containerServer.installationExit = installProcess.exit;
				switch (await containerServer.installationExit) {
					case 0: {
						appendLine('Installation succeeded');
						const json = await webContainer.fs.readFile('package.json', 'utf8');
						const parsed = JSON.parse(json);
						return parsed.devDependencies;
					}
					case 1: {
						appendLine('Installation failed');
						throw new Error('Installation failed');
					}
					default: // process was killed. do nothing
				}
			})();
			const result = await updatingDeps;
			if ((await containerServer.installationExit) === 0) {
				appendLine('Restarting server...');
				restartingServer = linterServer.restart();
				await restartingServer;
			} else {
				throw new Error('Installation failed');
			}
			return result;
		},
		updateConfig: async (filename: string, contents: string) => {
			updatingConfig = (async () => {
				if (filename !== configFilename) {
					await webContainer.fs.rm(configFilename);
					configFilename = filename;
				}
				await webContainer.fs.writeFile(filename, contents, 'utf8');
			})();
			await updatingConfig;

			if ((await containerServer.installationExit) === 0) {
				appendLine('Restarting server...');
				restartingServer = linterServer.restart();
				await restartingServer;
			} else {
				throw new Error('Installation failed');
			}
		},
		lint: async (filename: string, contents: string) => {
			const path = `code/${filename}`;
			await webContainer.fs.writeFile(path, contents, 'utf8');

			await Promise.all([updatingDeps, updatingConfig, restartingServer]);
			if ((await containerServer.installationExit) !== 0) {
				throw new Error('Installation failed');
			}
			const result = await linterServer.request(path, (output): output is any[] => Array.isArray(output));
			return result;
		},
		restart: async () => {
			await linterServer.restart();
		},
	};

	return containerServer;
};

class LinterServer {
	private serverInternal: Awaited<ReturnType<typeof this.start>> | undefined;

	constructor() {}

	public async request<T>(input: string, test: (output: any) => output is T) {
		if (!this.serverInternal) {
			this.serverInternal = await this.start();
		}
		await this.serverInternal.ready();
		return await this.serverInternal.request(input, test);
	}

	public async restart() {
		if (this.serverInternal) {
			this.serverInternal.process.kill();
			await this.serverInternal.process.exit;
		}
		this.serverInternal = await this.start();
	}

	private async start() {
		const locale = navigator.language;
		const localeWithoutRegion = locale.split('-')[0];
		const callbacks: ((output: any) => void)[] = [];
		const process = await webContainer.spawn('node', ['./linter/index.mjs', '--locale', localeWithoutRegion]);
		const writer = process.input.getWriter();
		const DEBUG_LOG = false;
		void process.output.pipeTo(
			new WritableStream({
				write(data) {
					if (DEBUG_LOG) {
						// eslint-disable-next-line no-console
						console.log('debug log:', data);
					}
					for (const callback of callbacks) callback(extractJson(data));
				},
			}),
		);

		/**
		 * Pass input to the linter process and wait for the output to match the test.
		 */
		const request = <T>(input: string, test: (output: any) => output is T) => {
			const promise = new Promise<T>(resolve => {
				const callback = (output: any) => {
					if (test(output)) {
						callbacks.splice(callbacks.indexOf(callback), 1);
						resolve(output);
						if (DEBUG_LOG) {
							// eslint-disable-next-line no-console
							console.log('test passed', output);
						}
					}
				};
				callbacks.push(callback);
			});
			void writer.write(input);
			return promise;
		};

		/**
		 * Wait for the linter process to be ready.
		 */
		const ready = async () => {
			await request('ready?', (output): output is 'ready' => output === 'ready');
		};

		return { process, request, ready };
	}
}
