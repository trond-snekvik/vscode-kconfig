import * as vscode from 'vscode';
import { Config, ConfigOverride, Repository, EvalContext } from "./kconfig";
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
	private version: number;

	constructor(uri: vscode.Uri, repo: Repository, baseConf: ConfigOverride[], diags: vscode.DiagnosticCollection) {
		this.uri = uri;
		this.repo = repo;
		this.baseConf = baseConf;
		this.diags = diags;
		this.version = 0;
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

		var value: string;
		var stringMatch = match[2].match(/^"(.*)"$/);
		if (stringMatch) {
			value = stringMatch[1];
		} else {
			value = match[2];
		}

		return { config: entry, value: value, line: lineNumber };
	}

	updateDiags() {
		this.diags.set(this.uri, [...this.parseDiags, ...this.lintDiags]);
	}

	parse(text: string) {
		this.parseDiags = [];
		this.conf = [];
		this.version++;
		console.log("Parsing...");

		var lines = text.split(/\r?\n/g);

		this.conf = lines.map((l, i) => this.parseLine(l, i)).filter(c => c !== undefined) as ConfigOverride[];
		this.updateDiags();
		console.log("Parsing done.");
	}

	reparse(d: vscode.TextDocument) {
		this.parse(d.getText());
		this.scheduleLint();
	}

	// Utility for desynchronizing context in lint
	private skipTick() {
		// Can't use await Promise.resolve(), for some reason.
		// Probably some vscode runtime is changing the behavior of this...
		return new Promise(resolve => setImmediate(() => resolve()));
	}

	async lint() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}

		console.log("lint starting");
		await this.skipTick();

		var ctx = new EvalContext(this.repo, this.overrides);

		var diags = <vscode.Diagnostic[]>[];

		var actions = <vscode.CodeAction[]>[];

		var all = Object.values(this.repo.configs);

		var addRedundancyAction = (c: ConfigOverride, diag: vscode.Diagnostic) => {
			var action = new vscode.CodeAction(`Remove redundant entry CONFIG_${c.config.name}`, vscode.CodeActionKind.Refactor);
			action.edit = new vscode.WorkspaceEdit();
			action.edit.delete(this.uri, new vscode.Range(c.line!, 0, c.line! + 1, 0));
			action.diagnostics = [diag];
			action.isPreferred = true;
			actions.push(action);
		};

		var version = this.version;

		for (var i = 0; i < this.conf.length; i++) {
			await this.skipTick();
			if (version !== this.version) {
				console.log("Abandoning lint");
				return;
			}

			var c = this.conf[i];

			var override = c.config.resolveValueString(c.value);
			var line = new vscode.Range(c.line!, 0, c.line!, 99999999);
			var diag: vscode.Diagnostic;
			var action: vscode.CodeAction;

			if (!c.config.text) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} has no effect (has no prompt)`,
					vscode.DiagnosticSeverity.Warning);
				diags.push(diag);
				addRedundancyAction(c, diag);

				// Find all selectors:
				var selectors = all.filter(e => e.selects(ctx, c.config.name));
				actions.push(...selectors.map(s => {
					var action = new vscode.CodeAction(`Replace with CONFIG_${s.name}`, vscode.CodeActionKind.QuickFix);
					action.edit = new vscode.WorkspaceEdit();
					action.edit.replace(this.uri, line, `CONFIG_${s.name}=y`);
					action.diagnostics = [diag];
					return action;
				}));
			}

			if (c.config.type && ['int', 'hex'].includes(c.config.type)) {
				var range = c.config.getRange(ctx);
				if ((range.min !== undefined && override < range.min) || (range.max !== undefined && override > range.max)) {
					diags.push(new vscode.Diagnostic(line,
						`Entry ${c.value} outside range \`${range.min}\`-\`${range.max}\``,
						vscode.DiagnosticSeverity.Error));
				}
			}

			// tslint:disable-next-line: triple-equals
			if (override == c.config.defaultValue(ctx)) {
				diag = new vscode.Diagnostic(line,
					`Entry ${c.config.name} is redundant (same as default)`,
					vscode.DiagnosticSeverity.Hint);
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				diags.push(diag);

				addRedundancyAction(c, diag);
			}

			var missingDependency = c.config.missingDependency(ctx);
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

				var dep = ctx.repo.configs[missingDependency];
				if (dep) {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(dep.entries[0].loc, `${missingDependency} declared here`)
					];
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
						if (resolveExpression(missingDependency, new EvalContext(this.repo, overrides.concat(this.overrides)))) {
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
							actions.push(action);
							break;
						}
					}
				}
				diags.push(diag);
				continue;
			}

			var selector = c.config.selector(ctx);
			if (selector) {
				diag = new vscode.Diagnostic(
					line,
					`Entry ${c.config.name} is ${c.value === "n" ? "ignored" : "redundant"} (Already selected by ${selector.name})`,
					c.value === "n" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint
				);

				var o = ctx.overrides.find(o => o.config.name === selector!.name);
				if (o && o.line !== undefined) {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(
							new vscode.Location(this.uri, new vscode.Position(o.line, 0)),
							`Selected by CONFIG_${o.config.name}=${o.value}`
						)
					];
				} else {
					diag.relatedInformation = [
						new vscode.DiagnosticRelatedInformation(selector.entries[0].loc, `Selected by ${selector.name}`)
					];
				}
				diag.tags = [vscode.DiagnosticTag.Unnecessary];
				diags.push(diag);
				addRedundancyAction(c, diag);
				continue;
			}

			var actualValue = c.config.evaluate(ctx);
			if (override !== actualValue) {
				diags.push(new vscode.Diagnostic(line,
					`Entry ${c.config.name} assigned value ${c.value}, but evaluated to ${c.config.toValueString(actualValue)}`,
					vscode.DiagnosticSeverity.Warning));
				continue;
			}
		}

		console.log("Lint done.");
		this.lintDiags = diags;
		this.actions = actions;
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
		this.lint();
	}

	onOpen(d: vscode.TextDocument) {
		this.reparse(d);
	}
}
