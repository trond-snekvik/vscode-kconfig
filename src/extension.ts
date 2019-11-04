// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from "glob";
import { resolveExpression } from './evaluate';

function getConfig(name: string): any {
	var config = vscode.workspace.getConfiguration("kconfig");
	return config.get(name);
}


export type ConfigValue = string | number | boolean;
export type ConfigValueRange = { max: string, min: string, condition?: string };
export type ConfigValueType = 'string' | 'int' | 'hex' | 'bool' | 'tristate';
export type ConfigOverride = { config: ConfigLocation, value: string, line?: number };
export type ConfigKind = 'config' | 'menuconfig' | 'choice';

export class ConfigLocation {
	locations: vscode.Location[];
	name: string;
	help?: string;
	type?: ConfigValueType;
	text?: string;
	dependencies: string[];
	choices?: { name: string };
	selects: { name: string, condition?: string }[];
	defaults: { value: string, condition?: string }[];
	ranges: ConfigValueRange[];
	kind?: ConfigKind;
	constructor(name: string, location: vscode.Location, kind?: ConfigKind, type?: ConfigValueType) {
		this.name = name;
		this.locations = [location];
		this.kind = kind;
		this.defaults = [];
		this.dependencies = [];
		this.selects = [];
		this.ranges = [];
		this.type = type;
	}

	isValidOverride(overrideValue: string): boolean {

		switch (this.type) {
			case 'bool':
				return ['y', 'n'].includes(overrideValue);
			case 'tristate':
				return ['y', 'n', 'm'].includes(overrideValue);
			case 'hex':
				return !!overrideValue.match(/^0x[a-fA-F\d]+/);
			case 'int':
				return !!overrideValue.match(/^\d+/);
			case 'string':
				return !!overrideValue.match(/^"[^"]*"/);
			default:
				return false;
		}
	}

	defaultValue(all: ConfigLocation[], overrides: ConfigOverride[] = []): ConfigValue {
		var dflt = this.defaults.find(d => d.condition === undefined || resolveExpression(d.condition, all, overrides) === true);
		if (dflt) {
			return resolveExpression(dflt.value, all, overrides);
		}

		return false;
	}

	isEnabled(value?: string) {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return (value === undefined) ? this.defaults.some(d => d.value === 'y') : (value === 'y');
			case 'int':
				return (value === undefined) ? this.defaults.some(d => d.value !== '0') : (value !== '0');
			case 'hex':
				return (value === undefined) ? this.defaults.some(d => d.value !== '0x0') : (value !== '0x0');
			default:
				return true;
		}
	}

	resolveValueString(value: string): ConfigValue {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value === 'y' || value === 'm';
			case 'int':
			case 'hex':
				return Number(value);
			case 'string':
				return value;
			default:
				return false;
		}
	}

	toValueString(value: ConfigValue): string {
		switch (this.type) {
			case 'bool':
			case 'tristate':
				return value ? 'y' : 'n';
			case 'int':
				return value.toString(10);
			case 'hex':
				return '0x' + value.toString(16);
			case 'string':
				return `"${value}"`;
			default:
				return 'n';
		}
	}

	getRange(all: ConfigLocation[], overrides: ConfigOverride[] = []): {min: number, max: number} {

		var range = this.ranges.find(r => !r.condition || resolveExpression(r.condition, all, overrides));
		if (range) {
			return {
				min: this.evaluateSymbol(range.min, all, overrides) as number,
				max: this.evaluateSymbol(range.max, all, overrides) as number,
			};
		}
		return { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER };

	}

	evaluateSymbol(name: string, all: ConfigLocation[], overrides: ConfigOverride[] = []): ConfigValue {
		if (name.match(/^\s*(0x[\da-fA-F]+|\d+)\s*$/)) {
			return Number(name);
		} else if (name.match(/^\s*[ynm]\s*$/)) {
			return name.trim() !== 'n';
		}

		var symbol = all.find(c => c.name === name);
		if (!symbol) {
			return false;
		}
		return symbol.evaluate(all, overrides);
	}

	evaluate(all: ConfigLocation[], overrides: ConfigOverride[] = []): ConfigValue {
		// All dependencies must be true
		if (!this.dependencies.every(d => resolveExpression(d, all, overrides) === true)) {
			return false;
		}

		var override = overrides.find(o => o.config.name === this.name);
		if (override) {
			return this.resolveValueString(override.value);
		}

		if (this.type === 'bool' || this.type === 'tristate') {
			var selectorFilter = (s: { name: string, condition?: string }) => {
				return s.name === this.name && (s.condition === undefined || resolveExpression(s.condition, all, overrides));
			};

			var select = overrides.find(
				o => (
					(o.config.type === 'bool' || o.config.type === 'tristate') &&
					o.config.isEnabled(o.value) &&
					o.config.selects.find(selectorFilter)
				)
			) || all.find(
				c => (
					(c.type === 'bool' || c.type === 'tristate') &&
					c.selects.find(selectorFilter) &&
					c.evaluate(all, overrides)
				)
			);

			if (select) {
				return true;
			}
		}

		return this.defaultValue(all, overrides) || false;
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

class KconfigLangHandler implements vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.DocumentLinkProvider, vscode.ReferenceProvider {

	files: { [fileName: string]: LocationFile };
	entries: { [name: string]: ConfigLocation };
	staticConf: ConfigOverride[];
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
		this.staticConf = [];

		this.operatorCompletions.forEach(c => c.commitCharacters = [' ']);

		var help = new vscode.CompletionItem('help', vscode.CompletionItemKind.Keyword);
		help.insertText = new vscode.SnippetString('help \n  ');
		help.insertText.appendTabstop();
		this.operatorCompletions.push(help);
		this.diags = vscode.languages.createDiagnosticCollection('kconfig');

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

		vscode.window.visibleTextEditors
			.filter(e => e.document.languageId === 'properties')
			.forEach(e => this.servePropertiesDiag(e.document));

		hrTime = process.hrtime();
		var end = (hrTime[0] * 1000 + hrTime[1] / 1000000);
		return Promise.resolve(`${this.getAll().length} entries, ${((end - start) / 1000).toFixed(2)} s`);
	}

	scanText(uri: vscode.Uri, text: string, reparse: boolean=true, recursive?: boolean, env: Environment = {}, dependencies:string[]=[]) {
		var file: LocationFile;
		var choice: ConfigLocation | null = null;

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
		if (!lines) {
			return;
		}

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
			var line = envReplace(lines[lineNumber], env);
			if (line.length === 0) {
				continue;
			}

			if (help) {
				var indent = line.match(/^\s*/)![0];
				if (helpIndent === null) {
					helpIndent = indent;
				}
				if (indent.startsWith(helpIndent)) {
					if (entry) {
						entry.help += ' ' + line.trim();
					}
				} else {
					help = false;
					if (entry && entry.help) {
						entry.help = entry.help.trim();
					}
				}
			}
			if (help) {
				continue;
			}

			var match = line.match(/^(\s*(?<kind>menuconfig|config)\s+)(?<name>[\d\w_]+)/);
			var location;
			var name: string;
			if (match) {
				name = match.groups!['name'];
				location = new vscode.Location(uri, new vscode.Position(lineNumber, match[1].length));
				if (name in this.entries) {
					entry = this.entries[name];
					file.entries[name] = entry;
					if (!entry.locations.find(loc => loc.uri.fsPath === uri.fsPath && loc.range.start.line === lineNumber)) {
						entry.locations.push(location);
					}
				} else {
					entry = new ConfigLocation(name, location, match.groups!['kind'] as ConfigKind);
					file.entries[name] = entry;
					this.entries[name] = entry;
				}
				entry.dependencies = entry.dependencies.concat(dependencies.filter(d => !(entry!.dependencies.includes(d))));

				if (choice) {
					var dflt = choice.defaults.find(d => d.value === name);
					if (dflt) {
						entry.defaults.push({ value: 'y', condition: dflt.condition });
					}
				}

				if (match.groups!['kind'] === 'menuconfig') {
					dependencies.push(name);
				}
				continue;
			}
			match = line.match(/^(\s*)choice(?:\s+([\d\w_]+))?/);
			if (match) {
				location = new vscode.Location(uri, new vscode.Position(lineNumber, match[1].length));
				name = match[2] || `<choice @ ${uri.fsPath}:${lineNumber}>`;
				entry = new ConfigLocation(name, location, 'choice');
				choice = entry;
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
			match = line.match(/^\s*if\s+([^#]+)/);
			if (match) {
				var dep = match[1];
				if (!dependencies.includes(dep)) {
					dependencies.push(dep);
				}
				continue;
			}
			match = line.match(/^\s*(endif|endmenu)/);
			if (match) {
				dependencies.pop();
				continue;
			}
			match = line.match(/^\s*endchoice\b/);
			if (match) {
				choice = null;
				continue;
			}
			if (entry !== null) {
				match = line.match(/(bool|tristate|string|hex|int)(?:\s+"([^"]+)")?/);
				if (match) {
					entry.type = match[1] as ConfigValueType;
					entry.text = match[2];
					continue;
				}
				match = line.match(/^\s*depends\s+on\s+([^#]+)/);
				if (match) {
					var depOn = match[1];
					if (!dependencies.includes(depOn)) {
						entry.dependencies.push(depOn);
					}
					continue;
				}
				match = line.match(/^\s*select\s+([\w\d_]+)(?:\s+if\s+([^#]+))?/);
				if (match) {
					entry.selects.push({name: match[1], condition: match[2]});
					continue;
				}
				if (match) {
					entry.type = match[1];
					entry.text = match[2];
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
				var ifStatement;
				match = line.match(/^\s*default\s+([^#]+)/);
				if (match) {
					ifStatement = match[1].match(/(.*)if\s+([^#]+)/);
					if (ifStatement) {
						entry.defaults.push({ value: ifStatement[1], condition: ifStatement[2] });
					} else {
						entry.defaults.push({ value: match[1] });
					}
					continue;
				}
				match = line.match(/^\s*def_(bool|tristate)\s+([^#]+)/);
				if (match) {
					entry.type = match[1] as ConfigValueType;
					ifStatement = match[2].match(/(.*)if\s+([^#]+)/);
					if (ifStatement) {
						entry.defaults.push({ value: ifStatement[1], condition: ifStatement[2] });
					} else {
						entry.defaults.push({ value: match[2] });
					}
					continue;
				}
				match = line.match(/^\s*range\s+([\w\d_]+)\s+([\w\d_]+)(?:\s+if\s+([^#]+))?/);
				if (match) {
					entry.ranges.push({
						min: match[1],
						max: match[2],
						condition: match[3],
					});
					continue;
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

	loadConfOptions(): ConfigOverride[] {
		var conf: { [config: string]: string | boolean | number } = getConfig('conf');
		var entries: ConfigOverride[] = [];
		Object.keys(conf).forEach(c => {
			var e = this.getEntry(c);
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

		var conf_files: string[] = getConfig('conf_files');
		if (conf_files) {
			conf_files.forEach(f => {
				try {
					var text = fs.readFileSync(pathReplace(f), 'utf-8');
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
		var match = line.match(/^\s*CONFIG_([^\s=]+)\s*(?:=\s*("[^"]*"|[ynm]\b|0x[a-fA-F\d]+\b|\d+\b))?/);
		if (match) {
			var override;
			var thisLine = lineNumber !== undefined ? new vscode.Position(lineNumber, 0) : undefined;
			if (match[2]) {
				var entry = this.getEntry(match[1]);
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
		}
	}

	servePropertiesDiag(doc: vscode.TextDocument) {
		var text = doc.getText();
		var lines = text.split(/\r?\n/g);
		var diags: vscode.Diagnostic[] = [];
		var configurations: ConfigOverride[] = this.loadConfOptions();
		lines.forEach((line, lineNumber) => {
			var override = this.parseLine(line, diags, lineNumber);
			if (override) {
				var duplicate = configurations.find(c => c.config === override!.config);
				if (duplicate) {
					var thisLine = new vscode.Position(lineNumber, 0);
					var diag = new vscode.Diagnostic(new vscode.Range(thisLine, thisLine), `Entry ${override!.config.name} is already defined`, vscode.DiagnosticSeverity.Warning);
					if (duplicate.line !== undefined) {
						diag.relatedInformation = [{ location: new vscode.Location(doc.uri, new vscode.Position(duplicate.line, 0)), message: 'Previous declaration here' }];
					}
					diags.push(diag);
				} else {
					configurations.push(override);
				}
			}
		});

		var all = this.getAll();

		// Post processing, now that all values are known:
		configurations.forEach(c => {
			var override = c.config.resolveValueString(c.value);
			if (c.line === undefined) {
				return;
			}

			var line = new vscode.Range(c.line, 0, c.line, 99999999);

			if (c.config.type && ['int', 'hex'].includes(c.config.type)) {

				var range = c.config.getRange(all, configurations);
				if ((range.min !== undefined && override < range.min) || (range.max !== undefined && override > range.max)) {
					diags.push(new vscode.Diagnostic(line,
						`Entry ${c.value} outside range \`${range.min}\`-\`${range.max}\``,
						vscode.DiagnosticSeverity.Error));
				}
			}
			if (override === c.config.defaultValue(all, configurations)) {
				diags.push(new vscode.Diagnostic(line,
					`Entry ${c.config.name} is redundant (same as default)`,
					vscode.DiagnosticSeverity.Hint));
			}

			var actualValue = c.config.evaluate(all, configurations);
			// tslint:disable-next-line: triple-equals (want to ignore false != undefined)
			if (override != actualValue) {
				if (!actualValue) {
					diags.push(new vscode.Diagnostic(line,
						`Entry ${c.config.name} isn't used.`,
						vscode.DiagnosticSeverity.Warning));
				} else {
					diags.push(new vscode.Diagnostic(line,
						`Entry ${c.config.name} assigned value ${c.value}, but evaluated to ${c.config.toValueString(actualValue)}`,
						vscode.DiagnosticSeverity.Warning));
				}
			}
		});

		this.diags.set(doc.uri, diags);
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

		return []; // TODO
	}

}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	var langHandler = new KconfigLangHandler();

	var status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
	context.subscriptions.push(status);

	status.text = ' $(sync) kconfig';
	var root = resolvePath(getConfig('root'));
	if (root) {
		status.tooltip = `Starting from ${root}`;
	}
	status.show();
	setTimeout(() => {
		langHandler.doScan().then(result => {
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

	let disposable = vscode.languages.registerDefinitionProvider(selector, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerHoverProvider(selector, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerCompletionItemProvider(selector, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerDocumentLinkProvider({ language: 'kconfig', scheme: 'file' }, langHandler);
	context.subscriptions.push(disposable);
	// disposable = vscode.languages.registerReferenceProvider({ language: 'kconfig', scheme: 'file' }, langHandler);
	// context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
