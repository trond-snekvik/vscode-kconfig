import * as vscode from 'vscode';
import * as path from 'path';
import * as glob from "glob";
import { Repository, Scope, Config, ConfigValueType, ConfigEntry, ConfigKind, IfScope, MenuScope, ChoiceScope } from "./kconfig";
import * as kEnv from './env';
import { createExpression } from './evaluate';

type FileInclusion = {range: vscode.Range, file: ParsedFile};

export class ParsedFile {
	// Some properties are immutable, and are part of the file's identification:
	readonly uri: vscode.Uri;
	readonly repo: Repository;
	readonly parent?: ParsedFile;
	readonly env: {[name: string]: string};
	readonly scope?: Scope;

	version: number;
	inclusions: FileInclusion[];
	entries: ConfigEntry[];
	diags: vscode.Diagnostic[];

	constructor(repo: Repository, uri: vscode.Uri, env: {[name: string]: string}, scope?: Scope, parent?: ParsedFile) {
		this.repo = repo;
		this.uri = uri;
		this.env = { ...env };
		this.scope = scope;
		this.parent = parent;

		this.inclusions = [];
		this.entries = [];
		this.diags = [];
		this.version = 0;
	}

	match(other: ParsedFile) : boolean {
		var myEnvKeys = Object.keys(this.env);
		return (Object.keys(other.env).length === myEnvKeys.length) &&
			myEnvKeys.every(key => key in other.env && (other.env[key] === this.env[key])) &&
			((this.scope === other.scope) || (!!this.scope && !!other.scope?.match(this.scope))) &&
	 		((this.parent === other.parent) || (!!this.parent && !!other.parent?.match(this.parent)));
	}

	get links(): vscode.DocumentLink[] {
		return this.inclusions.map(i => new vscode.DocumentLink(i.range, i.file.uri));
	}

	onDidChange(change: vscode.TextDocumentChangeEvent) {
		if (change.document.version === this.version) {
			console.log(`Duplicate version of ${change.document.fileName}`);
			return;
		}
		this.version = change.document.version;
		var firstDirtyLine = Math.min(...change.contentChanges.map(c => c.range.start.line));

		var oldInclusions = this.inclusions;

		this.wipeEntries();

		this.parseRaw(change.document.getText());

		this.inclusions.forEach(i => {
			var existingIndex: number;
			if (i.range.end.line < firstDirtyLine) { // Optimization, matching is a bit expensive
				existingIndex = oldInclusions.findIndex(ii => ii.range.start.line === i.range.start.line);
			} else {
				existingIndex = oldInclusions.findIndex(ii => ii.file.match(i.file));
			}

			var existingInclusion: FileInclusion | undefined;

			if (existingIndex > -1) {
				existingInclusion = oldInclusions.splice(existingIndex, 1)[0];
			}

			if (existingInclusion) {
				i.file = existingInclusion.file;
			} else {
				i.file.parse();
			}
		});

		// the remaining old inclusions have been removed from the new version of the document, recursively wipe that tree:
		oldInclusions.forEach(i => i.file.delete());
	}

	wipeEntries() {
		this.entries.forEach(e => {
			e.config.removeEntry(e);
			e.config.entries = e.config.entries.filter(entry => entry !== e); // TODO: Could be optimized by creating a list of affected configurations?
		});
		this.entries = [];
	}

	delete() {
		this.wipeEntries();

		this.inclusions.forEach(i => i.file.delete());
	}

	reset() {
		this.diags = [];
		this.inclusions = [];
	}

	children(): ParsedFile[] {
		var files: ParsedFile[] = [];

		this.inclusions.forEach(i => {
			files.push(i.file);
			files.push(...i.file.children());
		});

		return files;
	}

	parse(recursive=true) {
		this.parseRaw(kEnv.readFile(this.uri));

		if (recursive) {
			this.inclusions.forEach(i => i.file.parse(recursive));
		}
	}

	private parseRaw(text: string) {
		this.reset();
		var choice: ConfigEntry | null = null;
		var env = {...this.env};
		var scope = this.scope;

		var lines = text.split(/\r?\n/g);
		if (!lines) {
			return;
		}

		const configMatch    = /^\s*(menuconfig|config)\s+([\d\w_]+)/;
		const sourceMatch    = /^\s*(source|rsource|osource)\s+"((?:.*?[^\\])?)"/;
		const choiceMatch    = /^\s*choice(?:\s+([\d\w_]+))?/;
		const endChoiceMatch = /^\s*endchoice\b/;
		const ifMatch        = /^\s*if\s+([^#]+)/;
		const endifMatch     = /^\s*endif\b/;
		const menuMatch      = /^\s*((?:main)?menu)\s+"((?:.*?[^\\])?)"/;
		const endMenuMatch   = /^\s*endmenu\b/;
		const depOnMatch     = /^\s*depends\s+on\s+([^#]+)/;
		const envMatch       = /^\s*([\w\d_\-]+)\s*=\s*([^#]+)/;
		const typeMatch      = /^\s*(bool|tristate|string|hex|int)(?:\s+"((?:.*?[^\\])?)")?/;
		const selectMatch    = /^\s*(?:select|imply)\s+([\w\d_]+)(?:\s+if\s+([^#]+))?/;
		const promptMatch    = /^\s*prompt\s+"((?:.*?[^\\])?)"/;
		const helpMatch      = /^\s*help\b/;
		const defaultMatch   = /^\s*default\s+([^#]+)/;
		const defMatch       = /^\s*def_(bool|tristate|int|hex)\s+([^#]+)/;
		const defStringMatch = /^\s*def_string\s+"((?:.*?[^\\])?)"(?:\s+if\s+([^#]+))?/;
		const rangeMatch     = /^\s*range\s+([\-+]?[\w\d_]+)\s+([\-+]?[\w\d_]+)(?:\s+if\s+([^#]+))?/;

		var entry: ConfigEntry | null = null;
		var help = false;
		var helpIndent: string | null = null;
		for (var lineNumber = 0; lineNumber < lines.length; lineNumber++) {
			var line = kEnv.replace(lines[lineNumber], env);

			var startLineNumber = lineNumber;

			/* If lines end with \, the line ending should be ignored: */
			while (line.endsWith('\\') && lineNumber < lines.length - 1) {
				line = line.slice(0, line.length - 1) + kEnv.replace(lines[++lineNumber], env);
			}

			if (line.length === 0) {
				continue;
			}

			if (line.match(/^\s*#/)) {
				continue;
			}

			var lineRange = new vscode.Range(startLineNumber, 0, lineNumber, line.length);

			if (help) {
				var indent = line.replace(/\t/g, ' '.repeat(8)).match(/^\s*/)![0];
				if (helpIndent === null) {
					helpIndent = indent;
				}
				if (indent.startsWith(helpIndent)) {
					if (entry) {
						entry.help += ' ' + line.trim();
						entry.extend(lineNumber);
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

			var name: string;
			var match = line.match(configMatch);
			var c: Config;
			if (match) {
				name = match[2];
				if (name in this.repo.configs) {
					c = this.repo.configs[name];
				} else {
					c = new Config(name, match[1] as ConfigKind, this.repo);
					this.repo.configs[name] = c;
				}

				entry = new ConfigEntry(c, lineNumber, this, scope);

				this.entries.push(entry);

				if (choice) {
					var dflt = choice.defaults.find(d => d.value === name);
					if (dflt) {
						entry.defaults.push({ value: 'y', condition: dflt.condition });
					}
				}
				continue;
			}
			match = line.match(sourceMatch);
			if (match) {
				var includeFile = kEnv.resolvePath(match[2], match[1] === 'rsource' ? path.dirname(this.uri.fsPath) : undefined);
				if (includeFile) {
					var range = new vscode.Range(
						new vscode.Position(lineNumber, match[1].length + 1),
						new vscode.Position(lineNumber, match[0].length - 1));
					if (includeFile.scheme === 'file') {
						var matches = glob.sync(includeFile.fsPath);
						matches.forEach(match => {
							this.inclusions.push({range: range, file: new ParsedFile(this.repo, vscode.Uri.file(match), env, scope, this)});
						});
					} else {
						this.inclusions.push({range: range, file: new ParsedFile(this.repo, includeFile, env, scope, this)});
					}
				}
				continue;
			}
			match = line.match(choiceMatch);
			if (match) {
				name = match[1] || `<choice @ ${vscode.workspace.asRelativePath(this.uri.fsPath)}:${lineNumber}>`;
				entry = new ConfigEntry(new Config(name, 'choice', this.repo), lineNumber, this, scope);
				scope = new ChoiceScope(entry);
				choice = entry;
				continue;
			}
			match = line.match(endChoiceMatch);
			if (match) {
				entry = null;
				choice = null;
				if (scope instanceof ChoiceScope) {
					scope.lines.end = lineNumber;
					scope = scope.parent;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected endchoice`, vscode.DiagnosticSeverity.Error));
				}
				continue;
			}
			match = line.match(ifMatch);
			if (match) {
				entry = null;
				scope = new IfScope(match[1], lineNumber, this, scope);
				continue;
			}
			match = line.match(endifMatch);
			if (match) {
				entry = null;
				if (scope instanceof IfScope) {
					scope.lines.end = lineNumber;
					scope = scope.parent;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected endif`, vscode.DiagnosticSeverity.Error));
				}
				continue;
			}
			match = line.match(menuMatch);
			if (match) {
				entry = null;
				scope = new MenuScope(match[2], lineNumber, this, scope);
				continue;
			}
			match = line.match(endMenuMatch);
			if (match) {
				entry = null;
				if (scope instanceof MenuScope) {
					scope.lines.end = lineNumber;
					scope = scope?.parent;
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected endmenu`, vscode.DiagnosticSeverity.Error));
				}
				continue;
			}
			match = line.match(depOnMatch);
			if (match) {
				var depOn = match[1].trim().replace(/\s+/g, ' ');
				if (entry) {
					entry.extend(lineNumber);

					if (entry.dependencies.includes(depOn)) {
						this.diags.push(new vscode.Diagnostic(lineRange, `Duplicate dependency`, vscode.DiagnosticSeverity.Warning));
					}
					entry.dependencies.push(depOn); // need to push the duplicate, in case someone changes the other location to remove the duplication
				} else if (scope instanceof MenuScope) {
					scope.dependencies.push(depOn);
				} else {
					this.diags.push(new vscode.Diagnostic(lineRange, `Unexpected depends on`, vscode.DiagnosticSeverity.Error));
				}
				continue;
			}

			match = line.match(envMatch);
			if (match) {
				env[match[1]] = match[2];
				continue;
			}

			var noEntryDiag = new vscode.Diagnostic(lineRange, `Token is only valid in an entry context`, vscode.DiagnosticSeverity.Warning);

			match = line.match(typeMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.type = match[1] as ConfigValueType;
				entry.text = match[2];
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(selectMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.selects.push({name: match[1], condition: createExpression(match[2])});
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(promptMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.text = match[1];
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(helpMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				help = true;
				helpIndent = null;
				entry.help = '';
				entry.extend(lineNumber);
				continue;
			}

			var ifStatement;
			match = line.match(defaultMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				ifStatement = match[1].match(/(.*)if\s+([^#]+)/);
				if (ifStatement) {
					entry.defaults.push({ value: ifStatement[1], condition: createExpression(ifStatement[2]) });
				} else {
					entry.defaults.push({ value: match[1] });
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(defMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.type = match[1] as ConfigValueType;
				ifStatement = match[2].match(/(.*)if\s+([^#]+)/);
				if (ifStatement) {
					entry.defaults.push({ value: ifStatement[1], condition: createExpression(ifStatement[2]) });
				} else {
					entry.defaults.push({ value: match[2] });
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(defStringMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.type = 'string';
				ifStatement = match[1].match(/(.*)if\s+([^#]+)/);
				if (ifStatement) {
					entry.defaults.push({ value: ifStatement[1], condition: createExpression(ifStatement[2]) });
				} else {
					entry.defaults.push({ value: match[1] });
				}
				entry.extend(lineNumber);
				continue;
			}
			match = line.match(rangeMatch);
			if (match) {
				if (!entry) {
					this.diags.push(noEntryDiag);
					continue;
				}
				entry.ranges.push({
					min: match[1],
					max: match[2],
					condition: createExpression(match[3]),
				});
				entry.extend(lineNumber);
				continue;
			}

			if (line.match(/^\s*comment\s+".*"/)) {
				continue;
			}

			if (line.match(/^\s*optional/)) {
				continue;
			}

			this.diags.push(new vscode.Diagnostic(lineRange, `Invalid token`, vscode.DiagnosticSeverity.Error));
		}
	}
}
