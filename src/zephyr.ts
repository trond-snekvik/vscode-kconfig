/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as kEnv from './env';
import * as path from 'path';

export let zephyrBase: vscode.Uri | undefined;

export function getConfig(): { [name: string]: string } {
    const conf = {
        ARCH_DIR: 'arch',
        SOC_DIR: 'soc',
        TOOLCHAIN_KCONFIG_DIR: 'cmake/toolchain/*',
        ARCH: '*',
        BOARD: '*',
        BOARD_DIR: 'boards/*/*',
    };

    if (zephyrBase) {
        Object.assign(conf, {
            ZEPHYR_ROOT: zephyrBase.fsPath,
            ZEPHYR_BASE: zephyrBase.fsPath,
        });
    }

    return conf;
}

export function setZephyrBase(uri: vscode.Uri): void {
    zephyrBase = uri;
}

export async function activate(): Promise<void> {
    if (zephyrBase) {
        return;
    }

    const configured = kEnv.getConfig('zephyr.base');
    if (configured) {
        zephyrBase = kEnv.resolvePath(configured);
    } else if ('ZEPHYR_BASE' in kEnv.get()) {
        zephyrBase = kEnv.resolvePath(kEnv.get()['ZEPHYR_BASE']!);
    } else {
        const uris = await vscode.workspace.findFiles('**/Kconfig.zephyr');
        if (uris.length) {
            zephyrBase = vscode.Uri.file(path.basename(uris[0].fsPath));
        }
    }
}
