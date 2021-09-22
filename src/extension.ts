/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as fuzzy from 'fuzzysort';
import { Operator } from './evaluate';
import { Config, ConfigEntry, Repository, IfScope, Scope, Comment } from './kconfig';
import * as kEnv from './env';
import * as zephyr from './zephyr';
import * as fs from 'fs';
import * as path from 'path';
import Api from './api';
import { Context } from './context';

function isConfFile(doc?: vscode.TextDocument): boolean {
    // Files like .gitconfig is also a properties file. Check extensions in addition:
    return (
        doc?.languageId === 'properties' &&
        (doc.fileName.endsWith('.conf') || doc.fileName.endsWith('_defconfig'))
    );
}

export class KconfigLangHandler
    implements
        vscode.DefinitionProvider,
        vscode.HoverProvider,
        vscode.CompletionItemProvider,
        vscode.DocumentLinkProvider,
        vscode.ReferenceProvider,
        vscode.CodeActionProvider,
        vscode.DocumentSymbolProvider,
        vscode.WorkspaceSymbolProvider
{
    diags: vscode.DiagnosticCollection;
    fileDiags: { [uri: string]: vscode.Diagnostic[] };
    rootCompletions: vscode.CompletionItem[];
    propertyCompletions: vscode.CompletionItem[];
    repo: Repository;
    context?: Context;
    configured = false;
    rescanTimer?: NodeJS.Timeout;
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

        var range = new vscode.CompletionItem('range', vscode.CompletionItemKind.Keyword);
        range.insertText = new vscode.SnippetString('range ');
        range.insertText.appendPlaceholder('min');
        range.insertText.appendText(' ');
        range.insertText.appendPlaceholder('max');
        this.propertyCompletions.push(range);

        var help = new vscode.CompletionItem('help', vscode.CompletionItemKind.Keyword);
        help.insertText = new vscode.SnippetString('help\n  ');
        help.insertText.appendTabstop();
        help.commitCharacters = [' ', '\t', '\n'];
        this.propertyCompletions.push(help);

        this.propertyCompletions = this.propertyCompletions.map(sortItems);

        this.fileDiags = {};
        this.diags = vscode.languages.createDiagnosticCollection('kconfig');
        this.repo = new Repository(this.diags);
    }

    private setFileType(d: vscode.TextDocument) {
        /* It's not possible to pick up all kconfig filename types with the
         * static schema contribution point, as it would pick up stuff like
         * kconfig.py or kconfig.cmake, which shouldn't be treated as kconfig
         * files at all. Set the kconfig language through a fallback for files
         * that have no other file type set instead:
         */
        if (!d.languageId || d.languageId === 'plaintext') {
            if (path.basename(d.fileName).startsWith('Kconfig.')) {
                vscode.languages.setTextDocumentLanguage(d, 'kconfig');
            } else if (path.basename(d.fileName).endsWith('_defconfig')) {
                vscode.languages.setTextDocumentLanguage(d, 'properties');
            }
        }
    }

    async onOpenConfFile(uri: vscode.Uri) {
        const existing = this.context?.getFile(uri);
        if (existing) {
            existing.lint();
            return;
        }

        if (this.configured || !zephyr.zephyrRoot) {
            /* Don't abandon the current context if it has been set by the API */
            return;
        }

        const confFiles = new Array<vscode.Uri>();

        const boardFile = zephyr.boardConfFile();
        if (boardFile) {
            confFiles.push(boardFile);
        }

        confFiles.push(uri);

        this.context = new Context(confFiles, this.repo, this.diags);

        let kconfigRoot = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(uri.fsPath)), 'Kconfig');
        if (!fs.existsSync(kconfigRoot.fsPath)) {
            kconfigRoot = vscode.Uri.joinPath(vscode.Uri.file(zephyr.zephyrRoot), 'Kconfig');
        }

        if (this.repo.root?.uri.fsPath !== kconfigRoot.fsPath) {
            this.repo.setRoot(kconfigRoot);
            this.rescan();
        }

        await this.context.reparse();
        return this.context.getFile(uri)!.lint();
    }

    registerHandlers(context: vscode.ExtensionContext) {
        var disposable: vscode.Disposable;

        disposable = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.document.languageId === 'kconfig') {
                this.repo.onDidChange(e.document.uri, e);
            } else if (isConfFile(e.document) && e.contentChanges.length > 0) {
                this.context?.onChange(e);
            }
        });
        context.subscriptions.push(disposable);

        // Watch changes to files that aren't opened in vscode.
        // Handles git checkouts and similar out-of-editor events
        var watcher = vscode.workspace.createFileSystemWatcher('**/Kconfig*', true, false, true);
        watcher.onDidChange((uri) => {
            if (!vscode.workspace.textDocuments.some((d) => d.uri.fsPath === uri.fsPath)) {
                this.delayedRescan();
            }
        });
        context.subscriptions.push(watcher);

        disposable = vscode.window.onDidChangeActiveTextEditor((e) => {
            if (e && isConfFile(e.document)) {
                return this.onOpenConfFile(e.document.uri);
            }
        });
        context.subscriptions.push(disposable);

        disposable = vscode.workspace.onDidSaveTextDocument((d) => {
            this.context?.getFile(d.uri)?.lint();
        });
        context.subscriptions.push(disposable);

        disposable = vscode.workspace.onDidOpenTextDocument((d) => {
            this.setFileType(d);
        });
        context.subscriptions.push(disposable);

        disposable = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('kconfig')) {
                kEnv.update();
                if (e.affectsConfiguration('kconfig.root')) {
                    this.repo.setRoot(kEnv.getRootFile());
                }
                this.delayedRescan();
            }
        });
        context.subscriptions.push(disposable);

        const kconfig = [
            { language: 'kconfig', scheme: 'file' },
            { language: 'kconfig', scheme: 'kconfig' },
        ];
        const properties = [{ language: 'properties', scheme: 'file' }];
        const cFiles = [{ language: 'c', scheme: 'file' }];
        const all = [...kconfig, ...properties, ...cFiles];

        disposable = vscode.languages.registerDefinitionProvider(all, this);
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerHoverProvider(all, this);
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerCompletionItemProvider(
            [...kconfig, ...properties],
            this
        );
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerDocumentLinkProvider(kconfig, this);
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerCodeActionsProvider(properties, this);
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerDocumentSymbolProvider(
            [...kconfig, ...properties],
            this
        );
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerWorkspaceSymbolProvider(this);
        context.subscriptions.push(disposable);
        disposable = vscode.languages.registerReferenceProvider(kconfig, this);
        context.subscriptions.push(disposable);

        this.repo.activate(context);
    }

    delayedRescan(delay = 1000) {
        // debounce:
        if (this.rescanTimer) {
            clearTimeout(this.rescanTimer);
        }

        this.rescanTimer = setTimeout(() => {
            this.rescan();
        }, delay);
    }

    rescan() {
        this.diags.clear();
        this.repo.reset();

        return this.doScan();
    }

    scanConfFiles() {
        // Parse all open conf files, then lint the open editors:
        this.context?.reparse().then(() => {
            this.context!.confFiles.filter((file) =>
                vscode.window.visibleTextEditors.find(
                    (e) => file.uri.fsPath === e.document?.uri.fsPath
                )
            ).forEach((file) => file.scheduleLint());
        });
    }

    activate(context: vscode.ExtensionContext) {
        zephyr.onWestChange(context, () => this.delayedRescan());

        vscode.workspace.textDocuments.forEach((d) => {
            this.setFileType(d);
        });
        this.registerHandlers(context);
    }

    configure(board: zephyr.BoardTuple, confFiles: vscode.Uri[] = [], root?: vscode.Uri) {
        if (!zephyr.zephyrRoot) {
            return;
        }

        root ??= vscode.Uri.joinPath(vscode.Uri.file(zephyr.zephyrRoot), 'Kconfig');

        const changedContext =
            !this.configured ||
            board.board !== zephyr.board?.board ||
            confFiles.length !== this.context?.confFiles.length ||
            !confFiles.some((uri) =>
                this.context?.confFiles.find((p) => p.uri.fsPath === uri.fsPath)
            );
        const changedRepo =
            !this.configured ||
            this.repo.root?.uri.fsPath !== root.fsPath ||
            board.board !== zephyr.board?.board;

        if (changedRepo) {
            zephyr.setBoard(board);
            this.repo.setRoot(root);
            this.rescan();
        }

        if (changedContext) {
            this.context = new Context(
                [zephyr.boardConfFile()!, ...confFiles],
                this.repo,
                this.diags
            );
        }

        if (changedRepo || changedContext) {
            this.scanConfFiles();
        }

        this.configured = true;
    }

    deactivate() {
        this.diags.clear();
        this.repo.reset();
    }

    private doScan() {
        var hrTime = process.hrtime();

        this.repo.parse();

        hrTime = process.hrtime(hrTime);

        var time_ms = Math.round(hrTime[0] * 1000 + hrTime[1] / 1000000);
        vscode.window.setStatusBarMessage(
            `Kconfig: ${Object.keys(this.repo.configs).length} entries, ${time_ms} ms`,
            5000
        );
    }

    getSymbolName(document: vscode.TextDocument, position: vscode.Position) {
        var range = document.getWordRangeAtPosition(position);
        var word = document.getText(range);
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

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Location | vscode.Location[] | vscode.LocationLink[]> {
        if (document.languageId === 'c' && !kEnv.getConfig('cfiles')) {
            return null;
        }

        var config = this.repo.configs[this.getSymbolName(document, position)];
        if (config) {
            return (
                config.entries.length === 1
                    ? config.entries
                    : config.entries.filter(
                          (e) =>
                              e.file.uri.fsPath !== document.uri.fsPath ||
                              position.line < e.lines.start ||
                              position.line > e.lines.end
                      )
            ).map((e) => e.loc);
        }
        return null;
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        if (document.languageId === 'c' && !kEnv.getConfig('cfiles')) {
            return null;
        }

        var entry = this.repo.configs[this.getSymbolName(document, position)];
        if (!entry) {
            return null;
        }
        var text = new Array<vscode.MarkdownString>();
        text.push(new vscode.MarkdownString(`${entry.text || entry.name}`));
        if (entry.type) {
            var typeLine = new vscode.MarkdownString(`\`${entry.type}\``);
            if (entry.ranges.length === 1) {
                typeLine.appendMarkdown(
                    `\t\tRange: \`${entry.ranges[0].min}\`-\`${entry.ranges[0].max}\``
                );
            }
            text.push(typeLine);
        }
        if (entry.help) {
            text.push(new vscode.MarkdownString(entry.help));
        }
        return new vscode.Hover(text, document.getWordRangeAtPosition(position));
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        var line = document.lineAt(position.line);
        var isProperties = document.languageId === 'properties';
        var items: vscode.CompletionItem[];

        if (
            !isProperties &&
            !line.text.match(
                /(if|depends\s+on|select|default|def_bool|def_tristate|def_int|def_hex|range)/
            )
        ) {
            if (line.firstNonWhitespaceCharacterIndex > 0) {
                return this.propertyCompletions;
            }

            return this.rootCompletions;
        }

        if (isProperties) {
            var lineRange = new vscode.Range(position.line, 0, position.line, 999999);
            var lineText = document.getText(lineRange);
            var replaceText = lineText.replace(/\s*#.*$/, '');
        }

        const kinds = {
            config: vscode.CompletionItemKind.Variable,
            menuconfig: vscode.CompletionItemKind.Class,
            choice: vscode.CompletionItemKind.Enum,
        };

        items = this.repo.configList.map((e) => {
            var item = new vscode.CompletionItem(
                isProperties ? `CONFIG_${e.name}` : e.name,
                e.kind ? kinds[e.kind] : vscode.CompletionItemKind.Text
            );
            item.sortText = e.name;
            item.detail = e.text;
            if (isProperties) {
                if (replaceText.length > 0) {
                    item.range = new vscode.Range(
                        position.line,
                        0,
                        position.line,
                        replaceText.length
                    );
                }

                item.insertText = new vscode.SnippetString(`${item.label}=`);
                switch (e.type) {
                    case 'bool':
                        if (e.defaults.length > 0 && e.defaults[0].value === 'y') {
                            item.insertText.appendPlaceholder('n');
                        } else {
                            item.insertText.appendPlaceholder('y');
                        }
                        break;
                    case 'tristate':
                        item.insertText.appendPlaceholder('y');
                        break;
                    case 'int':
                    case 'string':
                        if (e.defaults.length > 0) {
                            item.insertText.appendPlaceholder(e.defaults[0].value);
                        } else {
                            item.insertText.appendTabstop();
                        }
                        break;
                    case 'hex':
                        if (e.defaults.length > 0) {
                            item.insertText.appendPlaceholder(e.defaults[0].value);
                        } else {
                            item.insertText.appendText('0x');
                            item.insertText.appendTabstop();
                        }
                        break;
                    default:
                        break;
                }
            }

            return item;
        });

        if (!isProperties) {
            items.push(new vscode.CompletionItem('if', vscode.CompletionItemKind.Keyword));
        }

        return items;
    }

    resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CompletionItem> {
        if (!item.sortText) {
            return item;
        }
        var e = this.repo.configs[item.sortText];
        if (!e) {
            return item;
        }
        var doc = new vscode.MarkdownString(`\`${e.type}\``);
        if (e.ranges.length === 1) {
            doc.appendMarkdown(`\t\tRange: \`${e.ranges[0].min}\`-\`${e.ranges[0].max}\``);
        }
        if (e.help) {
            doc.appendText('\n\n');
            doc.appendMarkdown(e.help);
        }
        if (e.defaults.length > 0) {
            if (e.defaults.length > 1) {
                doc.appendMarkdown('\n\n### Defaults:\n');
            } else {
                doc.appendMarkdown('\n\n**Default:** ');
            }
            e.defaults.forEach((dflt) => {
                doc.appendMarkdown(`\`${dflt.value}\``);
                if (dflt.condition) {
                    doc.appendMarkdown(` if \`${dflt.condition}\``);
                }
                doc.appendMarkdown('\n\n');
            });
        }
        item.documentation = doc;
        return item;
    }

    provideDocumentLinks(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.DocumentLink[] {
        var file = this.repo.files.find((f) => f.uri.fsPath === document.uri.fsPath);
        return file?.links ?? [];
    }

    provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Location[]> {
        var entry = this.repo.configs[this.getSymbolName(document, position)];
        if (!entry || !entry.type || !['bool', 'tristate'].includes(entry.type)) {
            return null;
        }
        return this.repo.configList
            .filter(
                (config) =>
                    config.allSelects(entry.name).length > 0 || config.hasDependency(entry!.name)
            )
            .map((config) => config.entries[0].loc); // TODO: return the entries instead?
    }

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.CodeAction[]> {
        return this.context
            ?.getFile(document.uri)
            ?.actions.filter(
                (a) =>
                    (!context.only || context.only === a.kind) &&
                    a.diagnostics?.[0].range.intersection(range)
            );
    }

    provideDocumentSymbols(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
        if (document.languageId === 'properties') {
            return this.context
                ?.getFile(document.uri)
                ?.overrides.map(
                    (o) =>
                        new vscode.DocumentSymbol(
                            o.config.name,
                            o.config.text ?? '',
                            o.config.symbolKind(),
                            new vscode.Range(o.line!, 0, o.line!, 99999),
                            new vscode.Range(o.line!, 0, o.line!, 99999)
                        )
                );
        }
        var file = this.repo.files.find((f) => f.uri.fsPath === document.uri.fsPath);
        if (!file) {
            return [];
        }

        var addScope = (scope: Scope): vscode.DocumentSymbol => {
            var name: string = scope.name;
            if (scope instanceof IfScope && scope.expr?.operator === Operator.VAR) {
                var config = this.repo.configs[scope.expr.var!.value];
                name = config?.text ?? config?.name ?? scope.name;
            }

            var symbol = new vscode.DocumentSymbol(
                name,
                '',
                scope.symbolKind,
                scope.range,
                new vscode.Range(scope.lines.start, 0, scope.lines.start, 9999)
            );

            symbol.children = (
                scope.children.filter((c) => !(c instanceof Comment) && c.file === file) as (
                    | Scope
                    | ConfigEntry
                )[]
            )
                .map((c) =>
                    c instanceof Scope
                        ? addScope(c)
                        : new vscode.DocumentSymbol(
                              c.config.text ?? c.config.name,
                              '',
                              c.config.symbolKind(),
                              new vscode.Range(c.lines.start, 0, c.lines.end, 9999),
                              new vscode.Range(c.lines.start, 0, c.lines.start, 9999)
                          )
                )
                .reduce((prev, curr) => {
                    if (prev.length > 0 && curr.name === prev[prev.length - 1].name) {
                        prev[prev.length - 1].children.push(...curr.children);
                        prev[prev.length - 1].range = prev[prev.length - 1].range.union(curr.range);
                        return prev;
                    }
                    return [...prev, curr];
                }, new Array<vscode.DocumentSymbol>());

            return symbol;
        };

        return addScope(file.scope).children;
    }

    provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.SymbolInformation[]> {
        var entries: Config[];
        query = query?.replace(/^(CONFIG_)?/, '');

        if (query) {
            entries = fuzzy
                .go(query, this.repo.configList, { key: 'name' })
                .map((result) => result.obj);
        } else {
            entries = this.repo.configList;
        }

        return entries.map(
            (e) =>
                new vscode.SymbolInformation(
                    `CONFIG_${e.name}`,
                    vscode.SymbolKind.Property,
                    e.text ?? '',
                    e.entries[0].loc
                )
        );
    }
}

export var langHandler: KconfigLangHandler | undefined;
var active = false;

export function startExtension(): boolean {
    if (active) {
        return true;
    }

    kEnv.update();

    if (!kEnv.isActive()) {
        return false;
    }

    zephyr.activate(kEnv.extensionContext);

    langHandler = new KconfigLangHandler();
    langHandler.activate(kEnv.extensionContext);
    active = true;
    return true;
}

export function activate(context: vscode.ExtensionContext) {
    const api = new Api();

    kEnv.setExtensionContext(context);
    if (kEnv.getConfig('disable')) {
        return;
    }

    // If the nrf-connect extension exists, we'll wait for that to start the extension for us:
    if (!vscode.extensions.getExtension('nordic-semiconductor.nrf-connect')) {
        zephyr.resolveEnvironment(kEnv.extensionContext).then((foundZephyr) => {
            if (!foundZephyr) {
                return;
            }

            startExtension();
            zephyr.createBoardStatusbarItem();

            if (isConfFile(vscode.window.activeTextEditor?.document)) {
                langHandler!.onOpenConfFile(vscode.window.activeTextEditor!.document.uri);
            }
        });
    }

    return api;
}

export function deactivate() {
    langHandler?.deactivate();
}
