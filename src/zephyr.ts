/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import { execSync, exec, ExecException, ExecOptions } from 'child_process';
import * as yaml from 'yaml';
import * as kEnv from './env';
import * as glob from 'glob';
import * as path from 'path';
import { env } from 'process';
import { countReset } from 'console';

const MODULE_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.modules');
const SOC_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.soc');
const SOC_DEFCONFIG_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.soc.defconfig');
const SOC_ARCH_FILE = vscode.Uri.parse('kconfig://zephyr/binary.dir/Kconfig.soc.arch');
export var zephyrRoot: string | undefined;
var westVersion: string;
var westExe: string;
var westEnv = process.env;

function west(
    args: string[],
    callback?: (err: ExecException | null, stdout: string) => void
): string {
    var command = westExe + ' ' + args.join(' ');

    const options: ExecOptions = {
        cwd:
            zephyrRoot ??
            vscode.workspace.workspaceFolders?.find((w) => w.name.match(/zephyr/i))?.uri.fsPath ??
            vscode.workspace.workspaceFolders?.[0].uri.fsPath,
        env: westEnv,
    };

    if (callback) {
        exec(command, options, callback);
    } else {
        try {
            return execSync(westExe + ' ' + args.join(' '), options).toString('utf-8');
        } catch (e) {
            return e.toString();
        }
    }

    return '';
}

export function getKconfigRoots() {
    var modules = getModules();

    return Object.values(modules)
        .map((m) => {
            var file = m + '/zephyr/module.yml';
            if (!fs.existsSync(file)) {
                return m + '/zephyr/Kconfig';
            }

            var text = fs.readFileSync(file).toString('utf-8');
            var obj = yaml.parse(text);

            return m + '/' + (obj?.['build']?.['kconfig'] ?? 'zephyr/Kconfig');
        })
        .filter((file) => fs.existsSync(file));
}

var toolchain_kconfig_dir: string;

export function getConfig(): { [name: string]: string } {
    if (!zephyrRoot) {
        return {};
    }

    const retval = {
        ARCH_DIR: 'arch',
        SOC_DIR: 'soc',
        CMAKE_BINARY_DIR: 'kconfig://zephyr/binary.dir',
        KCONFIG_BINARY_DIR: 'kconfig://zephyr/binary.dir',
        TOOLCHAIN_KCONFIG_DIR: toolchain_kconfig_dir,
        ZEPHYR_ROOT: zephyrRoot,
        ZEPHYR_BASE: zephyrRoot,
    };

    if (board) {
        Object.assign(retval, {
            ARCH: board.arch,
            BOARD: board.board,
            BOARD_DIR: board.dir,
        });
    }

    return retval;
}

export type BoardTuple = { board: string; arch: string; dir: string };

export var board: BoardTuple | undefined;
var boardStatus: vscode.StatusBarItem | undefined;

export function boardConfFile(): vscode.Uri | undefined {
    if (board) {
        return vscode.Uri.file(`${board.dir}/${board.board}_defconfig`);
    }
}

export function setBoard(b: BoardTuple) {
    board = b;
    if (boardStatus) {
        boardStatus.text = `$(circuit-board) ${b.board}`;
    }

    kEnv.update();
}

function resolveBoard(board: string, arch: string): Promise<BoardTuple> {
    return new Promise<BoardTuple>((resolve, reject) => {
        glob(
            `**/${board}_defconfig`,
            {
                absolute: true,
                cwd: `${zephyrRoot}/boards/${arch}`,
                nounique: true,
                nodir: true,
                nobrace: true,
                nosort: true,
            },
            (err, matches) => {
                if (err || matches.length === 0) {
                    reject();
                    return;
                }

                var dir = path.dirname(matches[0]);

                resolve({ board, arch, dir });
            }
        );
    });
}

async function getBoards(): Promise<BoardTuple[]> {
    return new Promise((resolve) => {
        west(['boards', '-f', '"{name}:{arch}:{dir}"'], (err, out) => {
            if (err) {
                resolve([]);
                return;
            }

            resolve(
                out
                    .split(/\r?\n/g)
                    .map((line) => line.split(':'))
                    .filter((parts) => parts?.length === 3)
                    .map((parts) => {
                        return {
                            board: parts[0],
                            arch: parts[1],
                            dir: parts[2],
                        } as BoardTuple;
                    })
            );
        });
    });
}

interface BoardQuickPick extends vscode.QuickPickItem {
    board: BoardTuple;
}

export async function selectBoard() {
    const boards = await getBoards();
    vscode.window
        .showQuickPick(
            boards.map(
                (board) => <BoardQuickPick>{ label: board.board, description: board.arch, board }
            ),
            { placeHolder: 'Select a board to use for Kconfig input' }
        )
        .then(async (selection) => {
            if (!selection) {
                return;
            }

            setBoard(selection.board);
            updateBoardConfig(selection.board);
        });
}

export async function boardFromName(id: string, uri?: vscode.Uri): Promise<BoardTuple> {
    if (!uri) {
        return (
            (await getBoards()).find((board) => board.board === id) ??
            Promise.reject(`Unknown board ${id}`)
        );
    }

    return {
        board: id,
        arch: path.basename(path.dirname(uri.fsPath)),
        dir: uri.fsPath,
    };
}

function updateBoardConfig(newBoard: BoardTuple) {
    vscode.workspace
        .getConfiguration('kconfig')
        .update('zephyr.board', board, vscode.ConfigurationTarget.Workspace)
        .then(
            () => console.log(`Stored new board ${newBoard.board}`),
            (err) => console.error(`Failed storing board ${err}`)
    );
}

export function getModules() {
    try {
        return (
            west(['list', '-f', '"{name}:{posixpath}"'])
                ?.split(/\r?\n/g)
                .map((line) => line.match(/(.*?):(.*)/))
                .filter((line) => line)
                .reduce((obj, entry) => {
                    obj[entry![1]] = entry![2];
                    return obj;
                }, {} as { [name: string]: string }) ?? {}
        );
    } catch (e) {
        return {};
    }
}

function getKconfigSocRoots() {
    let additional_roots = kEnv.getConfig('kconfig.zephyr.soc_roots') as string[] | undefined;
    if (additional_roots) {
        return [zephyrRoot, ...additional_roots];
    }

    return [zephyrRoot];
}

function provideDoc(uri: vscode.Uri) {
    if (uri.toString() === MODULE_FILE.toString()) {
        return getKconfigRoots()
            .map((root) => `osource "${root}"`)
            .join('\n\n');
    }
    if (uri.toString() === SOC_DEFCONFIG_FILE.toString()) {
        return getKconfigSocRoots()
            .map((root) => `osource "${root}/soc/$(ARCH)/*/Kconfig.defconfig"`)
            .join('\n');
    }
    if (uri.toString() === SOC_FILE.toString()) {
        return getKconfigSocRoots()
            .map((root) => `osource "${root}/soc/$(ARCH)/*/Kconfig.soc"`)
            .join('\n');
    }
    if (uri.toString() === SOC_ARCH_FILE.toString()) {
        return getKconfigSocRoots()
            .map(
                (root) =>
                    `osource "${root}/soc/$(ARCH)/Kconfig"\nosource "${root}/soc/$(ARCH)/*/Kconfig"`
            )
            .join('\n');
    }
    return '';
}

class DocumentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(
        uri: vscode.Uri,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<string> {
        return provideDoc(uri);
    }
}

export function createBoardStatusbarItem() {
    boardStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 2);
    boardStatus.command = 'kconfig.zephyr.setBoard';
    boardStatus.tooltip = 'Kconfig board';

    let toggleBoardStatus = (e?: vscode.TextEditor) => {
        if (board) {
            boardStatus!.text = `$(circuit-board) ${board.board}`;
            if (e?.document?.languageId === 'properties') {
                boardStatus!.show();
                return;
            }
        }

        boardStatus!.hide();
    };

    toggleBoardStatus(vscode.window.activeTextEditor);
    kEnv.extensionContext.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(toggleBoardStatus)
    );
}

export function activate(context: vscode.ExtensionContext) {
    if (westEnv['ZEPHYR_SDK_INSTALL_DIR']) {
        var toolchain_dir = `${zephyrRoot}/cmake/toolchain/zephyr`;
        var toolchains = glob
            .sync('*.*/generic.cmake', { cwd: toolchain_dir })
            .map((g) => g.replace(/\/.*/, ''));
        if (toolchains.length > 0) {
            toolchain_kconfig_dir = toolchain_dir + '/' + toolchains[toolchains.length - 1];
        }
    }

    if (!toolchain_kconfig_dir) {
        if (westEnv['TOOLCHAIN_KCONFIG_DIR']) {
            toolchain_kconfig_dir = westEnv['TOOLCHAIN_KCONFIG_DIR'];
        } else {
            var toolchain_root = westEnv['TOOLCHAIN_ROOT'] ?? zephyrRoot;
            toolchain_kconfig_dir = `${toolchain_root}/cmake/toolchain/${
                westEnv['ZEPHYR_TOOLCHAIN_VARIANT'] ?? 'gnuarmemb'
            }`;
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('kconfig.zephyr.setBoard', () => {
            if (zephyrRoot) {
                selectBoard();
            } else if (vscode.workspace.workspaceFolders) {
                vscode.window.showWarningMessage('Not in a Zephyr workspace.');
            } else {
                vscode.window.showWarningMessage('Zephyr must be opened as a folder or workspace.');
            }
        })
    );

    var provider = new DocumentProvider();

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('kconfig', provider)
    );

    kEnv.registerFileProvider('kconfig', provideDoc);
}

function getZephyrBase(): string | undefined {
    let base = kEnv.getConfig('zephyr.base') as string;
    if (base) {
        if (env['HOME']) {
            base = base.replace(/^~\//, (env['HOME'] as string) + '/');
        }

        return path.resolve(base);
    }

    return westEnv['ZEPHYR_BASE'] as string;
}

export async function setZephyrBase(uri: vscode.Uri): Promise<void> {
    if (uri.fsPath !== zephyrRoot) {
        zephyrRoot = uri.fsPath;
    }
}

function openConfig(entry: string) {
    vscode.commands.executeCommand('workbench.action.openSettings', entry);
}

function configZephyrBase() {
    openConfig('kconfig.zephyr.base');
}

async function checkIsZephyr(): Promise<boolean> {
    if (
        !(await new Promise<boolean>((resolve) => {
            west(['-V'], (err, out) => {
                if (err) {
                    vscode.window
                        .showErrorMessage('Unable to run West', 'Configure West location')
                        .then((e) => {
                            if (e) {
                                openConfig('kconfig.zephyr.west');
                            }
                        });
                    resolve(false);
                } else {
                    let match = out.match(/v\d+\.\d+.\d+/);
                    if (match) {
                        westVersion = match[0];
                    }
                    resolve(true);
                }
            });
        }))
    ) {
        return false;
    }

    let base = getZephyrBase();
    if (!base) {
        vscode.window
            .showErrorMessage('Unable to get west topdir.', 'Configure zephyr.base')
            .then((e) => {
                if (e) {
                    configZephyrBase();
                }
            });
        return false;
    }

    zephyrRoot = kEnv.resolvePath(base).fsPath;
    if (!zephyrRoot) {
        vscode.window.showErrorMessage('Invalid Zephyr base: ' + base, 'Configure...').then((e) => {
            if (e) {
                configZephyrBase();
            }
        });
        return false;
    }

    board = kEnv.getConfig('zephyr.board');
    if (board?.board && board?.arch) {
        if (!board.dir) {
            board = await resolveBoard(board.board, board.arch).catch(() => Promise.resolve(board));
        }
    } else {
        const backupBoards = [
            {
                board: 'nrf52840dk_nrf52840',
                arch: 'arm',
                dir: `${zephyrRoot}/boards/arm/nrf52840dk_nrf52840`,
            },
            {
                board: 'nrf52_pca10040',
                arch: 'arm',
                dir: `${zephyrRoot}/boards/arm/nrf52_pca10040`,
            },
        ];

        board = backupBoards.find((b) => fs.existsSync(b.dir)) ?? <BoardTuple>{};
    }

    return !!(board?.board && board.arch && board.dir);
}

export async function setWest(westUri: string, env?: typeof process.env): Promise<void> {
    if (env) {
        westEnv = env;
    }

    if (westUri !== westExe) {
        westExe = westUri;
    }
}

function findWest() {
    westExe = kEnv.getConfig('zephyr.west');
    if (westExe) {
        return;
    }

    if (process.platform === 'win32') {
        westExe = 'west';
    } else {
        let candidates = [];
        candidates.push(env['HOME'] + '/.local/bin/west'); // installed with --user
        candidates.push('/usr/bin/west');
        candidates.push('/usr/local/bin/west');
        westExe = candidates.find((p) => fs.existsSync(p)) ?? 'west';
    }
}

export async function resolveEnvironment(context: vscode.ExtensionContext): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders) {
        let warning = (doc: vscode.TextDocument) => {
            if (
                doc.languageId === 'kconfig' ||
                (doc.languageId === 'plaintext' && doc.fileName.startsWith('Kconfig.'))
            ) {
                vscode.window
                    .showWarningMessage(
                        `The Kconfig extension only runs in VS Code Workspaces and folders.`,
                        'Open folder...',
                        'Disable extension'
                    )
                    .then((e) => {
                        if (e === 'Open folder...') {
                            vscode.commands.executeCommand('vscode.openFolder');
                        } else if (e === 'Disable extension') {
                            kEnv.setConfig('disable', true, vscode.ConfigurationTarget.Global);
                        }
                    });
            }
        };

        context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(warning));
        if (vscode.window.activeTextEditor?.document) {
            warning(vscode.window.activeTextEditor?.document);
        }

        return false;
    }

    let run = async () => {
        findWest();

        const valid = await checkIsZephyr();
        if (!valid && zephyrRoot) {
            vscode.window
                .showErrorMessage(`Kconfig: Couldn't find board`, 'Configure')
                .then((e) => {
                    if (e) {
                        openConfig('kconfig.zephyr.board');
                    }
                });
        }

        return valid;
    };

    if (await run()) {
        return true;
    }

    return new Promise<boolean>((resolve) => {
        let disposable = vscode.workspace.onDidChangeConfiguration((e) => {
            if (!zephyrRoot && e.affectsConfiguration('kconfig.zephyr')) {
                kEnv.update();
                run().then((worked) => {
                    if (worked && zephyrRoot) {
                        vscode.window.showInformationMessage(`Found Zephyr in ${zephyrRoot}`);
                        resolve(true);
                    }
                });
            }
        });
        context.subscriptions.push(disposable);
    });
}

export function onWestChange(context: vscode.ExtensionContext, westChange: () => any) {
    west(['topdir'], async (err, out) => {
        if (!err) {
            let conf = out.trim() + '/.west/config';

            let confDoc = await vscode.workspace.openTextDocument(conf);
            if (!confDoc) {
                return;
            }

            var setupManifestWatcher = () => {
                let lines = confDoc.getText().split(/\r?\n/);
                var manifestIndex = lines.findIndex((l) => l.includes('[manifest]'));
                if (manifestIndex < 0 && manifestIndex >= lines.length - 1) {
                    return;
                }

                var pathLine = lines.slice(manifestIndex + 1).find((l) => l.includes('path ='));
                var westManifest = out.trim() + '/' + pathLine?.split('=')[1].trim() + '/west.yml';

                vscode.workspace.openTextDocument(westManifest).then(
                    (doc) => {
                        context.subscriptions.push(
                            vscode.workspace.onDidChangeTextDocument((e) => {
                                if (e.document.uri.toString() === doc.uri.toString()) {
                                    westChange();
                                }
                            })
                        );
                    },
                    (_) => {}
                );
            };

            context.subscriptions.push(
                vscode.workspace.onDidChangeTextDocument((e) => {
                    if (e.document.uri.toString() === confDoc.uri.toString()) {
                        westChange();
                        setupManifestWatcher();
                    }
                })
            );

            setupManifestWatcher();
        }
    });
}
