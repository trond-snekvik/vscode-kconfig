import * as vscode from 'vscode';
import * as fs from 'fs';
import { execSync, exec, ExecException } from 'child_process';
import * as yaml from 'yaml';
import * as kEnv from './env';
import { Repository } from './kconfig';

const MODULE_FILE = vscode.Uri.parse('zephyr:/binary.dir/Kconfig.modules');

export function isZephyr(): boolean {
	return vscode.workspace.workspaceFolders?.some(f => fs.existsSync(f.uri.fsPath + "/west.yml")) ?? false;
}

function zephyrRoot(): string {
	return vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath.endsWith('zephyr'))?.uri.fsPath ?? '';
}

function west(args: string[], callback?: (err: ExecException | null, stdout: string) => void): string | undefined {
	var exe = kEnv.getConfig('zephyr.west') ?? 'west';
	var command = exe + ' ' + args.join(' ');
	if (callback) {
		exec(command, callback);
	} else {
		try {
			return execSync(exe + ' ' + args.join(' ')).toString('utf-8');
		} catch (e) {
			return undefined;
		}
	}
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

			return m + "/" + (obj["build"]["kconfig"] || "zephyr/Kconfig");
		})
		.filter(file => fs.existsSync(file));
}

/*
	"kconfig.env": {
		"ARCH": "arm",
		"BOARD": "nrf52_pca10040",
		"BOARD_DIR": "${workspaceFolder:zephyr}/boards/${ARCH}/${BOARD}",
		"ARCH_DIR": "arch",
		"SOC_DIR": "soc",
		"CMAKE_BINARY_DIR": "${workspaceFolder:nrf}/samples/bluetooth/mesh/light/build"
	},
	"kconfig.conf_files": [
		"${BOARD_DIR}/${BOARD}_defconfig"
	],
	"kconfig.root": "${workspaceFolder:zephyr}/Kconfig",
*/

export function getConfig(name: string) {
	switch (name) {
		case 'env':
			return {
				ARCH: board.arch,
				BOARD: board.board,
				BOARD_DIR: `${zephyrRoot()}/boards/${board.arch}/${board.board}`,
				ARCH_DIR: "arch",
				SOC_DIR: "soc",
				CMAKE_BINARY_DIR: "zephyr:/binary.dir"
			};
		case 'conf_files':
			return [`${zephyrRoot()}/boards/${board.arch}/${board.board}/${board.board}_defconfig`];
		case 'root':
			return zephyrRoot() + '/Kconfig';
	}
}

type BoardTuple = {board: string, arch: string};

var board: BoardTuple = vscode.workspace.getConfiguration('kconfig').get('zephyr.board') ?? {board: 'nrf52_pca10040', arch: 'arm'};
var boardStatus: vscode.StatusBarItem;


export function selectBoard(): Promise<BoardTuple> {
	return new Promise<BoardTuple>((resolve, reject) => {
		west(['boards', '-f', '"{name}:{arch}"'], (error, stdout) => {
			if (error) {
				reject();
				return;
			}

			vscode.window.showQuickPick(stdout
				.split(/\r?\n/g)
				.map(line => line.split(":"))
				.map(entry => <vscode.QuickPickItem>{label: entry[0], description: entry[1]}),
				{placeHolder: 'Select a board to use for Kconfig input'}
			).then(selection => {
				if (selection) {
					resolve({board: selection!.label, arch: selection!.description!});
				} else {
					reject();
				}
			});
		});
	}).then(tuple => {
		board = tuple;
		boardStatus.text = `$(tools) ${board.board}`;
		vscode.workspace
			.getConfiguration("kconfig")
			.update("zephyr.board", board, vscode.ConfigurationTarget.Workspace)
			.then(
				() => console.log(`Stored new board ${board.board}`),
				err => console.error(`Failed storing board ${err}`)
			);
		return tuple;
	}, () => {
		return board;
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

export function activate() {
	if (isZephyr()) {
		boardStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
		boardStatus.text = `$(tools) ${board.board}`;
		boardStatus.command = 'kconfig.zephyr.setBoard';
		boardStatus.tooltip = 'Kconfig board';
		vscode.commands.registerCommand(boardStatus.command, () => {
			selectBoard();
		});
		boardStatus.show();

		var provider = new DocumentProvider();

		vscode.workspace.registerTextDocumentContentProvider('zephyr', provider);

		kEnv.registerFileProvider('zephyr', provideDoc);
	}
}
