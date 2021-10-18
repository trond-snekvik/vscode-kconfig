/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as zephyr from './zephyr';
import * as kEnv from './env';
import { startExtension } from './extension';
import * as lsp from './lsp';

class Api {
    public version = 3;

    async activate(zephyrBase: vscode.Uri, _: string, env?: typeof process.env): Promise<boolean> {
        zephyr.setZephyrBase(zephyrBase);
        kEnv.set(env);
        startExtension();
        return true;
    }

    setConfig(config?: vscode.Uri): void {
        lsp.setMainBuild(config);
    }
}

export default Api;
