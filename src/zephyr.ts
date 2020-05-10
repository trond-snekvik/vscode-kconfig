import * as vscode from 'vscode';
import * as fs from 'fs';
import { execSync, exec, ExecException, ExecOptions } from 'child_process';
import * as yaml from 'yaml';
import * as kEnv from './env';
import * as glob from 'glob';
import { Repository } from './kconfig';

const MODULE_FILE = vscode.Uri.parse('zephyr:/binary.dir/Kconfig.modules');
export var isZephyr: boolean;
var moduleCount = 0;
var zephyrPath: string | undefined;

function zephyrRoot(): string | undefined {
	return zephyrPath;
	var zephyr = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath.endsWith('zephyr'))?.uri.fsPath;
	if (zephyr) {
		return zephyr;
	}

	vscode.workspace.findFiles('.west/config').then(files => {
		if (files?.length) {
			var zephyrpath = fs.readFileSync(files[0].fsPath)?.toString('utf-8').match(/\[zephyr\]\s*base\s*=\s*(\w+)/s);

		}
	});
}

function west(args: string[], callback?: (err: ExecException | null, stdout: string) => void): string | undefined {
	var exe = kEnv.getConfig('zephyr.west') ?? 'west';
	var command = exe + ' ' + ' ' + args.join(' ');

	const options: ExecOptions = {
		cwd: zephyrRoot() ?? vscode.workspace.workspaceFolders?.[0].uri.fsPath,
		env: process.env
	};

	if (callback) {
		exec(command, options, callback);
	} else {
		try {
			return execSync(exe + ' ' + args.join(' '), options).toString('utf-8');
		} catch (e) {
			return e.toString();
		}
	}

	return '';
}

export function getKconfigRoots() {
	var modules = getModules();

	return Object.values(modules)
		.map(m => {
			var file = m + "/zephyr/module.yml";
			if (!fs.existsSync(file)) {
				return m + "/zephyr/Kconfig";
			}

			var text = fs.readFileSync(file).toString("utf-8");
			var obj = yaml.parse(text);

			return m + "/" + (obj?.["build"]?.["kconfig"] ?? "zephyr/Kconfig");
		})
		.filter(file => fs.existsSync(file));
}

var toolchain_kconfig_dir: string;

export function getConfig(name: string) {
	var root = zephyrRoot();
	if (!isZephyr || !zephyrRoot()) {
		return;
	}

	switch (name) {
		case 'env':
			return {
				ARCH: board.arch,
				BOARD: board.board,
				BOARD_DIR: board.dir,
				ARCH_DIR: "arch",
				SOC_DIR: "soc",
				CMAKE_BINARY_DIR: "zephyr:/binary.dir",
				TOOLCHAIN_KCONFIG_DIR: toolchain_kconfig_dir,
			};
		case 'conf_files':
			return [`${board.dir}/${board.board}_defconfig`];
		case 'root':
			return root + '/Kconfig';
	}
}

type BoardTuple = {board: string, arch: string, dir: string};

var board: BoardTuple;
var boardStatus: vscode.StatusBarItem;

function setBoard(board: string, arch: string): Promise<BoardTuple> {
	return new Promise<BoardTuple>((resolve, reject) => {
		glob(`**/${board}_defconfig`, { absolute: true, cwd: `${zephyrRoot()}/boards/${arch}`, nounique: true, nodir: true, nobrace: true, nosort: true }, (err, matches) => {
			if (err || matches.length === 0) {
				reject();
				return;
			}

			var dir = matches[0].slice(0, matches[0].length - `${board}_defconfig`.length - 1);

			resolve({ board: board, arch: arch, dir: dir });
		});
	});
}

export function selectBoard() {
	west(['boards', '-f', '"{name}:{arch}"'], (error, stdout) => {
		if (error) {
			return;
		}

		vscode.window.showQuickPick(stdout
			.split(/\r?\n/g)
			.map(line => line.split(":"))
			.map(entry => <vscode.QuickPickItem>{label: entry[0], description: entry[1]}),
			{placeHolder: 'Select a board to use for Kconfig input'}
		).then(async selection => {
			if (!selection) {
				return;
			}

			board = await setBoard(selection!.label, selection!.description!);
			boardStatus.text = `$(circuit-board) ${board.board}`;
			vscode.workspace
				.getConfiguration("kconfig")
				.update("zephyr.board", board, vscode.ConfigurationTarget.Workspace)
				.then(
					() => console.log(`Stored new board ${board.board}`),
					err => console.error(`Failed storing board ${err}`)
				);
		});
	});
}

export function getModules() {
	try {
		return west(['list', '-f', '"{name}:{posixpath}"'])
			?.split(/\r?\n/g)
			.map(line => line.split(':'))
			.reduce((obj, entry) => {
				obj[entry[0]] = entry[1];
				return obj;
			}, {} as {[name: string]: string}) ?? {};
	} catch (e) {
		return {};
	}
}

function provideDoc(uri: vscode.Uri) {
	if (uri.toString() === MODULE_FILE.toString()) {
		return getKconfigRoots().map(root => `osource "${root}"`).join('\n\n');
	}
	return '';
}


class DocumentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
		return provideDoc(uri);
	}
}

function activateZephyr() {
	boardStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
	boardStatus.text = `$(circuit-board) ${board.board}`;
	boardStatus.command = 'kconfig.zephyr.setBoard';
	boardStatus.tooltip = 'Kconfig board';
	vscode.commands.registerCommand(boardStatus.command, () => {
		selectBoard();
	});
	boardStatus.show();

	if (process.env['ZEPHYR_SDK_INSTALL_DIR']) {
		var toolchain_dir = `${zephyrRoot()}/cmake/toolchain/zephyr`;
		var toolchains = glob.sync('*.*/generic.cmake', {cwd: toolchain_dir}).map(g => g.replace(/\/.*/, ''));
		if (toolchains.length > 0) {
			toolchain_kconfig_dir = toolchain_dir + '/' + toolchains[toolchains.length - 1];
		}
	}

	if (!toolchain_kconfig_dir) {
		if (process.env['TOOLCHAIN_KCONFIG_DIR']) {
			toolchain_kconfig_dir = process.env['TOOLCHAIN_KCONFIG_DIR'];
		} else {
			var toolchain_root = process.env['TOOLCHAIN_ROOT'] ?? zephyrRoot();
			toolchain_kconfig_dir = `${toolchain_root}/cmake/toolchain/${process.env['ZEPHYR_TOOLCHAIN_VARIANT'] ?? 'gnuarmemb'}`;
		}
	}

	var provider = new DocumentProvider();

	vscode.workspace.registerTextDocumentContentProvider('zephyr', provider);

	kEnv.registerFileProvider('zephyr', provideDoc);
}

async function checkIsZephyr() {
	var hasWestYml = vscode.workspace.workspaceFolders?.some(f => fs.existsSync(f.uri.fsPath + "/west.yml") || fs.existsSync(f.uri.fsPath + "/.west/config"));
	if (!hasWestYml) {
		return false;
	}

	var manifest = west(['config', 'manifest.path']);
	if (manifest) {
		var root = west(['topdir']);
		if (root) {
			zephyrPath = root.trim() + '/' + manifest.trim();
		}
	}

	if (!zephyrPath) {
		return false;
	}

	board = kEnv.getConfig('zephyr.board');
	if (board?.board && board?.arch) {
		if (!board.dir) {
			board = await setBoard(board.board, board.arch).catch(() => Promise.resolve(board));
		}
	} else {
		board = await setBoard('nrf52840dk_nrf52840', 'arm').catch(async () => await setBoard('nrf52_pca10040', 'arm')).catch(() => Promise.resolve(<BoardTuple>{}));
		if (!board?.board) {
			vscode.window.showErrorMessage('Couldn\'t find default board. Set kconfig.zephyr.board config manually and restart VS Code.');
		}
	}

	return !!(board?.board && board.arch && board?.dir);
}

export async function activate() {
	var hrTime = process.hrtime();
	isZephyr = await checkIsZephyr();
	if (isZephyr) {
		activateZephyr();

		hrTime = process.hrtime(hrTime);

		var time_ms = Math.round(hrTime[0] * 1000 + hrTime[1] / 1000000);
		console.log(`Zephyr activation: ${time_ms} ms`);
	}
}

var manifestWatcher: vscode.FileSystemWatcher;

export function setRepo(repo: Repository) {
	west(['topdir'], (err, out) => {
		if (!err) {
			var conf = out.trim() + '/.west/config';

			var setupManifestWatcher = () => {
				fs.readFile(conf, (e, data) => {
					var lines = data.toString('utf-8').split(/\r?\n/);
					var manifestIndex = lines.findIndex(l => l.includes('[manifest]'));
					if (manifestIndex < 0 && manifestIndex >= lines.length - 1) {
						return;
					}

					var pathLine = lines.slice(manifestIndex + 1).find(l => l.includes('path ='));
					var westManifest = out.trim() + '/' + pathLine?.split('=')[1].trim() + '/west.yml';
					if (manifestWatcher) {
						manifestWatcher.dispose();
					}
					manifestWatcher = vscode.workspace.createFileSystemWatcher(westManifest, true, false, true);

					manifestWatcher.onDidChange(e => {
						repo.onDidChange(MODULE_FILE);
					});
				});
			};

			vscode.workspace.createFileSystemWatcher(conf, true, false, true).onDidChange(e => {
				repo.onDidChange(MODULE_FILE);
				setupManifestWatcher();
			});

			setupManifestWatcher();
		}
	});
}
