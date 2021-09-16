/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as zephyr from './zephyr';
import { langHandler, startExtension } from './extension';

interface Config {
    appUri: vscode.Uri;
    board: {
        /** Name of board, e.g. nrf52dk_nrf52832 */
        id: string;
        /** Uri to board directory, if available */
        path?: vscode.Uri;
    };
    /** Configuration files used, in addition to the board's conf file */
    confFiles?: vscode.Uri[],
    /** Root Kconfig file, or leave undefined to fall back to $ZEPHYR_ROOT/Kconfig. */
    kconfigRoot?: vscode.Uri;
}

class Api {
    public version = 2;

    async activate(zephyrBase: vscode.Uri, west: string, env?: typeof process.env): Promise<boolean> {
        await zephyr.setWest(west, env);
        await zephyr.setZephyrBase(zephyrBase);
        return startExtension();
    }

    async setConfig(config: Config): Promise<void> {
        const board = await zephyr.boardFromName(config.board.id, config.board.path);
        langHandler?.configure(board, config.confFiles, config.kconfigRoot);
    }
}

export default Api;
