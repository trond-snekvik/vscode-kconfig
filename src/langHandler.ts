/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as kEnv from './env';
import * as zephyr from './zephyr';
import * as path from 'path';
import { ParsedFile } from './parse';
import * as glob from 'glob';

export class KconfigLangHandler
    implements
        vscode.CompletionItemProvider,
        vscode.DocumentLinkProvider,
        vscode.DocumentSymbolProvider
{
    diags: vscode.DiagnosticCollection;
    fileDiags: { [uri: string]: vscode.Diagnostic[] };
    rootCompletions: vscode.CompletionItem[];
    propertyCompletions: vscode.CompletionItem[];
    files: ParsedFile[];
    configured = false;
    rescanTimer?: NodeJS.Timeout;
    nameResolved = new Set<string>();
    constructor() {
        const sortItems = (item: vscode.CompletionItem, i: number) => {
            const pad = '0000';
            item.sortText = `root-${pad.slice(i.toString().length)}${i.toString()}`;
            return item;
        };
        this.rootCompletions = [
            new vscode.CompletionItem('config', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('menuconfig', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('choice', vscode.CompletionItemKind.Class),
            new vscode.CompletionItem('endchoice', vscode.CompletionItemKind.Keyword),
            new vscode.CompletionItem('if', vscode.CompletionItemKind.Module),
            new vscode.CompletionItem('endif', vscode.CompletionItemKind.Keyword),
            new vscode.CompletionItem('menu', vscode.CompletionItemKind.Module),
            new vscode.CompletionItem('endmenu', vscode.CompletionItemKind.Keyword),
            new vscode.CompletionItem('source', vscode.CompletionItemKind.File),
            new vscode.CompletionItem('rsource', vscode.CompletionItemKind.File),
            new vscode.CompletionItem('osource', vscode.CompletionItemKind.File),
        ].map(sortItems);

        this.propertyCompletions = [
            new vscode.CompletionItem('bool', vscode.CompletionItemKind.TypeParameter),
            new vscode.CompletionItem('int', vscode.CompletionItemKind.TypeParameter),
            new vscode.CompletionItem('hex', vscode.CompletionItemKind.TypeParameter),
            new vscode.CompletionItem('tristate', vscode.CompletionItemKind.TypeParameter),
            new vscode.CompletionItem('string', vscode.CompletionItemKind.TypeParameter),
            new vscode.CompletionItem('def_bool', vscode.CompletionItemKind.Variable),
            new vscode.CompletionItem('def_int', vscode.CompletionItemKind.Variable),
            new vscode.CompletionItem('def_hex', vscode.CompletionItemKind.Variable),
            new vscode.CompletionItem('def_tristate', vscode.CompletionItemKind.Variable),
            new vscode.CompletionItem('def_string', vscode.CompletionItemKind.Variable),
            new vscode.CompletionItem('optional', vscode.CompletionItemKind.Property),
            new vscode.CompletionItem('depends on', vscode.CompletionItemKind.Reference),
            new vscode.CompletionItem('visible if', vscode.CompletionItemKind.Property),
            new vscode.CompletionItem('default', vscode.CompletionItemKind.Property),
        ];

        const range = new vscode.CompletionItem('range', vscode.CompletionItemKind.Keyword);
        range.insertText = new vscode.SnippetString('range ');
        range.insertText.appendPlaceholder('min');
        range.insertText.appendText(' ');
        range.insertText.appendPlaceholder('max');
        this.propertyCompletions.push(range);

        const help = new vscode.CompletionItem('help', vscode.CompletionItemKind.Keyword);
        help.insertText = new vscode.SnippetString('help\n  ');
        help.insertText.appendTabstop();
        help.commitCharacters = [' ', '\t', '\n'];
        this.propertyCompletions.push(help);

        this.propertyCompletions = this.propertyCompletions.map(sortItems);

        this.fileDiags = {};
        this.diags = vscode.languages.createDiagnosticCollection('kconfig');
        this.files = [];
    }

    private setFileType(d: vscode.TextDocument) {
        /* It's not possible to pick up all kconfig filename types with the
         * static schema contribution point, as it would pick up stuff like
         * kconfig.py or kconfig.cmake, which shouldn't be treated as kconfig
         * files at all. Set the kconfig language through a fallback for files
         * that have no other file type set instead:
         */
        if (
            d.uri.scheme === 'file' &&
            (!d.languageId || d.languageId === 'plaintext') &&
            !this.nameResolved.has(d.uri.toString())
        ) {
            if (path.basename(d.fileName).startsWith('Kconfig.')) {
                vscode.languages.setTextDocumentLanguage(d, 'kconfig');
                this.nameResolved.add(d.uri.toString());
            } else if (path.basename(d.fileName).endsWith('_defconfig')) {
                vscode.languages.setTextDocumentLanguage(d, 'properties');
                this.nameResolved.add(d.uri.toString());
            }
        }
    }

    private getFile(doc: vscode.TextDocument): ParsedFile {
        let file = this.files.find((d) => d.uri.fsPath === doc.uri.fsPath);
        if (!file) {
            file = new ParsedFile(doc);
            this.files.push(file);
        }

        return file;
    }

    private parseDoc(d: ParsedFile) {
        if (d) {
            d.parse();
            this.diags.set(d.uri, d.diags);
            if (d.diags.length > 0) {
                console.log(
                    `${d.uri.fsPath}:\n\t${d.diags
                        .map((d) => d.range.start.line + 1 + ': ' + d.message)
                        .join('\n\t')}`
                );
            }
        }
    }

    registerHandlers(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((d) => {
                this.setFileType(d);
            }),
            vscode.window.onDidChangeActiveTextEditor((e) => {
                if (e?.document.languageId === 'kconfig') {
                    this.parseDoc(this.getFile(e.document));
                }
            }),

            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.contentChanges.length > 0 && e.document.languageId === 'kconfig') {
                    this.parseDoc(this.getFile(e.document));
                }
            })
        );

        const kconfig = [{ language: 'kconfig', scheme: 'file' }];

        context.subscriptions.push(
            vscode.languages.registerCompletionItemProvider(kconfig, this),
            vscode.languages.registerDocumentLinkProvider(kconfig, this),
            vscode.languages.registerDocumentSymbolProvider(kconfig, this)
        );
    }

    activate(context: vscode.ExtensionContext): void {
        vscode.workspace.textDocuments.forEach((d) => {
            this.setFileType(d);
        });

        this.registerHandlers(context);
        kEnv.update();

        const doc = vscode.window.activeTextEditor?.document;
        if (doc?.languageId === 'kconfig') {
            this.parseDoc(this.getFile(doc));
        }
    }

    deactivate(): void {
        this.diags.clear();
    }

    getSymbolName(document: vscode.TextDocument, position: vscode.Position): string {
        const range = document.getWordRangeAtPosition(position);
        const word = document.getText(range);
        switch (document.languageId) {
            case 'kconfig':
                return word;
            default:
                if (word.startsWith('CONFIG_')) {
                    return word.slice('CONFIG_'.length);
                }
        }
        return '';
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | undefined {
        const line = document.lineAt(position.line);

        if (
            !line.text.match(
                /(if|depends\s+on|select|default|def_bool|def_tristate|def_int|def_hex|range)/
            )
        ) {
            if (line.firstNonWhitespaceCharacterIndex > 0) {
                return this.propertyCompletions;
            }

            return this.rootCompletions;
        }
    }

    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        const doc = this.getFile(document);
        if (!doc.parsed) {
            doc.parse();
        }

        const fileDir = path.dirname(doc.uri.fsPath);
        return doc.inclusions.reduce((all, i) => {
            const base = i.relative
                ? fileDir
                : zephyr.zephyrBase?.fsPath ??
                  vscode.workspace.workspaceFolders?.[0].uri.fsPath ??
                  '';
            const paths = glob.sync(kEnv.resolvePath(i.path, base).path);
            paths.forEach((p) => {
                const link = new vscode.DocumentLink(i.range, vscode.Uri.file(p));
                link.tooltip = path.relative(fileDir, p);
                all.push(link);
            });

            return all;
        }, new Array<vscode.DocumentLink>());
    }

    provideDocumentSymbols(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
        const doc = this.getFile(document);
        if (!doc.parsed) {
            doc.parse();
        }

        return doc.root.asDocSymbol().children;
    }
}
