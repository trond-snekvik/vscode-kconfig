// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from "glob";

function getConfig(name: string): any {
	var config = vscode.workspace.getConfiguration("kconfig");
	return config.get(name);
}


class ConfigLocation {
	locations: vscode.Location[];
	name: string;
	help?: string;
	type?: string;
	text?: string;
	dependencies: string[];
	selects: string[];
	defaults: {value: string, condition?: string}[];
	range?: { max: string, min: string };
	kind?: 'config' | 'menuconfig' | 'choice';
	constructor(name: string, location: vscode.Location, kind: string) {
		this.name = name;
		this.locations = [location];
		if (['config', 'menuconfig', 'choice'].includes(kind)) {
			this.kind = kind as 'config' | 'menuconfig' | 'choice';
		}
		this.defaults = [];
		this.dependencies = [];
		this.selects = [];
	}

	isEnabled(value?: string) {
		switch (this.type) {
			case 'bool':
				return (value === undefined) ? this.defaults.some(d => d.value === 'y') : (value === 'y');
			case 'int':
				return (value === undefined) ? this.defaults.some(d => d.value !== '0') : (value !== '0');
			case 'hex':
				return (value === undefined) ? this.defaults.some(d => d.value !== '0x0') : (value !== '0x0');
			default:
				return true;
		}
	}
}

type LocationFile = { uri: vscode.Uri, links: vscode.DocumentLink[], entries: { [name: string]: ConfigLocation } };


function pathReplace(fileName: string): string {
	var env = getConfig('env') as { [name: string]: string };
	if (env) {
		Object.entries(env).forEach(([envVar, replacement]) => {
			fileName = fileName.replace(`$(${envVar})`, replacement);
		});
	}

	fileName = fileName.replace(/\${workspaceFolder:([^}]+)}/g, (original, name) => {
		var folder = vscode.workspace.workspaceFolders!.find(folder => folder.name === name);
		return folder ? folder.uri.fsPath : original;
	});

	fileName = fileName.replace(/\${([^}]+)}/g, (original: string, v?: string) => {
		if (v && v in process.env) {
			return process.env[v] as string;
		}
		return original;
	});

	return fileName.replace(/$\([^)]+\)/g, '');
}

function getRoot(file?: string): string {
	try {
		var rootFile = getConfig('root');
		if (rootFile) {
			return pathReplace(path.dirname(rootFile));
		}
		return vscode.workspace.workspaceFolders!.find(folder => path.normalize(file ? file : vscode.window.activeTextEditor!.document.fileName).startsWith(path.normalize(folder.uri.fsPath)))!.uri.fsPath;
	} catch (e) {
		return '';
	}
}

function resolvePath(fileName: string, root?: string) {
	if (!root) {
		root = getRoot(fileName);
	}
	fileName = fileName.replace('${workspaceFolder}', root);
	fileName = pathReplace(fileName);
	return path.normalize(path.isAbsolute(fileName) ? fileName : path.join(root ? root : root, fileName));
}

type Environment = { [variable: string]: string };

function envReplace(text: string, env: Environment) {
	return text.replace(/\$\(([^)]+)(?:(,[^)]+))?\)/, (original, variable, dflt) => ((variable in env) ? env[variable] : dflt ? dflt : original));
}

class KconfigDefinitionProvider implements vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.DocumentLinkProvider, vscode.ReferenceProvider {

	files: { [fileName: string]: LocationFile };
	entries: { [name: string]: ConfigLocation };

	diags: vscode.DiagnosticCollection;

	operatorCompletions: vscode.CompletionItem[];

	constructor() {
		this.files = {};
		this.entries = {};
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
		];
		var dependsOn = new vscode.CompletionItem('depends on', vscode.CompletionItemKind.Keyword);
		dependsOn.insertText = new vscode.SnippetString('depends on ');
		dependsOn.insertText.appendTabstop();
		this.operatorCompletions.push(dependsOn);
		var visibleIf = new vscode.CompletionItem('visible if', vscode.CompletionItemKind.Keyword);
		visibleIf.insertText = new vscode.SnippetString('visible if ');
		visibleIf.insertText.appendTabstop();
		this.operatorCompletions.push(visibleIf);
		var range = new vscode.CompletionItem('range', vscode.CompletionItemKind.Keyword);
		range.insertText = new vscode.SnippetString('range ');
		range.insertText.appendPlaceholder('min');
		range.insertText.appendText(' ');
		range.insertText.appendPlaceholder('max');
		this.operatorCompletions.push(range);
		var dflt = new vscode.CompletionItem('default', vscode.CompletionItemKind.Keyword);
		dflt.insertText = new vscode.SnippetString('default ');
		dflt.insertText.appendPlaceholder('value');
		this.operatorCompletions.push(dflt);

		this.operatorCompletions.forEach(c => c.commitCharacters = [' ']);

		var help = new vscode.CompletionItem('help', vscode.CompletionItemKind.Keyword);
		help.insertText = new vscode.SnippetString('help \n  ');
		help.insertText.appendTabstop();
		this.operatorCompletions.push(help);

		vscode.workspace.onDidOpenTextDocument(doc => this.scanDoc(doc, false));
		vscode.workspace.onDidChangeTextDocument(e => {
			var file = this.files[e.document.uri.fsPath];
			if (file) {
				e.contentChanges.forEach(change => {
					Object.values(file.entries).forEach(entry => {
						entry.locations.forEach(loc => {
							if (loc.uri.fsPath === file.uri.fsPath) {
								if (loc.range.start.isAfter(change.range.start)) {
									var lineOffset = change.text.split(/\r?\n/g).length - (change.range.end.line - change.range.start.line)-1;
									loc.range = new vscode.Range(loc.range.start.translate(lineOffset), loc.range.end.translate(lineOffset));
								}
							}
						});
					});
				});
			}
			this.scanDoc(e.document, true, false);
		});

		this.diags = vscode.languages.createDiagnosticCollection('kconfig');
	}

	async doScan(): Promise<string> {
		var hrTime = process.hrtime();
		var start = (hrTime[0] * 1000 + hrTime[1] / 1000000);
		if (vscode.window.activeTextEditor) {
			this.scanDoc(vscode.window.activeTextEditor.document);
		}
		var root = resolvePath(getConfig('root'));
		if (root) {
			this.scanFile(root, false);
		}
		hrTime = process.hrtime();
		var end = (hrTime[0] * 1000 + hrTime[1] / 1000000);
		return Promise.resolve(`${this.getAll().length} entries, ${((end - start) / 1000).toFixed(2)} s`);
	}

	scanText(uri: vscode.Uri, text: string, reparse: boolean=true, recursive?: boolean, env: Environment = {}, dependencies:string[]=[]) {
		var file: LocationFile;

		if (uri.fsPath in this.files) {
			if (!reparse) {
				return;
			}
			file = this.files[uri.fsPath];
			file.links = [];
		} else {
			file = { uri: uri, entries: {}, links: [] };
			this.files[uri.fsPath] = file;
		}
		var lines = text.split(/\r?\n/g);
		if (lines) {
			if (recursive === undefined) {
				recursive = getConfig('recursive') as boolean;
				if (recursive === undefined) {
					recursive = true;
				}
			}
			var entry: ConfigLocation | null = null;
			var help = false;
			var helpIndent: string | null = null;
			for (var lineNumber = 0; lineNumber < lines.length; lineNumber++) {
				var line = lines[lineNumber];
				if (line.length === 0) {
					continue;
				}
				var match = line.match(/^(\s*(?<kind>menuconfig|config|choice)\s+)(?<name>[^\s#]+)/);
				if (match) {
					var name = envReplace(match.groups!['name'], env);
					var location = new vscode.Location(uri, new vscode.Position(lineNumber, match[1].length));
					if (name in this.entries) {
						entry = this.entries[name];
						file.entries[name] = entry;
						if (!entry.locations.find(loc => loc.uri.fsPath === uri.fsPath && loc.range.start.line === lineNumber)) {
							entry.locations.push(location);
						}
					} else {
						entry = new ConfigLocation(name, location, match.groups!['kind']);
						file.entries[name] = entry;
						this.entries[name] = entry;
					}
					entry.dependencies = entry.dependencies.concat(dependencies.filter(d => !(entry!.dependencies.includes(d))));
					continue;
				}
				match = line.match(/^(\s*(source|rsource|osource)\s+)"([^"]+)"/);
				if (match) {
					var includeFile = resolvePath(match[3], match[2] === 'rsource' ? path.dirname(uri.fsPath) : undefined);
					if (includeFile) {
						if (recursive) {
							var matches = glob.sync(includeFile);
							var range = new vscode.Range(new vscode.Position(lineNumber, match![1].length + 1),
														 new vscode.Position(lineNumber, match![0].length - 1));
							matches.forEach(match => {
								this.scanFile(match, true, recursive, Object.assign({}, env)); // assign clones the object
								if (fs.existsSync(match)) {
									var link = new vscode.DocumentLink(range, vscode.Uri.file(match));
									link.tooltip = match;
									file.links.push(link);
								}
							});
						}
					}
					continue;
				}
				match = line.match(/^\s*if\s+([\w\d_-]+)/);
				if (match) {
					var dep = envReplace(match[1], env);
					if (!dependencies.includes(dep)) {
						dependencies.push(dep);
					}
					continue;
				}
				match = line.match(/^\s*endif/);
				if (match) {
					dependencies.pop();
					continue;
				}
				if (entry !== null) {
					if (help) {
						var indent = line.match(/^\s*/)![0];
						if (helpIndent === null) {
							helpIndent = indent;
						}
						if (indent.startsWith(helpIndent)) {
							entry.help += ' ' + line.trim();
						} else {
							help = false;
							if (entry.help) {
								entry.help = envReplace(entry.help, env).trim();
							}
						}
					}
					if (help) {
						continue;
					}
					match = line.match(/(bool|tristate|string|hex|int)(?:\s+"([^"]+)")?/);
					if (match) {
						entry.type = match[1];
						entry.text = match[2] ? envReplace(match[2], env) : undefined;
						continue;
					}
					match = line.match(/^\s*depends\s+on\s+([\w\d_-]+)/);
					if (match) {
						var depOn = envReplace(match[1], env);
						if (!dependencies.includes(depOn)) {
							entry.dependencies.push(depOn);
						}
						continue;
					}
					match = line.match(/^\s*select\s+([\w\d_-]+)/);
					if (match) {
						var select = envReplace(match[1], env);
						entry.selects.push(select);
						continue;
					}
					if (match) {
						entry.type = match[1];
						entry.text = match[2] ? envReplace(match[2], env) : undefined;
						continue;
					}
					match = line.match(/^\s*help\s*$/);
					if (match) {
						help = true;
						helpIndent = null;
						entry.help = '';
						continue;
					}
					match = line.match(/^\s*([\w\d_\-]+)\s*=\s*([\w\d_\-]+)$/);
					if (match) {
						env[match[1]] = match[2];
						continue;
					}
					match = line.match(/^\s*default\s+(.*?)(?:#|if\s+(.*)|$)/);
					if (match) {
						entry.defaults.push({ value: envReplace(match[1], env), condition: match[2] ? envReplace(match[2], env) : undefined });
						continue;
					}
					match = line.match(/^\s*range\s+(\S+|\([^)]+\))\s+(\S+|\([^)]+\))/);
					if (match) {
						entry.range = {
							min: envReplace(match[1], env),
							max: envReplace(match[2], env),
						};
						continue;
					}
				}
			}
		}
	}

	scanDoc(doc: vscode.TextDocument, reparse: boolean=true, recursive?: boolean, env?: {[variable: string]: string}) {
		if (doc && doc.uri && doc.uri.scheme === 'file') {
			if (doc.languageId === 'kconfig') {
				this.scanText(doc.uri, doc.getText(), reparse, recursive, env);
			} else if (doc.languageId === 'properties') {
				this.servePropertiesDiag(doc);
			}
		}
	}

	scanFile(fileName?: string, reparse: boolean=true, recursive?: boolean, env?: {[variable: string]: string}) {
		if (!fileName) {
			return;
		}

		var buf = fs.readFileSync(fileName, {encoding: 'utf-8', flag: 'r'});
		if (!buf) {
			return;
		}

		this.scanText(vscode.Uri.file(fileName), buf.toString(), reparse, recursive, env);
	}

	servePropertiesDiag(doc: vscode.TextDocument) {
		var text = doc.getText();
		var lines = text.split(/\r?\n/g);
		var diags: vscode.Diagnostic[] = [];
		// var configurations: { entry: ConfigLocation, value: string, line?: number }[] = [];
		lines.forEach((line, lineNumber) => {
			var match = line.match(/^\s*CONFIG_([^\s=]+)\s*(?:=\s*([\d\w_-]+))?/);
			if (match) {
				var thisLine = new vscode.Position(lineNumber, 0);
				if (match[2]) {

					var entry = this.getEntry(match[1]);
					if (entry) {
						if (entry.type && ['int', 'hex'].includes(entry.type) && entry.range) {
							var value = parseInt(match[2]);
							var range = { min: parseInt(entry.range.min), max: parseInt(entry.range.max) };
							if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) {
								diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} outside range \`${entry.range.min}\`-\`${entry.range.max}\``, vscode.DiagnosticSeverity.Error));
							}
						}
						switch (entry.type) {
							case 'bool':
								if (!['y', 'n'].includes(match[2])) {
									diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} is a boolean, should be 'y' or 'n'`, vscode.DiagnosticSeverity.Error));
								}
								break;
							case 'tristate':
								if (!['y', 'n', 'm'].includes(match[2])) {
									diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} is a tristate, should be 'y', 'n' or 'm'`, vscode.DiagnosticSeverity.Error));
								}
								break;
							case 'hex':
								if (!match[2].match(/^0x[a-fA-F\d]+$/)) {
									diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} is a hex, should be on the form '0x1bad234'`, vscode.DiagnosticSeverity.Error));
								}
								break;
							case 'int':
								if (!match[2].match(/^\d+$/)) {
									diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} is an int, should be on the form '1234'`, vscode.DiagnosticSeverity.Error));
								}
								break;
							case 'string':
								if (!match[2].match(/^".*"$/)) {
									diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} is a string, should be on the form "text"`, vscode.DiagnosticSeverity.Error));
								}
								break;
							default:
								diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${match[1]} is of unknown type`, vscode.DiagnosticSeverity.Warning));
								break;
						}
						// configurations.push({ entry: entry, value: match[2], line: lineNumber });
						// configurations = configurations.concat(this.getSelections(entry).map(e => { return { entry: e, value: 'y'}; }));
					} else {
						diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), 'Unknown entry ' + match[1], vscode.DiagnosticSeverity.Error));
					}
				} else {
					diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), 'Missing value for config ' + match[1], vscode.DiagnosticSeverity.Error));
				}
			}
		});

		// TODO: This part is quite complex with selects, defaults and dependencies all over. Needs some proper consideration to work.
		// configurations.filter(config => config.entry.type === 'bool' && config.value === 'y' && config.line !== undefined).forEach(config => {
		// 	config.entry.dependencies.map(dep => this.getEntry(dep)).forEach(dep => {
		// 		if (dep && dep.type === 'bool') {
		// 			var listing = configurations.find(config => config.entry === dep);
		// 			if ((listing && listing.value === 'n') ||
		// 				(!dep.defaults.find(dflt => dflt.value === 'y') && !listing && !this.getSelectorsRecursive(dep, configurations).)) {
		// 				var thisLine = new vscode.Position(config.line!, 0);
		// 				diags.push(new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `${config.entry.name} depends on ${dep.name}, which doesn't appear to be enabled.`, vscode.DiagnosticSeverity.Warning));
		// 			}
		// 		}
		// 	});
		// });

		this.diags.set(doc.uri, diags);
	}

	getSelectors(entry: ConfigLocation): ConfigLocation[] {
		var all = this.getAll();
		return all.filter(e => e.selects.includes(entry.name));
	}

	// getSelectorsRecursive(entry: ConfigLocation, configItems: {entry: ConfigLocation, value: string, line?: number}[]): ConfigLocation[] {
	// 	var all = this.getAll();
	// 	var selectors: ConfigLocation[] = [];
	// 	all.filter(e => e.selects.includes(entry.name) && e.isEnabled(configItems.find(c => c.entry === e).value) !selectors.includes(entry)).forEach(e => {
	// 		selectors.push(e);
	// 		selectors = selectors.concat(this.getSelectorsRecursive(e, configItems).filter(e => !selectors.includes(e)));
	// 	});
	// 	return selectors;
	// }

	getSelections(entry: ConfigLocation): ConfigLocation[] {
		var selects: ConfigLocation[] = [];
		entry.selects.forEach(sel => {
			var selected = this.getEntry(sel);
			if (selected && selected.type === 'bool' && !selects.includes(selected)) {
				selects.push(selected);
				selects = selects.concat(this.getSelections(selected));
			}
		});
		return selects;
	}

	deleteEntry(entry: ConfigLocation) {
		if (entry) {
			entry.locations.forEach(l => delete this.files[l.uri.fsPath].entries[entry.name]);
			delete this.entries[entry.name];
		}
	}

	resetFile(file: LocationFile) {
		Object.values(file.entries).forEach(entry => {
			entry.locations = entry.locations.filter(loc => loc.uri.fsPath !== file.uri.fsPath);
			if (entry.locations.length === 0) {
				delete this.entries[entry.name];
			}
		});
		file.entries = {};
	}

	getEntry(name: string): ConfigLocation | undefined {
		return this.entries[name];
	}

	getAll(): ConfigLocation[] {
		return Object.values(this.entries);
	}

	getSymbolName(document: vscode.TextDocument, position: vscode.Position) {
		var range = document.getWordRangeAtPosition(position);
		var word = document.getText(range);
		return document.languageId === 'properties' ? word.slice('CONFIG_'.length) : word;
	}

	provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location | vscode.Location[] | vscode.LocationLink[]> {
		var entry = this.getEntry(this.getSymbolName(document, position));
		if (entry) {
			return entry.locations;
		}
		return null;
	}

	provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
		var entry = this.getEntry(this.getSymbolName(document, position));
		if (!entry) {
			return null;
		}
		var text = new Array<vscode.MarkdownString>();
		text.push(new vscode.MarkdownString(`${entry.text || entry.name}`));
		if (entry.type) {
			var typeLine = new vscode.MarkdownString(`\`${entry.type}\``);
			if (entry.range) {
				typeLine.appendMarkdown(`\t\tRange: \`${entry.range.min}\`-\`${entry.range.max}\``);
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

		var isProperties = (document.languageId === 'properties');
		var entries: vscode.CompletionItem[];
		if ((document.languageId === 'kconfig' && line.text.match(/(visible if|depends on|select|default|def_bool|def_tristate)/)) || isProperties) {
			entries = this.getAll().filter(e => !(isProperties && e.kind === 'choice')).map(e => {
				var kinds = {
					'config': vscode.CompletionItemKind.Variable,
					'menuconfig': vscode.CompletionItemKind.Class,
					'choice': vscode.CompletionItemKind.Enum,
				};

				var item = new vscode.CompletionItem(isProperties ? `CONFIG_${e.name}` : e.name, (e.kind ? kinds[e.kind] : vscode.CompletionItemKind.Text));
				item.sortText = e.name;
				item.detail = e.text;
				if (isProperties) {
					item.insertText = new vscode.SnippetString(`${item.label}=`);
					switch (e.type) { // bool|tristate|string|hex|int
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
			entries.push(new vscode.CompletionItem('if', vscode.CompletionItemKind.Keyword));
			return entries;
		} else {
			return this.operatorCompletions;
		}
	}

	resolveCompletionItem(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
		if (!item.sortText) {
			return item;
		}
		var e = this.getEntry(item.sortText);
		if (!e) {
			return item;
		}
		var doc = new vscode.MarkdownString(`\`${e.type}\``);
		if (e.range) {
			doc.appendMarkdown(`\t\tRange: \`${e.range.min}\`-\`${e.range.max}\``);
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
		if (document.uri.fsPath in this.files) {
			return this.files[document.uri.fsPath].links;
		}
		return [];
	}

	provideReferences(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Location[]> {
		var entry = this.getEntry(this.getSymbolName(document, position));
		if (!entry) {
			return null;
		}

		return this.getSelectors(entry).map(s => s.locations[0]);
	}

}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	var definitionProvider = new KconfigDefinitionProvider();

	var status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
	context.subscriptions.push(status);

	status.text = ' $(sync) kconfig';
	var root = resolvePath(getConfig('root'));
	if (root) {
		status.tooltip = `Starting from ${root}`;
	}
	status.show();
	setTimeout(() => {
		definitionProvider.doScan().then(result => {
			status.text = `$(verified) kconfig complete (${result})`;
		}).catch(e => {
			status.text = `$(alert) kconfig failed`;
			status.tooltip = e;
		}).finally(() => {
			setTimeout(() => {
				status.hide();
				status.dispose();
			}, 10000);
		});
	}, 50);


	var selector = [{ language: 'kconfig', scheme: 'file' }, { language: 'properties', scheme: 'file' }];

	let disposable = vscode.languages.registerDefinitionProvider(selector, definitionProvider);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerHoverProvider(selector, definitionProvider);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerCompletionItemProvider(selector, definitionProvider);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerDocumentLinkProvider({ language: 'kconfig', scheme: 'file' }, definitionProvider);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerReferenceProvider({ language: 'kconfig', scheme: 'file' }, definitionProvider);
	context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
