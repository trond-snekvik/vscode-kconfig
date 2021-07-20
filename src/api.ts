/*
 * Copyright (c) 2020 Trond Snekvik
 *
 * SPDX-License-Identifier: MIT
 */
import * as vscode from 'vscode';
import * as zephyr from './zephyr';
import * as kEnv from './env';

interface Context {
    config: Config;
}

interface Config {
    appUri: vscode.Uri;
    zephyrBoard?: string;
    zephyrBase?: vscode.Uri;
    west?: string;
}

class Api {
    public version = 1;

    async addContext(config: Config): Promise<Context> {
        return {
            config,
        }
    }

    async setContext(context: Context): Promise<void> {
        const conf = context.config;
        if (conf.zephyrBase){
            await zephyr.setZephyrBase(conf.zephyrBase);
        }
        if (conf.west){
            await zephyr.setWest(conf.west);
        }
        const root = kEnv.findRootFromApp(context.config.appUri);
        kEnv.setConfig('root', root);
        if (conf.zephyrBoard){
            zephyr.updateBoardFromName(conf.zephyrBoard);
        }
    }
}

export default Api;
