import * as vscode from 'vscode';
import { Config, ConfigOverride, Repository } from "./kconfig";
import { tokenizeExpression, TokenKind, resolveExpression } from './evaluate';

export class PropFile {
	actions: vscode.CodeAction[] = [];
	conf: ConfigOverride[] = [];
	baseConf: ConfigOverride[];
	repo: Repository;
	uri: vscode.Uri;
	private diags: vscode.DiagnosticCollection;
	private timeout?: NodeJS.Timeout;
	private parseDiags: vscode.Diagnostic[] = [];
	private lintDiags: vscode.Diagnostic[] = [];

	constructor(uri: vscode.Uri, repo: Repository, baseConf: ConfigOverride[], diags: vscode.DiagnosticCollection) {
		this.uri = uri;
		this.repo = repo;
		this.baseConf = baseConf;
		this.diags = diags;
	}


	get overrides(): ConfigOverride[] {
		return this.conf.concat(this.baseConf);
	}

	parseLine(line: string, lineNumber: number): ConfigOverride | undefined {
		var thisLine = new vscode.Position(lineNumber, 0);
		var match = line.match(/^\s*CONFIG_([^\s=]+)\s*(?:=\s*(".*?[^\\]"|""|[ynm]\b|0x[a-fA-F\d]+\b|\d+\b))?/);
		if (!match) {
			if (!line.match(/^\s*(#|$)/)) {
				this.parseDiags.push(
					new vscode.Diagnostic(
						new vscode.Range(thisLine, thisLine),
						"Syntax error: All lines must either be comments or config entries with values.",
						vscode.DiagnosticSeverity.Error
					)
				);
			}
			return undefined;
		}

		if (!match[2]) {
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine, thisLine),
					"Missing value for config " + match[1],
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}

		var entry = this.repo.configs[match[1]];
		if (!entry) {
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine, thisLine),
					"Unknown entry " + match[1],
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}

		if (!entry.isValidOverride(match[2])) {
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine, thisLine),
					`Invalid value. Entry ${match[1]} is ${entry.type}.`,
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}


		var trailing = line.slice(match[0].length).match(/^\s*([^#\s]+[^#]*)/);
		if (trailing) {
			var start = match[0].length + trailing[0].indexOf(trailing[1]);
			this.parseDiags.push(
				new vscode.Diagnostic(
					new vscode.Range(thisLine.line, start, thisLine.line, start + trailing[1].trimRight().length),
					"Unexpected trailing characters",
					vscode.DiagnosticSeverity.Error
				)
			);
			return undefined;
		}

		return { config: entry, value: match[2], line: lineNumber };
	}

	private updateDiags() {
		this.diags.set(this.uri, this.parseDiags.concat(this.lintDiags));
	}

	parse(text: string) {
		this.parseDiags = [];
		this.conf = [];

		var lines = text.split(/\r?\n/g);

		this.conf = lines.map((l, i) => this.parseLine(l, i)).filter(c => c !== undefined) as ConfigOverride[];
		this.updateDiags();
	}

	reparse(d: vscode.TextDocument) {
		this.parse(d.getText());
		this.lint();
	}

	lint() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}

		this.lintDiags = [];
		this.actions = [];

		var all = Object.values(this.repo.configs);

		var addRedundancyAction = (c: ConfigOverride, diag: vscode.Diagnostic) => {
			var action = new vscode.CodeAction(`Remove redundant entry CONFIG_${c.config.name}`, vscode.CodeActionKind.Refactor);
			action.edit = new vscode.WorkspaceEdit();
			action.edit.delete(this.uri, new vscode.Range(c.line!, 0, c.line! + 1, 0));
			action.diagnostics = [diag];
			action.isPreferred = true;
			this.actions.push(action);
		};

		this.conf.forEach((c, i) => {
			var override = c.config.resolveValueString(c.value);
			var line = new vscode.Range(c.line!, 0, c.line!, 99999999);
			var diag: vscode.Diagnostic;
			var action: vscode.CodeAction;

			if (!c.config.text) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} has no effect (has no prompt)`,
					vscode.DiagnosticSeverity.Warning);
				this.lintDiags.push(diag);
				addRedundancyAction(c, diag);

				// Find all selectors:
				var selectors = all.filter(e => e.selects.find(s => s.name === c.config.name && (!s.condition || s.condition.solve(all, this.overrides))));
				this.actions.push(...selectors.map(s => {
					var action = new vscode.CodeAction(`Replace with CONFIG_${s.name}`, vscode.CodeActionKind.QuickFix);
					action.edit = new vscode.WorkspaceEdit();
					action.edit.replace(this.uri, line, `CONFIG_${s.name}=y`);
					action.diagnostics = [diag];
					return action;
				}));
			}

			if (c.config.type && ['int', 'hex'].includes(c.config.type)) {
				var range = c.config.getRange(all, this.overrides);
				if ((range.min !== undefined && override < range.min) || (range.max !== undefined && override > range.max)) {
					this.lintDiags.push(new vscode.Diagnostic(line,
						`Entry ${c.value} outside range \`${range.min}\`-\`${range.max}\``,
						vscode.DiagnosticSeverity.Error));
				}
			}

			// tslint:disable-next-line: triple-equals
			if (override == c.config.defaultValue(all, this.overrides)) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is redundant (same as default)`,
					vscode.DiagnosticSeverity.Hint);
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				this.lintDiags.push(diag);

				addRedundancyAction(c, diag);
			}

			var missingDependency = c.config.missingDependency(all, this.overrides);
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
						if (resolveExpression(missingDependency, all, overrides.concat(this.overrides))) {
							var newEntries: ConfigOverride[] = [];
							var existingEntries: ConfigOverride[] = [];
							overrides.forEach(o => {
								var dup = this.conf.find(c => o.config.name === c.config.name);
								if (dup) {
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
								action.edit.insert(this.uri,
									new vscode.Position(c.line!, 0),
									newEntries.map(c => `CONFIG_${c.config.name}=${c.value}\n`).join(''));
							}
							if (existingEntries.length) {
								existingEntries.forEach(e => {
									action.edit!.replace(this.uri,
										new vscode.Range(e.line!, 0, e.line!, 999999),
										`CONFIG_${e.config.name}=${e.value}`);
								});
							}
							action.isPreferred = true;
							action.diagnostics = [diag];
							this.actions.push(action);
							break;
						}
					}
				}
				this.lintDiags.push(diag);
				return;
			}

			var selector = c.config.selector(all, this.overrides.filter((_, index) => index !== i));
			if (selector) {
				diag = new vscode.Diagnostic(
					line,
					`Entry ${c.config.name} is ${c.value === "n" ? "ignored" : "redundant"} (Already selected by ${
						selector instanceof Config ? selector.name : selector.config.name
					})`,
					c.value === "n" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint
				);
				if (selector instanceof Config) {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(selector.entries[0].loc, `Selected by ${selector.name}`)
					];
				} else if (selector.line !== undefined) {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(
							new vscode.Location(this.uri, new vscode.Position(selector.line, 0)),
							`Selected by CONFIG_${selector.config.name}=${selector.value}`
						)
					];
				}
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				this.lintDiags.push(diag);
				addRedundancyAction(c, diag);
				return;
			}

			var actualValue = c.config.evaluate(all, this.overrides);
			if (override !== actualValue) {
				this.lintDiags.push(new vscode.Diagnostic(line,
					`Entry ${c.config.name} assigned value ${c.value}, but evaluated to ${c.config.toValueString(actualValue)}`,
					vscode.DiagnosticSeverity.Warning));
				return;
			}
		});

		this.updateDiags();
	}

	scheduleLint() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}

		this.timeout = setTimeout(() => {
			this.lint();
		}, 100);
	}

	onChange(e: vscode.TextDocumentChangeEvent) {
		var changes: {line: number, change: number}[] = [];
		e.contentChanges.forEach(change => {
			changes.push({
				line: change.range.start.line,
				change: change.range.start.line - change.range.end.line + (change.text.match(/\n/g) ?? []).length
			});
		});

		this.lintDiags.forEach(diag => {
			var diff = changes.reduce((sum, change, _) => (change.line <= diag.range.start.line ? sum + change.change : sum), 0);

			diag.range = new vscode.Range(
				diag.range.start.line + diff,
				diag.range.start.character,
				diag.range.end.line + diff,
				diag.range.end.character
			);
		});
		this.parse(e.document.getText());
		this.scheduleLint();
	}

	onSave(d: vscode.TextDocument) {
		// this.lint();
	}

	onOpen(d: vscode.TextDocument) {
		this.reparse(d);
	}
}
