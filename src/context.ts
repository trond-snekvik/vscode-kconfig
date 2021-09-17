/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import { ConfigOverride, Repository } from './kconfig';
import { PropFile } from './propfile';

/**
 * prj.conf context, corresponding to a single build.
 */
export class Context {
    confFiles: PropFile[];
    constructor(confFiles: vscode.Uri[], public repo: Repository, diags: vscode.DiagnosticCollection) {
        this.confFiles = confFiles.map(uri => new PropFile(uri, this, diags));
    }

    get overrides(): ConfigOverride[] {
        return this.confFiles.reduce((overrides, c) => overrides.concat(c.overrides), new Array<ConfigOverride>());
    }

    getFile(uri: vscode.Uri): PropFile | undefined {
        return this.confFiles.find(c => c.uri.fsPath === uri.fsPath);
    }

    onChangedEditor(e?: vscode.TextEditor) {
        if (e?.document) {
            this.getFile(e.document.uri)?.lint();
        }
    }

    async onChange(e: vscode.TextDocumentChangeEvent) {
        return this.getFile(e.document.uri)?.onChange(e);
    }

    reparse() {
        return Promise.all(this.confFiles.map(c => c.parse()));
    }
}
