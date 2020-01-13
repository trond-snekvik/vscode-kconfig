// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fuzzy from "fuzzysort";
import { resolveExpression, tokenizeExpression, TokenKind } from './evaluate';
import { Config, ConfigOverride, ConfigEntry, Repository } from "./kconfig";
import * as kEnv from './env';

type LocationFile = { uri: vscode.Uri, links: vscode.DocumentLink[], entries: { [name: string]: Config } };
type ConfFile = { actions: vscode.CodeAction[], diags: vscode.Diagnostic[], conf: ConfigOverride[] };
class KconfigLangHandler implements vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.DocumentLinkProvider, vscode.ReferenceProvider, vscode.CodeActionProvider, vscode.DocumentSymbolProvider, vscode.WorkspaceSymbolProvider {

	staticConf: ConfigOverride[];
	diags: vscode.DiagnosticCollection;
	actions: { [uri: string]: vscode.CodeAction[] };
	fileDiags: {[uri: string]: vscode.Diagnostic[]};
	confContexts: { [uri: string]: ConfFile };
	operatorCompletions: vscode.CompletionItem[];
	repo: Repository;

	constructor() {
		this.operatorCompletions = [
			new vscode.CompletionItem('if', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('optional', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('endif', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('endchoice', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('endmenu', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('bool', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('int', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('hex', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('tristate', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('string', vscode.CompletionItemKind.TypeParameter),
			new vscode.CompletionItem('config', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('menu', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('menuconfig', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('choice', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('depends on', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('visible if', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('default', vscode.CompletionItemKind.Keyword),
		];
		this.operatorCompletions.forEach(c => c.commitCharacters = [' ']);

		var range = new vscode.CompletionItem('range', vscode.CompletionItemKind.Keyword);
		range.insertText = new vscode.SnippetString('range ');
		range.insertText.appendPlaceholder('min');
		range.insertText.appendText(' ');
		range.insertText.appendPlaceholder('max');
		this.operatorCompletions.push(range);

		var help = new vscode.CompletionItem('help', vscode.CompletionItemKind.Keyword);
		help.insertText = new vscode.SnippetString('help\n  ');
		help.insertText.appendTabstop();
		this.operatorCompletions.push(help);

		this.actions = {};
		this.fileDiags = {};
		this.confContexts = {};
		this.staticConf = [];
		this.diags = vscode.languages.createDiagnosticCollection('kconfig');
		this.repo = new Repository();

		vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.languageId === 'kconfig') {
				this.repo.onDidChange(e);
			} else if (e.document.languageId === 'properties') {
				this.servePropertiesDiag(e.document);
			}
		});

		vscode.workspace.onDidSaveTextDocument(d => {
			if (d.languageId === 'properties') {
				this.confFileAnalyze(d);
			}
		});

		vscode.workspace.onDidOpenTextDocument(d => {
			if (d.languageId === 'kconfig') {
				// TODO: This must be slightly more sophisticated in the onChange listener to work properly:
				// var diags: vscode.Diagnostic[] = [];
				// this.repo.files.filter(f => f.uri.fsPath === d.uri.fsPath).forEach(f => {
				// 	diags.push(...f.diags);
				// });
				// this.diags.set(d.uri, diags);
			} else if (d.languageId === 'properties') {
				this.servePropertiesDiag(d);
				this.confFileAnalyze(d);
			}
		});

	}

	rescan() {
		this.actions = {};
		this.staticConf = [];
		this.staticConf = [];
		this.diags.clear();
		this.actions = {};

		return this.doScan();
	}

	doScan(): Promise<string> {
		var hrTime = process.hrtime();

		var root = kEnv.resolvePath(kEnv.getConfig('root'));
		if (root) {
			this.repo.setRoot(vscode.Uri.file(root));
			this.repo.parse();
		}

		hrTime = process.hrtime(hrTime);

		vscode.window.visibleTextEditors
			.filter(e => e.document.languageId === 'properties')
			.forEach(e => {
				this.servePropertiesDiag(e.document);
				this.confFileAnalyze(e.document);
			});

		var time_ms = (hrTime[0] * 1000 + hrTime[1] / 1000000);
		return Promise.resolve(`${Object.keys(this.repo.configs).length} entries, ${(time_ms).toFixed(2)} ms`);
	}

	loadConfOptions(): ConfigOverride[] {
		var conf: { [config: string]: string | boolean | number } = kEnv.getConfig('conf');
		var entries: ConfigOverride[] = [];
		Object.keys(conf).forEach(c => {
			var e = this.repo.configs[c];
			if (e) {
				var value;
				if (value === true) {
					value = 'y';
				} else if (value === false) {
					value = 'n';
				} else {
					value = conf[c].toString();
				}
				entries.push({ config: e, value: value });
			}
		});

		var conf_files: string[] = kEnv.getConfig('conf_files');
		if (conf_files) {
			conf_files.forEach(f => {
				try {
					var text = fs.readFileSync(kEnv.pathReplace(f), 'utf-8');
				} catch (e) {
					if (e instanceof Error) {
						if ('code' in e && e['code'] === 'ENOENT') {
							vscode.window.showWarningMessage(`File "${f}" not found`);
						} else {
							vscode.window.showWarningMessage(`Error while reading conf file ${f}: ${e.message}`);
						}
					}
					return;
				}
				var lines = text.split(/\r?\n/g);
				lines.forEach(line => {
					var e = this.parseLine(line, []);
					if (e) {
						entries.push(e);
					}
				});
			});
		}

		return entries;
	}

	parseLine(line: string, diags: vscode.Diagnostic[], lineNumber?: number): ConfigOverride | undefined {
		var thisLine = lineNumber !== undefined ? new vscode.Position(lineNumber, 0) : undefined;
		var match = line.match(/^\s*CONFIG_([^\s=]+)\s*(?:=\s*(".*?[^\\]"|""|[ynm]\b|0x[a-fA-F\d]+\b|\d+\b))?/);
		if (match) {
			var override;
			if (match[2]) {
				var entry = this.repo.configs[match[1]];
				if (entry) {
					if (entry.isValidOverride(match[2])) {
						override = { config: entry, value: match[2], line: lineNumber };
					} else if (thisLine !== undefined) {
						diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine),
							`Invalid value. Entry ${match[1]} is ${entry.type}.`,
							vscode.DiagnosticSeverity.Error));
					}
				} else if (thisLine !== undefined) {
					diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), 'Unknown entry ' + match[1], vscode.DiagnosticSeverity.Error));
				}

				var trailing = line.slice(match[0].length).match(/^\s*([^#\s]+[^#]*)/);
				if (trailing && thisLine !== undefined) {
					var start = match[0].length + trailing[0].indexOf(trailing[1]);
					diags.push(new vscode.Diagnostic(new vscode.Range(thisLine.line, start, thisLine.line, start + trailing[1].trimRight().length),
						'Unexpected trailing characters',
						vscode.DiagnosticSeverity.Error));
				}
				return override;
			} else if (thisLine !== undefined) {
				diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), 'Missing value for config ' + match[1], vscode.DiagnosticSeverity.Error));
			}
		} else if (!line.match(/^\s*(#|$)/) && thisLine) {
			diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), 'Syntax error: All lines must either be comments or config entries with values.', vscode.DiagnosticSeverity.Error));
		}
	}

	async confFileAnalyze(doc: vscode.TextDocument) {
		var ctx = this.confContexts[doc.uri.fsPath];
		if (!ctx) {
			return;
		}

		var all = Object.values(this.repo.configs);

		var addRedundancyAction = (c: ConfigOverride, diag: vscode.Diagnostic) => {
			var action = new vscode.CodeAction(`Remove redundant entry CONFIG_${c.config.name}`, vscode.CodeActionKind.Refactor);
			action.edit = new vscode.WorkspaceEdit();
			action.edit.delete(doc.uri, new vscode.Range(c.line!, 0, c.line! + 1, 0));
			action.diagnostics = [diag];
			action.isPreferred = true;
			ctx.actions.push(action);
		};

		ctx.conf.forEach((c, i) => {
			if (c.line === undefined) {
				return;
			}

			var override = c.config.resolveValueString(c.value);
			var line = new vscode.Range(c.line, 0, c.line, 99999999);
			var diag: vscode.Diagnostic;
			var action: vscode.CodeAction;

			if (!c.config.text) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} has no effect (has no prompt)`,
					vscode.DiagnosticSeverity.Warning);
				ctx.diags.push(diag);
				addRedundancyAction(c, diag);

				// Find all selectors:
				var selectors = all.filter(e => e.selects.find(s => s.name === c.config.name && (!s.condition || s.condition.solve(all, ctx.conf))));
				ctx.actions.push(...selectors.map(s => {
					var action = new vscode.CodeAction(`Replace with CONFIG_${s.name}`, vscode.CodeActionKind.QuickFix);
					action.edit = new vscode.WorkspaceEdit();
					action.edit.replace(doc.uri, line, `CONFIG_${s.name}=y`);
					action.diagnostics = [diag];
					return action;
				}));
			}

			if (c.config.type && ['int', 'hex'].includes(c.config.type)) {
				var range = c.config.getRange(all, ctx.conf);
				if ((range.min !== undefined && override < range.min) || (range.max !== undefined && override > range.max)) {
					ctx.diags.push(new vscode.Diagnostic(line,
						`Entry ${c.value} outside range \`${range.min}\`-\`${range.max}\``,
						vscode.DiagnosticSeverity.Error));
				}
			}

			// tslint:disable-next-line: triple-equals
			if (override == c.config.defaultValue(all, ctx.conf)) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is redundant (same as default)`,
					vscode.DiagnosticSeverity.Hint);
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				ctx.diags.push(diag);

				addRedundancyAction(c, diag);
			}

			var missingDependency = c.config.missingDependency(all, ctx.conf);
			if (missingDependency) {
				if (c.value === 'n') {
					diag = new vscode.Diagnostic(line,
						`Entry is already disabled by dependency: ${missingDependency}`,
						vscode.DiagnosticSeverity.Warning);
					diag.tags = [vscode.DiagnosticTag.Unnecessary];

					addRedundancyAction(c, diag);
				} else {
					diag = new vscode.Diagnostic(line,
						`Entry ${c.config.name} dependency ${missingDependency} missing.`,
						vscode.DiagnosticSeverity.Warning);
				}

				var tokens = tokenizeExpression(missingDependency);
				var variables = tokens
					.filter(t => t.kind === TokenKind.VAR)
					.map(t => this.repo.configs[t.value])
					.filter(e => (e && e.text && e.type && ['bool', 'tristate'].includes(e.type)));

				/* Unless the expression is too complex, try all combinations to find one that works: */
				if (variables.length > 0 && variables.length < 4) {
					for (var code = 0; code < (1 << variables.length); code++) {
						var overrides: ConfigOverride[] = variables.map((v, i) => { return { config: v!, value: (code & (1 << i)) ? 'y' : 'n' }; });
						if (resolveExpression(missingDependency, all, overrides.concat(ctx.conf))) {
							var newEntries: ConfigOverride[] = [];
							var existingEntries: ConfigOverride[] = [];
							overrides.forEach(o => {
								var dup = ctx.conf.find(c => o.config.name === c.config.name);
								if (dup && dup.line !== undefined) {
									if (dup.value !== o.value) {
										existingEntries.push({config: dup.config, value: o.value, line: dup.line});
									}
								} else {
									newEntries.push(o);
								}
							});

							var totLen = newEntries.length + existingEntries.length;
							if (totLen === 0) {
								continue;
							}

							action = new vscode.CodeAction(`Add ${totLen} missing ${totLen > 1 ? 'dependencies' : 'dependency'}`, vscode.CodeActionKind.Refactor);
							action.edit = new vscode.WorkspaceEdit();
							if (newEntries.length) {
								action.edit.insert(doc.uri,
									new vscode.Position(c.line, 0),
									newEntries.map(c => `CONFIG_${c.config.name}=${c.value}\n`).join(''));
							}
							if (existingEntries.length) {
								existingEntries.forEach(e => {
									action.edit!.replace(doc.uri,
										new vscode.Range(e.line!, 0, e.line!, 999999),
										`CONFIG_${e.config.name}=${e.value}`);
								});
							}
							action.isPreferred = true;
							action.diagnostics = [diag];
							ctx.actions.push(action);
							break;
						}
					}
				}
				ctx.diags.push(diag);
				return;
			}

			var selector = c.config.selector(all, ctx.conf.filter((_, index) => index !== i));
			if (selector) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is ${c.value === 'n' ? 'ignored' : 'redundant'} (Already selected by ${(selector instanceof Config) ? selector.name : selector.config.name})`,
					c.value === 'n' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint);
				if (selector instanceof Config) {
					diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(selector.entries[0].loc, `Selected by ${selector.name}`)];
				} else if (selector.line !== undefined) {
					diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, new vscode.Position(selector.line, 0)), `Selected by CONFIG_${selector.config.name}=${selector.value}`)];
				}
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				ctx.diags.push(diag);
				addRedundancyAction(c, diag);
				return;
			}

			var actualValue = c.config.evaluate(all, ctx.conf);
			if (override !== actualValue) {
				ctx.diags.push(new vscode.Diagnostic(line,
					`Entry ${c.config.name} assigned value ${c.value}, but evaluated to ${c.config.toValueString(actualValue)}`,
					vscode.DiagnosticSeverity.Warning));
				return;
			}
		});

		this.diagsAdd(doc.uri, []);
	}

	confFileCtx(uri: vscode.Uri): ConfFile {
		if (!(uri.fsPath in this.confContexts)) {
			this.confContexts[uri.fsPath] = {actions: [], diags: [], conf: []};
		}

		return this.confContexts[uri.fsPath];
	}

	servePropertiesDiag(doc: vscode.TextDocument) {
		var ctx = this.confFileCtx(doc.uri);
		var text = doc.getText();
		var lines = text.split(/\r?\n/g);
		var diags: vscode.Diagnostic[] = [];
		ctx.conf = this.loadConfOptions();
		lines.forEach((line, lineNumber) => {
			var override = this.parseLine(line, diags, lineNumber);
			if (override) {
				var duplicate = ctx.conf.find(c => c.config === override!.config);
				if (duplicate) {
					var thisLine = new vscode.Position(lineNumber, 0);
					var diag = new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${override!.config.name} is already defined`, vscode.DiagnosticSeverity.Warning);
					if (duplicate.line !== undefined) {
						diag.relatedInformation = [{ location: new vscode.Location(doc.uri, new vscode.Position(duplicate.line, 0)), message: 'Previous declaration here' }];
					} else if (duplicate.value === override.value) {
						diag.message += ' in static config';
						diag.tags = [vscode.DiagnosticTag.Unnecessary];
					} else {
						diag.message += ` in static config (previous value ${duplicate.value})`;
						diag.severity = vscode.DiagnosticSeverity.Hint;
					}
					diags.push(diag);
				} else {
					ctx.conf.push(override);
				}
			}
		});

		this.diagsReplace(doc.uri, diags);

		// Analysis is done asynchronously to avoid blocking the code completion handler:
		// process.nextTick(() => this.confFileAnalyze(doc, configurations, diags));
		// this.confFileAnalyze(doc, configurations, diags);
	}

	diagsReplace(uri: vscode.Uri, diags: vscode.Diagnostic[]) {
		this.confContexts[uri.fsPath].diags = diags;
		this.diags.set(uri, this.confContexts[uri.fsPath].diags);
	}

	diagsAdd(uri: vscode.Uri, diags: vscode.Diagnostic[]) {
		if (uri.fsPath in this.confContexts) {
			this.confContexts[uri.fsPath].diags.push(...diags);
		} else {
			this.confContexts[uri.fsPath] = {actions: [], conf: [], diags: diags};
		}
		this.diags.set(uri, this.confContexts[uri.fsPath].diags);
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

	provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location | vscode.Location[] | vscode.LocationLink[]> {
		var config = this.repo.configs[this.getSymbolName(document, position)];
		if (config) {
			return ((config.entries.length === 1) ?
				config.entries :
				config.entries.filter(e => e.file.uri.fsPath !== document.uri.fsPath || position.line < e.lines.start || position.line > e.lines.end))
				.map(e => e.loc);
		}
		return null;
	}

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
		var entry = this.repo.configs[this.getSymbolName(document, position)];
		if (!entry) {
			return null;
		}
		var text = new Array<vscode.MarkdownString>();
		text.push(new vscode.MarkdownString(`${entry.text || entry.name}`));
		if (entry.type) {
			var typeLine = new vscode.MarkdownString(`\`${entry.type}\``);
			if (entry.ranges.length === 1) {
				typeLine.appendMarkdown(`\t\tRange: \`${entry.ranges[0].min}\`-\`${entry.ranges[0].max}\``);
			}
			text.push(typeLine);
		}
		if (entry.help) {
			text.push(new vscode.MarkdownString(entry.help));
		}
		return new vscode.Hover(text, document.getWordRangeAtPosition(position));
	}

	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
		var line = document.lineAt(position.line);
		var wordRange = document.getWordRangeAtPosition(position);

		var wordBase = wordRange ? document.getText(wordRange).slice(0, position.character).replace(/^CONFIG_/, '') : '';

		var isProperties = (document.languageId === 'properties');
		var items: vscode.CompletionItem[];

		if (!isProperties && !line.text.match(/(if|depends\s+on|select|default|def_bool|def_tristate|def_int|def_hex|range)/)) {
			return this.operatorCompletions;
		}

		const maxCount = 500;
		var entries: Config[];
		var count: number;
		if (wordBase.length > 0) {
			var result = fuzzy.go(wordBase,
				Object.values(this.repo.configs),
				{ key: 'name', limit: maxCount, allowTypo: true });

			entries = result.map(r => r.obj);
			count = result.total;
		} else {
			entries = Object.values(this.repo.configs);
			count = entries.length;
			entries = entries.slice(0, maxCount);
		}


		if (isProperties) {
			var lineRange = new vscode.Range(position.line, 0, position.line, 999999);
			var lineText = document.getText(lineRange);
			var replaceText = lineText.replace(/\s*#.*$/, '');
		}

		const kinds = {
			'config': vscode.CompletionItemKind.Variable,
			'menuconfig': vscode.CompletionItemKind.Class,
			'choice': vscode.CompletionItemKind.Enum,
		};

		items = entries.map(e => {
			var item = new vscode.CompletionItem(isProperties ? `CONFIG_${e.name}` : e.name, (e.kind ? kinds[e.kind] : vscode.CompletionItemKind.Text));
			item.sortText = e.name;
			item.detail = e.text;
			if (isProperties) {
				if (replaceText.length > 0) {
					item.range = new vscode.Range(position.line, 0, position.line, replaceText.length);
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

		return { isIncomplete: (count > maxCount), items: items };
	}

	resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
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
			e.defaults.forEach(dflt => {
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

	provideDocumentLinks(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.DocumentLink[] {
		var file = this.repo.files.find(f => f.uri.fsPath === document.uri.fsPath);
		return file?.links ?? [];
	}

	provideReferences(document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location[]> {
		var entry = this.repo.configs[this.getSymbolName(document, position)];
		if (!entry || !entry.type || !['bool', 'tristate'].includes(entry.type)) {
			return null;
		}
		return Object.values(this.repo.configs)
			.filter(config => (
				config.selects.find(s => s.name === entry!.name) ||
				config.dependencies.find(d => d.search(new RegExp(`\\b${entry!.name}\\b`)) !== -1)))
			.map(config => config.entries[0].loc); // TODO: return the entries instead?
	}

	provideCodeActions(document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction[]> {
		if (document.uri.fsPath in this.actions) {
			return this.actions[document.uri.fsPath].filter(a => a.diagnostics![0].range.intersection(range));
		}
	}

	provideDocumentSymbols(document: vscode.TextDocument,
		token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentSymbol[]> {

		var file = this.repo.files.find(f => f.uri.fsPath === document.uri.fsPath);
		if (!file) {
			return [];
		}

		var entries: ConfigEntry[] = file.entries;
		var scopes: { [id: string]: vscode.DocumentSymbol } = {};
		var topLevelSymbols: vscode.DocumentSymbol[] = [];
		try {
		entries.forEach(e => {
			if (token.isCancellationRequested) {
				return;
			}

			var rootParent = e.file.scope;

			var symbol = new vscode.DocumentSymbol(e.config.text ?? e.config.name,
				e.config.text ? '' : e.config.name,
				e.config.symbolKind(),
				new vscode.Range(e.lines.start, 0, e.lines.end, 9999),
				new vscode.Range(e.lines.start, 0, e.lines.start, 9999));

			var scope = e.scope;
			if (!scope || scope.id === rootParent?.id) {
				topLevelSymbols.push(symbol);
				return;
			}

			var child = symbol;
			while (scope && scope.id !== rootParent?.id) {
				symbol = scopes[scope.id];
				if (!symbol) {
					symbol = new vscode.DocumentSymbol(scope.name, '',
						scope.symbolKind,
						scope.range,
						new vscode.Range(scope.lines.start, 0, scope.lines.start, 9999));
					scopes[scope.id] = symbol;
				}

				if (!symbol.children.includes(child)) {
					symbol.children.push(child);
				}

				child = symbol;
				scope = scope.parent;
			}

			if (!topLevelSymbols.includes(child)) {
				topLevelSymbols.push(symbol);
			}
		});
		} catch (e) {
			console.error(e);
		}
		return topLevelSymbols;
	}

	provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
		var entries = fuzzy.go(query.replace(/^CONFIG_/, ''), Object.values(this.repo.configs), {key: 'name'});

		return entries.map(result => new vscode.SymbolInformation(
			result.obj.name,
			vscode.SymbolKind.Property,
			result.obj.entries[0].scope?.name ?? '',
			result.obj.entries[0].loc));
	}

}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	kEnv.update();
	var langHandler = new KconfigLangHandler();

	var status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
	context.subscriptions.push(status);

	status.text = ' $(sync~spin) Kconfig';
	var root = kEnv.resolvePath(kEnv.getConfig('root'));
	if (root) {
		status.tooltip = `Starting from ${root}`;
	}
	status.show();

	langHandler.doScan().then(result => {
		status.text = `Kconfig complete (${result})`;
	}).catch(e => {
		status.text = `$(alert) kconfig failed`;
		status.tooltip = e;
	}).finally(() => {
		setTimeout(() => {
			status.hide();
			status.dispose();
		}, 10000);
	});


	vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('kconfig.env')) {
			kEnv.update();
			langHandler.rescan();
		}
	});


	var selector = [{ language: 'kconfig', scheme: 'file' }, { language: 'properties', scheme: 'file' }];

	let disposable = vscode.languages.registerDefinitionProvider(selector, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerHoverProvider(selector.concat([{language: 'c', scheme: 'file'}]), langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerCompletionItemProvider(selector, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerDocumentLinkProvider({ language: 'kconfig', scheme: 'file' }, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerCodeActionsProvider({ language: 'properties', scheme: 'file' }, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerDocumentSymbolProvider({ language: 'kconfig', scheme: 'file' }, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerWorkspaceSymbolProvider(langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerReferenceProvider({ language: 'kconfig', scheme: 'file' }, langHandler);
	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
