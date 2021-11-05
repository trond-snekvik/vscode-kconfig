/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as kEnv from './env';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';
import { existsSync, readFile } from 'fs';

let client: LanguageClient;
const knownContexts: vscode.Uri[] = [];

function startServer(ctx: vscode.ExtensionContext) {
    const python = kEnv.getConfig<string>('python');

    const serverOptions: ServerOptions = {
        command: python,
        args: [path.resolve(ctx.extensionPath, 'srv', 'kconfiglsp.py')],
        options: {
            cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
            env: kEnv.get(),
        },
        transport: TransportKind.pipe,
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                pattern: '**/*.conf',
                scheme: 'file',
            },
            {
                language: 'c',
                scheme: 'file',
            },
            {
                language: 'cpp',
                scheme: 'file',
            },
            {
                language: 'kconfig',
                scheme: 'file',
            },
        ],

        diagnosticCollectionName: 'kconfig',
    };

    client = new LanguageClient('Kconfig', serverOptions, clientOptions);
    ctx.subscriptions.push(client.start());
}

async function addKconfigContexts() {
    const caches = await vscode.workspace.findFiles(
        '**/CMakeCache.txt',
        '**/{twister,sanity}-out*'
    );

    await client.onReady();

    await Promise.all(
        caches.map((cache) =>
            addBuild(vscode.Uri.parse(path.dirname(cache.fsPath))).catch(() => {
                /* Ignore */
            })
        )
    );

    const cacheWatcher = vscode.workspace.createFileSystemWatcher('**/CMakeCache.txt');

    cacheWatcher.onDidChange(addBuild);
    cacheWatcher.onDidCreate(addBuild);
    cacheWatcher.onDidDelete(removeBuild);
}

export function activate(ctx: vscode.ExtensionContext): Promise<void> {
    vscode.commands.registerCommand('kconfig.add', () => {
        vscode.window
            .showOpenDialog({
                canSelectFolders: true,
                openLabel: 'Add',
                defaultUri: vscode.workspace.workspaceFolders?.[0].uri,
            })
            ?.then((uris) => {
                if (uris) {
                    addBuild(uris[0]);
                }
            });
    });

    startServer(ctx);
    return addKconfigContexts();
}

export async function setMainBuild(uri?: vscode.Uri): Promise<void> {
    if (uri) {
        await addBuild(uri);
    }

    client.sendNotification('kconfig/setMainBuild', { uri: uri?.toString() ?? '' });
}

interface AddBuildParams {
    root: string;
    env: typeof process.env;
    conf: string[];
}

interface CMakeCache {
    [name: string]: string[];
}

function parseCmakeCache(uri: vscode.Uri): Promise<CMakeCache> {
    return new Promise<CMakeCache>((resolve, reject) => {
        readFile(uri.fsPath, { encoding: 'utf-8' }, (err, data) => {
            if (err) {
                reject(err);
            } else {
                const lines = data.split(/\r?\n/g);
                const entries: CMakeCache = {};
                lines.forEach((line) => {
                    const match = line.match(/^(\w+)(?::\w+)?=(.*)/);
                    if (match) {
                        entries[match[1]] = match[2].trim().split(';');
                    }
                });

                resolve(entries);
            }
        });
    });
}

interface ZephyrModule {
    name: string;
    path: string;
}

function parseZephyrModules(uri: vscode.Uri): Promise<ZephyrModule[]> {
    return new Promise<ZephyrModule[]>((resolve, reject) => {
        readFile(uri.fsPath, { encoding: 'utf-8' }, (err, data) => {
            if (err) {
                reject(err);
            } else {
                const lines = data.split(/\r?\n/g);
                const modules = new Array<ZephyrModule>();
                lines.forEach((line) => {
                    const match = line.match(/^"([^"]+)":"([^"]+)"/);
                    if (match) {
                        modules.push({
                            name: match[1],
                            path: match[2],
                        });
                    }
                });

                resolve(modules);
            }
        });
    });
}

interface BuildResponse {
    id: string;
}

export async function addBuild(uri: vscode.Uri): Promise<BuildResponse | undefined> {
    if (knownContexts.find((u) => u.fsPath === uri.fsPath)) {
        return;
    }

    const cache = await parseCmakeCache(vscode.Uri.joinPath(uri, 'CMakeCache.txt'));
    const modules = await parseZephyrModules(vscode.Uri.joinPath(uri, 'zephyr_modules.txt'));

    const board = cache['CACHED_BOARD'][0];
    const boardDir = cache['BOARD_DIR'][0];
    const arch = path.basename(path.dirname(boardDir));

    const appDir = cache['APPLICATION_SOURCE_DIR'][0];
    const appKconfig = path.join(appDir, 'Kconfig');
    const zephyrKconfig = path.join(cache['ZEPHYR_BASE'][0], 'Kconfig');

    let root: string;
    if ('KCONFIG_ROOT' in cache) {
        root = cache['KCONFIG_ROOT'][0];
    } else if (existsSync(appKconfig)) {
        root = appKconfig;
    } else {
        root = zephyrKconfig;
    }

    const env: typeof process.env = {
        ...kEnv.get(),
        ZEPHYR_BASE: cache['ZEPHYR_BASE']?.[0],
        ZEPHYR_TOOLCHAIN_VARIANT: cache['ZEPHYR_TOOLCHAIN_VARIANT']?.[0],
        PYTHON_EXECUTABLE: cache['PYTHON_PREFER_EXECUTABLE']?.[0],
        srctree: cache['ZEPHYR_BASE']?.[0],
        KCONFIG_CONFIG: vscode.Uri.joinPath(uri, 'zephyr', '.config').fsPath,
        ARCH: arch,
        ARCH_DIR: path.join(cache['ZEPHYR_BASE'][0], 'arch'),
        BOARD: board,
        BOARD_DIR: boardDir,
        KCONFIG_BINARY_DIR: vscode.Uri.joinPath(uri, 'Kconfig').fsPath,
        TOOLCHAIN_KCONFIG_DIR: path.join(
            cache['TOOLCHAIN_ROOT'][0],
            'cmake',
            'toolchain',
            cache['ZEPHYR_TOOLCHAIN_VARIANT'][0]
        ),
        EDT_PICKLE: vscode.Uri.joinPath(uri, 'zephyr', 'edt.pickle').fsPath,
    };

    modules.forEach((module) => {
        const name = module.name.toUpperCase().replace(/[^\w]/g, '_');
        env[`ZEPHYR_${name}_MODULE_DIR`] = module.path;
        env[`ZEPHYR_${name}_KCONFIG`] = path.join(module.path, 'Kconfig');
    });

    Object.assign(env, {
        SHIELD_AS_LIST: cache['CACHED_SHIELD']?.join('\\;'),
        DTS_POST_CPP: vscode.Uri.joinPath(uri, 'zephyr', `${board}.dts.pre.tmp`).fsPath,
        DTS_ROOT_BINDINGS: cache['CACHED_DTS_ROOT_BINDINGS'].join('?'),
    });

    knownContexts.push(uri);

    return client.sendRequest<BuildResponse>('kconfig/addBuild', {
        uri: uri.toString(),
        root,
        env,
        conf: cache['CACHED_CONF_FILE']?.map((file) => path.resolve(appDir, file)) ?? [],
    } as AddBuildParams);
}

export async function removeBuild(uri: vscode.Uri): Promise<void> {
    client.sendNotification('kconfig/removeBuild', { uri: uri.toString() });
}

interface GenericNode {
    kind: 'symbol' | 'choice' | 'comment' | 'menu' | 'unknown';
    visible: boolean;
    loc?: vscode.Location;
    isMenu: boolean;
    hasChildren: boolean;
    depth: number;
    id: string;
    prompt?: string;
    help?: string;
}

interface SymbolNode extends GenericNode {
    kind: 'symbol';
    type: 'unknown' | 'bool' | 'tristate' | 'string' | 'int' | 'hex';
    val: string;
    name: string;
    options: string[];
    userValue: string;
}

interface CommentNode extends GenericNode {
    kind: 'comment';
}

interface ChoiceNode extends GenericNode {
    kind: 'choice';
    val: string | undefined;
}

interface MenuNode extends GenericNode {
    kind: 'menu';
}

interface UnknownNode extends GenericNode {
    kind: 'unknown';
}

export type Node = SymbolNode | CommentNode | ChoiceNode | MenuNode | UnknownNode;

export interface Menu {
    name: string;
    id: string;
    items: Node[];
}

export interface MenuOptions {
    allSymbols?: boolean;
}

export async function getMenu(
    uri?: vscode.Uri,
    node?: string,
    options: MenuOptions = {}
): Promise<Menu | undefined> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rsp = await client.sendRequest<any>('kconfig/getMenu', {
        ctx: uri?.toString(),
        id: node,
        options,
    });
    if (!rsp) {
        return;
    }

    return <Menu>{
        ...(rsp as Menu),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        items: rsp.items.map((item: any) => {
            return {
                ...(item as GenericNode),
                // Convert URI from string to URI object:
                loc: new vscode.Location(
                    vscode.Uri.parse(item.loc.uri),
                    new vscode.Range(
                        item.loc.range.start.line,
                        item.loc.range.start.character,
                        item.loc.range.end.line,
                        item.loc.range.end.character
                    )
                ),
            };
        }),
    };
}

export function stop(): void {
    client?.stop();
}
