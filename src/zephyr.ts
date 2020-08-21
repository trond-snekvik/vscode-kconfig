/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import { execSync, exec, ExecException, ExecOptions } from 'child_process';
import * as yaml from 'yaml';
import * as kEnv from './env';
import * as glob from 'glob';
import * as path from 'path';
import { Repository } from './kconfig';
import { env } from 'process';

const MODULE_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.modules');
const SOC_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.soc');
const SOC_DEFCONFIG_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.soc.defconfig');
const SOC_ARCH_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.soc.arch');
export var isZephyr: boolean;
export var zephyrRoot: string | undefined;
var westVersion: string;

function west(args: string[], callback?: (err: ExecException | null, stdout: string) => void): string {
	var exe = kEnv.getConfig('zephyr.west');
	if (!exe) {
		if (process.platform === 'win32') {
			exe = 'west';
		} else {
			exe = env['HOME'] + '/.local/bin/west';
		}
	}
	var command = exe + ' ' + args.join(' ');

	const options: ExecOptions = {
		cwd: zephyrRoot ?? vscode.workspace.workspaceFolders?.find(w => w.name.match(/zephyr/i))?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0].uri.fsPath,
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
	if (!isZephyr || !zephyrRoot) {
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
				CMAKE_BINARY_DIR: "kconfig://zephyr/binary.dir",
				KCONFIG_BINARY_DIR: "kconfig://zephyr/binary.dir",
				TOOLCHAIN_KCONFIG_DIR: toolchain_kconfig_dir,
				ZEPHYR_ROOT: zephyrRoot,
				ZEPHYR_BASE: zephyrRoot,
			};
		case 'conf_files':
			return [`${board.dir}/${board.board}_defconfig`];
	}
}

type BoardTuple = {board: string, arch: string, dir: string};

var board: BoardTuple;
var boardStatus: vscode.StatusBarItem;

function setBoard(board: string, arch: string): Promise<BoardTuple> {
	return new Promise<BoardTuple>((resolve, reject) => {
		glob(`**/${board}_defconfig`, { absolute: true, cwd: `${zephyrRoot}/boards/${arch}`, nounique: true, nodir: true, nobrace: true, nosort: true }, (err, matches) => {
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
			.map(line => line.match(/(.*?):(.*)/))
			.filter(line => line)
			.reduce((obj, entry) => {
				obj[entry![1]] = entry![2];
				return obj;
			}, {} as {[name: string]: string}) ?? {};
	} catch (e) {
		return {};
	}
}

function getKconfigSocRoots() {
	let additional_roots = kEnv.getConfig('kconfig.zephyr.soc_roots') as string[] | undefined;
	if (additional_roots) {
		return [
			zephyrRoot,
			...additional_roots,
		];
	}

	return [zephyrRoot];
}

function provideDoc(uri: vscode.Uri) {
	if (uri.toString() === MODULE_FILE.toString()) {
		return getKconfigRoots().map(root => `osource "${root}"`).join('\n\n');
	}
	if (uri.toString() === SOC_DEFCONFIG_FILE.toString()) {
		return getKconfigSocRoots().map(root => `osource "${root}/soc/$(ARCH)/*/Kconfig.defconfig"`).join('\n');
	}
	if (uri.toString() === SOC_FILE.toString()) {
		return getKconfigSocRoots().map(root => `osource "${root}/soc/$(ARCH)/*/Kconfig.soc"`).join('\n');
	}
	if (uri.toString() === SOC_ARCH_FILE.toString()) {
		return getKconfigSocRoots().map(root => `osource "${root}/soc/$(ARCH)/Kconfig"\nosource "${root}/soc/$(ARCH)/*/Kconfig"`).join('\n');
	}
	return '';
}


class DocumentProvider implements vscode.TextDocumentContentProvider {
	provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): vscode.ProviderResult<string> {
		return provideDoc(uri);
	}
}

function activateZephyr(context: vscode.ExtensionContext) {
	boardStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
	boardStatus.text = `$(circuit-board) ${board.board}`;
	boardStatus.command = 'kconfig.zephyr.setBoard';
	boardStatus.tooltip = 'Kconfig board';

	let toggleBoardStatus = (e?: vscode.TextEditor) => {
		if (e?.document?.languageId === 'properties') {
			boardStatus.show();
		} else {
			boardStatus.hide();
		}
	};

	toggleBoardStatus(vscode.window.activeTextEditor);
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(toggleBoardStatus));

	if (process.env['ZEPHYR_SDK_INSTALL_DIR']) {
		var toolchain_dir = `${zephyrRoot}/cmake/toolchain/zephyr`;
		var toolchains = glob.sync('*.*/generic.cmake', {cwd: toolchain_dir}).map(g => g.replace(/\/.*/, ''));
		if (toolchains.length > 0) {
			toolchain_kconfig_dir = toolchain_dir + '/' + toolchains[toolchains.length - 1];
		}
	}

	if (!toolchain_kconfig_dir) {
		if (process.env['TOOLCHAIN_KCONFIG_DIR']) {
			toolchain_kconfig_dir = process.env['TOOLCHAIN_KCONFIG_DIR'];
		} else {
			var toolchain_root = process.env['TOOLCHAIN_ROOT'] ?? zephyrRoot;
			toolchain_kconfig_dir = `${toolchain_root}/cmake/toolchain/${process.env['ZEPHYR_TOOLCHAIN_VARIANT'] ?? 'gnuarmemb'}`;
		}
	}

	context.subscriptions.push(vscode.commands.registerCommand('kconfig.zephyr.setBoard', () => {
		if (isZephyr) {
			selectBoard();
		} else if (vscode.workspace.workspaceFolders) {
			vscode.window.showWarningMessage('Not in a Zephyr workspace.');
		} else {
			vscode.window.showWarningMessage('Zephyr must be opened as a folder or workspace.');
		}
	}));

	var provider = new DocumentProvider();

	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('kconfig', provider));

	kEnv.registerFileProvider('kconfig', provideDoc);
}

function getZephyrBase(): string | undefined {
	let base = kEnv.getConfig('zephyr.base') as string;
	if (base) {
		if (env['HOME']) {
			base = base.replace(/^~\//, env['HOME'] as string + '/');
		}

		return path.resolve(base);
	}

	return process.env['ZEPHYR_BASE'] as string;
}

function openConfig(entry: string) {
	vscode.commands.executeCommand('workbench.action.openSettings', entry);
}

function configZephyrBase() {
	openConfig('kconfig.zephyr.base');
}

async function checkIsZephyr(): Promise<boolean> {
	if (!await new Promise<boolean>(resolve => {
		west(['-V'], (err, out) => {
			if (err) {
				vscode.window.showErrorMessage('Unable to run west', 'Configure zephyr.west').then(() => openConfig('kconfig.zephyr.west'));
				resolve(false);
			} else {
				let match = out.match(/v\d+\.\d+.\d+/);
				if (match) {
					westVersion = match[0];
				}
				resolve(true);
			}

		});
	})) {
		return false;
	}

	let base = getZephyrBase() ??
		await new Promise<string>(resolve => {
			west(['topdir'], (err, out) => {
				if (err) {
					resolve(undefined);
				} else {
					resolve(`${out.trim()}/${west(['config', 'zephyr.base']).trim()}`);
				}
			});
		});
	if (!base) {
		vscode.window.showErrorMessage('Unable to get west topdir.', 'Configure zephyr.base').then(e => configZephyrBase());
		return false;
	}

	zephyrRoot = kEnv.resolvePath(base).fsPath;
	if (!zephyrRoot) {
		vscode.window.showErrorMessage('Invalid Zephyr base: ' + base, 'Configure...').then(e => configZephyrBase());
		return false;
	}

	board = kEnv.getConfig('zephyr.board');
	if (board?.board && board?.arch) {
		if (!board.dir) {
			board = await setBoard(board.board, board.arch).catch(() => Promise.resolve(board));
		}
	} else {
		const backupBoards = [
			{ board: 'nrf52840dk_nrf52840', arch: 'arm', dir: `${zephyrRoot}/boards/arm/nrf52840dk_nrf52840` },
			{ board: 'nrf52_pca10040', arch: 'arm', dir: `${zephyrRoot}/boards/arm/nrf52_pca10040` },
		];

		board = backupBoards.find(b => fs.existsSync(b.dir)) ?? <BoardTuple>{};
	}

	return !!(board?.board && board.arch && board.dir);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	let run = async () => {

		var hrTime = process.hrtime();
		isZephyr = await checkIsZephyr();
		if (isZephyr) {
			activateZephyr(context);

			hrTime = process.hrtime(hrTime);

			var time_ms = Math.round(hrTime[0] * 1000 + hrTime[1] / 1000000);
			console.log(`Zephyr activation: ${time_ms} ms`);
		}

		return isZephyr;
	};

	await run();
	if (isZephyr) {
		return Promise.resolve();
	}

	return new Promise(resolve => {
		let disposable = vscode.workspace.onDidChangeConfiguration(e => {
			if (!isZephyr && e.affectsConfiguration('kconfig.zephyr')) {
				kEnv.update();
				run().then(worked => {
					if (worked && zephyrRoot) {
						vscode.window.showInformationMessage(`Found Zephyr in ${zephyrRoot}`);
						resolve();
					}
				});
			}
		});
		context.subscriptions.push(disposable);
	});
}

var manifestWatcher: vscode.FileSystemWatcher;

export function setRepo(repo: Repository, context: vscode.ExtensionContext) {
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
					context.subscriptions.push(manifestWatcher);
					context.subscriptions.push(manifestWatcher.onDidChange(e => {
						repo.onDidChange(MODULE_FILE);
					}));
				});
			};

			context.subscriptions.push(vscode.workspace.createFileSystemWatcher(conf, true, false, true).onDidChange(e => {
				repo.onDidChange(MODULE_FILE);
				setupManifestWatcher();
			}));

			setupManifestWatcher();
		}
	});
}
