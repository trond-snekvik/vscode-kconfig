// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from "glob";
import { resolveExpression, tokenizeExpression, TokenKind } from './evaluate';

function getConfig(name: string): any {
	var config = vscode.workspace.getConfiguration("kconfig");
	return config.get(name);
}


export type ConfigValue = string | number | boolean;
export type ConfigValueRange = { max: string, min: string, condition?: string };
export type ConfigValueType = 'string' | 'int' | 'hex' | 'bool' | 'tristate';
export type ConfigOverride = { config: ConfigLocation, value: string, line?: number };
export type ConfigKind = 'config' | 'menuconfig' | 'choice';
export type ConfigMenu = { prompt: string, dependencies: string[], location: vscode.Location, parents: ConfigMenu[] };

export class ConfigLocation {
	locations: vscode.Location[];
	name: string;
	help?: string;
	menu: ConfigMenu[];
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
		this.menu = [];
	}

	includeLineInLoc(uri: vscode.Uri, lineNumber: number, line: string) {

		var location = this.locations.find(l => l.uri.fsPath === uri.fsPath && l.range.end.line === lineNumber - 1);
		if (location) {
			location.range = new vscode.Range(location.range.start, new vscode.Position(lineNumber, line.length));
		}
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

	missingDependency(all: ConfigLocation[], overrides: ConfigOverride[] = []): string | undefined {
		return this.dependencies.find(d => !resolveExpression(d, all, overrides));
	}

	selector(all: ConfigLocation[], overrides: ConfigOverride[] = []) {


		if (this.type !== 'bool' && this.type !== 'tristate') {
			return undefined;
		}

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

		return select;
	}

	evaluate(all: ConfigLocation[], overrides: ConfigOverride[] = []): ConfigValue {
		// All dependencies must be true
		if (this.missingDependency(all, overrides)) {
			return false;
		}

		var override = overrides.find(o => o.config.name === this.name);
		if (override) {
			return this.resolveValueString(override.value);
		}

		if (this.selector(all, overrides)) {
			return true;
		}

		return this.defaultValue(all, overrides) || false;
	}

	symbolKind(): vscode.SymbolKind {

		switch (this.kind) {
			case "choice":
				return vscode.SymbolKind.Enum;
			case "menuconfig":
				return vscode.SymbolKind.Class;
			case "config":
				switch (this.type) {
					case "bool": return vscode.SymbolKind.Boolean;
					case "tristate": return vscode.SymbolKind.EnumMember;
					case "int": return vscode.SymbolKind.Number;
					case "hex": return vscode.SymbolKind.Number;
					case "string": return vscode.SymbolKind.String;
				}
				/* Intentionall fall-through: Want undefined types to be handled like undefined kinds */
			case undefined:
				return vscode.SymbolKind.Null;
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

class KconfigLangHandler implements vscode.DefinitionProvider, vscode.HoverProvider, vscode.CompletionItemProvider, vscode.DocumentLinkProvider, vscode.ReferenceProvider, vscode.CodeActionProvider, vscode.DocumentSymbolProvider, vscode.WorkspaceSymbolProvider {

	files: { [fileName: string]: LocationFile };
	entries: { [name: string]: ConfigLocation };
	staticConf: ConfigOverride[];
	diags: vscode.DiagnosticCollection;
	actions: { [uri: string]: vscode.CodeAction[] };
	operatorCompletions: vscode.CompletionItem[];
	menus: ConfigMenu[];

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
			new vscode.CompletionItem('depends on', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('visible if', vscode.CompletionItemKind.Keyword),
			new vscode.CompletionItem('default', vscode.CompletionItemKind.Keyword),
		];

		var range = new vscode.CompletionItem('range', vscode.CompletionItemKind.Keyword);
		range.insertText = new vscode.SnippetString('range ');
		range.insertText.appendPlaceholder('min');
		range.insertText.appendText(' ');
		range.insertText.appendPlaceholder('max');
		this.operatorCompletions.push(range);
		this.operatorCompletions.forEach(c => c.commitCharacters = [' ']);

		this.menus = [];
		this.actions = {};
		this.staticConf = [];

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

	doScan(): Promise<string> {
		var hrTime = process.hrtime();
		var start = (hrTime[0] * 1000 + hrTime[1] / 1000000);
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

	scanText(uri: vscode.Uri,
		text: string,
		reparse: boolean = true,
		recursive?: boolean,
		env: Environment = {},
		dependencies: string[] = [],
		menu: ConfigMenu[] = []) {
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

			/* If lines end with \, the line ending should be ignored: */
			while (line.endsWith('\\') && lineNumber < lines.length - 1) {
				line = line.slice(0, line.length - 1) + envReplace(lines[++lineNumber], env);
			}

			if (help) {
				var indent = line.match(/^\s*/)![0];
				if (helpIndent === null) {
					helpIndent = indent;
				}
				if (indent.startsWith(helpIndent)) {
					if (entry) {
						entry.help += ' ' + line.trim();
						entry.includeLineInLoc(uri, lineNumber, line);
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

			var location;
			var name: string;
			var match = line.match(/^(\s*(?<kind>menuconfig|config)\s+)(?<name>[\d\w_]+)/);
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
					entry.menu = Object.assign([], menu);
				}

				entry.dependencies = entry.dependencies.concat(dependencies.filter(d => !(entry!.dependencies.includes(d))));
				menu.forEach(m => {
					entry!.dependencies = entry!.dependencies.concat(m.dependencies);
				});

				if (choice) {
					var dflt = choice.defaults.find(d => d.value === name);
					if (dflt) {
						entry.defaults.push({ value: 'y', condition: dflt.condition });
					}
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
			match = line.match(/^(\s*(source|rsource|osource)\s+)"((?:.*?[^\\])?)"/);
			if (match) {
				var includeFile = resolvePath(match[3], match[2] === 'rsource' ? path.dirname(uri.fsPath) : undefined);
				if (includeFile) {
					if (recursive) {
						var matches = glob.sync(includeFile);
						var range = new vscode.Range(new vscode.Position(lineNumber, match![1].length + 1),
														new vscode.Position(lineNumber, match![0].length - 1));
						matches.forEach(match => {
							this.scanFile(match, true, recursive, Object.assign({}, env), dependencies, menu); // assign clones the object
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
				var dep = match[1].trim().replace(/\s+/g, ' ');
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
			match = line.match(/^\s*endmenu/);
			if (match) {
				menu.pop();
				continue;
			}
			match = line.match(/^\s*mainmenu\s+"((?:.*?[^\\])?)"/);
			if (match) {
				entry = null;
				var mainmenu: ConfigMenu = {
					prompt: match[1],
					dependencies: [],
					location: new vscode.Location(uri, new vscode.Position(lineNumber, 0)),
					parents: [],
				};

				menu.push(mainmenu);
				this.menus.push(mainmenu);
				continue;
			}
			match = line.match(/^\s*menu\s+"((?:.*?[^\\])?)"/);
			if (match) {
				entry = null;
				var m: ConfigMenu = {
					prompt: match[1],
					dependencies: [],
					location: new vscode.Location(uri, new vscode.Position(lineNumber, 0)),
					parents: Object.assign([], menu),
				};

				menu.push(m);
				this.menus.push(m);
				continue;
			}
			match = line.match(/^\s*endchoice\b/);
			if (match) {
				choice = null;
				continue;
			}
			match = line.match(/^\s*depends\s+on\s+([^#]+)/);
			if (match) {
				var depOn = match[1].trim().replace(/\s+/g, ' ');
				if (entry) {
					entry.includeLineInLoc(uri, lineNumber, match[0]);

					if (!dependencies.includes(depOn)) {
						entry.dependencies.push(depOn);
					}
				} else if (menu.length > 0) {
					menu[menu.length - 1].dependencies.push(depOn);
				}
				continue;
			}

			match = line.match(/^\s*([\w\d_\-]+)\s*=\s*([\w\d_\-]+)$/);
			if (match) {
				env[match[1]] = match[2];
				continue;
			}

			if (!entry) {
				continue;
			}

			entry.includeLineInLoc(uri, lineNumber, line);

			match = line.match(/(bool|tristate|string|hex|int)(?:\s+"((?:.*?[^\\])?)")?/);
			if (match) {
				entry.type = match[1] as ConfigValueType;
				entry.text = match[2];
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

	scanDoc(doc: vscode.TextDocument, reparse: boolean=true, recursive?: boolean, env?: {[variable: string]: string}) {
		if (doc && doc.uri && doc.uri.scheme === 'file') {
			if (doc.languageId === 'kconfig') {
				this.scanText(doc.uri, doc.getText(), reparse, recursive, env);
			} else if (doc.languageId === 'properties') {
				this.servePropertiesDiag(doc);
			}
		}
	}

	scanFile(fileName?: string,
		reparse: boolean = true,
		recursive?: boolean,
		env?: { [variable: string]: string },
		dependencies: string[] = [],
		menu: ConfigMenu[] = []) {
		if (!fileName) {
			return;
		}

		var buf = fs.readFileSync(fileName, {encoding: 'utf-8', flag: 'r'});
		if (!buf) {
			return;
		}

		this.scanText(vscode.Uri.file(fileName), buf.toString(), reparse, recursive, env, dependencies, menu);
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
		var match = line.match(/^\s*CONFIG_([^\s=]+)\s*(?:=\s*(".*?[^\\]"|""|[ynm]\b|0x[a-fA-F\d]+\b|\d+\b))?/);
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
		var actions: vscode.CodeAction[] = [];

		var addRedundancyAction = (c: ConfigOverride, diag: vscode.Diagnostic) => {
			var action = new vscode.CodeAction(`Remove redundant entry CONFIG_${c.config.name}`, vscode.CodeActionKind.Refactor);
			action.edit = new vscode.WorkspaceEdit();
			action.edit.delete(doc.uri, new vscode.Range(c.line!, 0, c.line! + 1, 0));
			action.diagnostics = [diag];
			action.isPreferred = true;
			actions.push(action);
		};

		// Post processing, now that all values are known:
		configurations.forEach((c, i) => {
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
				diags.push(diag);
				addRedundancyAction(c, diag);

				// Find all selectors:
				var selectors = all.filter(e => e.selects.find(s => s.name === c.config.name && (!s.condition || resolveExpression(s.condition, all, configurations))));
				actions.push(...selectors.map(s => {
					var action = new vscode.CodeAction(`Replace with CONFIG_${s.name}`, vscode.CodeActionKind.QuickFix);
					action.edit = new vscode.WorkspaceEdit();
					action.edit.replace(doc.uri, line, `CONFIG_${s.name}=y`);
					action.diagnostics = [diag];
					return action;
				}));
			}

			if (c.config.type && ['int', 'hex'].includes(c.config.type)) {

				var range = c.config.getRange(all, configurations);
				if ((range.min !== undefined && override < range.min) || (range.max !== undefined && override > range.max)) {
					diags.push(new vscode.Diagnostic(line,
						`Entry ${c.value} outside range \`${range.min}\`-\`${range.max}\``,
						vscode.DiagnosticSeverity.Error));
				}
			}

			// tslint:disable-next-line: triple-equals
			if (override == c.config.defaultValue(all, configurations)) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is redundant (same as default)`,
					vscode.DiagnosticSeverity.Hint);
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				diags.push(diag);

				addRedundancyAction(c, diag);
			}

			var missingDependency = c.config.missingDependency(all, configurations);
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
					.map(t => this.getEntry(t.value))
					.filter(e => (e && e.text && e.type && ['bool', 'tristate'].includes(e.type)));

				/* Unless the expression is too complex, try all combinations to find one that works: */
				if (variables.length > 0 && variables.length < 4) {
					for (var code = 0; code < (1 << variables.length); code++) {
						var overrides: ConfigOverride[] = variables.map((v, i) => { return { config: v!, value: (code & (1 << i)) ? 'y' : 'n' }; });
						if (resolveExpression(missingDependency, all, overrides.concat(configurations))) {
							var newEntries: ConfigOverride[] = [];
							var existingEntries: ConfigOverride[] = [];
							overrides.forEach(o => {
								var dup = configurations.find(c => o.config.name === c.config.name);
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
							actions.push(action);
							break;
						}
					}
				}
				diags.push(diag);
				return;
			}

			var selector = c.config.selector(all, configurations.filter((_, index) => index !== i));
			if (selector) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is ${c.value === 'n' ? 'ignored' : 'redundant'} (Already selected by ${(selector instanceof ConfigLocation) ? selector.name : selector.config.name})`,
					c.value === 'n' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint);
				if (selector instanceof ConfigLocation) {
					diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(selector.locations[0], `Selected by ${selector.name}`)];
				} else if (selector.line !== undefined) {
					diag.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(doc.uri, new vscode.Position(selector.line, 0)), `Selected by CONFIG_${selector.config.name}=${selector.value}`)];
				}
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				diags.push(diag);
				addRedundancyAction(c, diag);
				return;
			}

			var actualValue = c.config.evaluate(all, configurations);
			if (override !== actualValue) {
				diags.push(new vscode.Diagnostic(line,
					`Entry ${c.config.name} assigned value ${c.value}, but evaluated to ${c.config.toValueString(actualValue)}`,
					vscode.DiagnosticSeverity.Warning));
				return;
			}
		});

		this.diags.set(doc.uri, diags);
		this.actions[doc.uri.fsPath] = actions;
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
			return (entry.locations.length === 1) ?
				entry.locations :
				entry.locations.filter(l => l.uri.fsPath !== document.uri.fsPath || !l.range.contains(position));
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

		var wordBase = document.getText(document.getWordRangeAtPosition(position)).slice(0, position.character).replace(/^CONFIG_/, '');

		var isProperties = (document.languageId === 'properties');
		var items: vscode.CompletionItem[];
		if ((document.languageId === 'kconfig' && line.text.match(/(visible if|depends on|select|default|def_bool|def_tristate)/)) || isProperties) {
			var entries = this.getAll().filter(e => !(isProperties && e.kind === 'choice') && e.name.startsWith(wordBase));
			items = entries.slice(0, 500).map(e => {
				var kinds = {
					'config': vscode.CompletionItemKind.Variable,
					'menuconfig': vscode.CompletionItemKind.Class,
					'choice': vscode.CompletionItemKind.Enum,
				};

				var item = new vscode.CompletionItem(isProperties ? `CONFIG_${e.name}` : e.name, (e.kind ? kinds[e.kind] : vscode.CompletionItemKind.Text));
				item.sortText = e.name;
				item.detail = e.text;
				if (isProperties) {
					var lineRange = new vscode.Range(position.line, 0, position.line, 999999);
					var lineText = document.getText(lineRange);
					var replaceText = lineText.replace(/\s*#.*$/, '');
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

			return { isIncomplete: (entries.length > 500), items: items };
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
		var entries = this.getAll()
			.filter(e => e.kind && e.locations.find(l => l.uri.fsPath === document.uri.fsPath));

		var info: vscode.DocumentSymbol[] = [];

		var menus: { entry: ConfigMenu, symbol: vscode.DocumentSymbol }[] =
			this.menus
				.filter(m => m.location.uri.fsPath === document.uri.fsPath)
				.map(m => {
					return {
						entry: m,
						symbol: new vscode.DocumentSymbol(
							m.prompt,
							'',
							vscode.SymbolKind.Interface,
							m.location.range,
							m.location.range)
					};
				});

		menus.forEach(m => {
			if (m.entry.parents.length > 0) {
				var p = menus.find(menu => m.entry.parents[m.entry.parents.length - 1] === menu.entry);
				if (p) {
					p.symbol.children.push(m.symbol);
					return;
				}
			}

			info.push(m.symbol);
		});

		entries.forEach(e => {
			var symbols = e.locations
				.filter(l => l.uri.fsPath === document.uri.fsPath)
				.map(l => {
					return {
						entry: e,
						symbol: new vscode.DocumentSymbol(
							e.name,
							'',
							e.symbolKind(),
							l.range,
							l.range)
					};
				});

			symbols.forEach(s => {
				var p;
				if (s.entry.menu.length > 0) {
					p = menus.find(menu => s.entry.menu[s.entry.menu.length - 1] === menu.entry);
					if (p) {
						p.symbol.children.push(s.symbol);
						return;
					}
				}

				var m = s.entry.dependencies
					.filter(d => d.match(/^\w+$/))
					.map(d => symbols.find(s => s.entry.kind === 'menuconfig' && s.entry.name === d))
					.filter(s => s !== undefined);

				if (m && m.length > 0) {
					p = m[m.length - 1];
					p!.symbol.children.push(s.symbol);
					return;
				}

				info.push(s.symbol);
			});
		});

		return info;
	}

	provideWorkspaceSymbols(query: string, token: vscode.CancellationToken): vscode.ProviderResult<vscode.SymbolInformation[]> {
		var entries = this.getAll().filter(e => e.kind && e.name.startsWith(query));

		var info: vscode.SymbolInformation[] = [];


		entries.forEach(e => {
			info = info.concat(e.locations.map(l => new vscode.SymbolInformation(
				`CONFIG_${e.name}`,
				e.symbolKind(),
				e.menu.length > 0 ? e.menu[e.menu.length - 1].prompt : '',
				l)));
		});

		return info;
	}

}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	var langHandler = new KconfigLangHandler();

	var status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10000);
	context.subscriptions.push(status);

	status.text = ' $(sync~spin) kconfig';
	var root = resolvePath(getConfig('root'));
	if (root) {
		status.tooltip = `Starting from ${root}`;
	}
	status.show();

	langHandler.doScan().then(result => {
		status.text = `kconfig complete (${result})`;
	}).catch(e => {
		status.text = `$(alert) kconfig failed`;
		status.tooltip = e;
	}).finally(() => {
		setTimeout(() => {
			status.hide();
			status.dispose();
		}, 10000);
	});


	var selector = [{ language: 'kconfig', scheme: 'file' }, { language: 'properties', scheme: 'file' }];

	let disposable = vscode.languages.registerDefinitionProvider(selector, langHandler);
	context.subscriptions.push(disposable);
	disposable = vscode.languages.registerHoverProvider(selector, langHandler);
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
	// disposable = vscode.languages.registerReferenceProvider({ language: 'kconfig', scheme: 'file' }, langHandler);
	// context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {}
