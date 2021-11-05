/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as zephyr from './zephyr';

let config = vscode.workspace.getConfiguration('kconfig');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getConfig<T = any>(name: string): T {
    return config.get(name) as T;
}

let variables: Record<string, string> = {};
let env: Record<string, string | undefined> = { ...process.env };

export function set(new_env?: Record<string, string | undefined>): void {
    env = { ...(new_env ?? process.env) };
}

export function get(): Record<string, string | undefined> {
    return env;
}

function replace(text: string, map: Record<string, string | undefined>): string {
    return text.replace(/\$(?:\((.*?)\)|{(.*?)}|(\w+))/g, (original: string, ...vars: string[]) => {
        const v = vars.find((v) => v !== undefined);
        if (!v) {
            return original;
        }

        if (v in map) {
            return map[v] ?? '';
        }

        if (v.startsWith('env:')) {
            return env[v.slice('env:'.length)] ?? '';
        }

        if (v in env) {
            return env[v] ?? '';
        }

        if (v.startsWith('config:')) {
            const config = vscode.workspace.getConfiguration();
            return replace(config.get<string>(v.slice('config:'.length)) ?? '', map);
        }

        return '';
    });
}

export function update(): void {
    config = vscode.workspace.getConfiguration('kconfig');
    variables = zephyr.getConfig();
    Object.entries(getConfig<Record<string, string>>('env')).forEach(
        ([key, value]) => (variables[key] = pathReplace(value))
    );
}

function pathReplace(fileName: string): string {
    const map: Record<string, string | undefined> = {
        workspaceFolder: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
    };

    vscode.workspace.workspaceFolders?.forEach((folder) => {
        map[`workspaceFolder:${folder.name}`] = folder.uri.fsPath;
    });

    return replace(fileName, map);
}

export function getWorkspaceRoot(file: string): string {
    if (path.isAbsolute(file)) {
        return (
            vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ??
            path.dirname(file)
        );
    }

    return (
        vscode.workspace.workspaceFolders?.find((w) =>
            fs.existsSync(path.resolve(w.uri.fsPath, file))
        )?.uri.fsPath ??
        vscode.workspace.workspaceFolders?.[0].uri.fsPath ??
        path.dirname(file)
    );
}

export function resolvePath(fileName: string, base?: string): vscode.Uri {
    if (!fileName) {
        return vscode.Uri.file('');
    }

    fileName = pathReplace(fileName);
    if (fileName.match(/^\w{2,}:\//)) {
        // raw URI
        return vscode.Uri.parse(fileName);
    }

    if (!base) {
        base = getWorkspaceRoot(fileName);
    }

    // Relying on the uri accepting files without schemes:
    return vscode.Uri.file(path.resolve(base, fileName));
}
