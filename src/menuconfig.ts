import * as vscode from 'vscode';
import * as fs from 'fs';
import { Repository, EvalContext, Config, ConfigEntry, Scope, MenuScope, Comment, IfScope, EntryTreeItem, ChoiceScope } from './kconfig';

export class Menuconfig {
	ctx: EvalContext;
	expanded: {[id: string]: boolean};
	panel: vscode.WebviewPanel;
	helpText: string;

	constructor(ctx: EvalContext) {
		this.ctx = ctx;
		this.expanded = {};
		this.helpText = '';
		this.panel = vscode.window.createWebviewPanel(
			'menuconfig',
			'menuconfig',
			vscode.ViewColumn.Active,
			{ enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true }
		);

		this.panel.webview.onDidReceiveMessage((e: {command: string, key: string}) => {
			if (e.command === 'button') {
				this.expanded[e.key] = !this.expanded[e.key];
				this.render();
			} else if (e.command === 'help') {
				if (e.key in this.ctx.repo.configs) {
					let c = this.ctx.repo.configs[e.key];
					this.helpText = c.help;
					this.render();
				}
			}
		});
	}

	render() {
		const tree = this.ctx.repo.createTree();

		const renderItem = (i: EntryTreeItem): string => {
			let e = i.entry;
			let title = '';
			let id = '';
			let type = '';
			let control = '';
			if (e instanceof Comment) {
				if (e.visible && !e.visible.solve(this.ctx)) {
					return '';
				}

				type = 'comment';
				id = 'comment-' + e.text.replace(' ', '-');
				title = `<em>${e.text}</em>`;
			} else if (e instanceof ConfigEntry) {
				if (!e.config.text) {
					// no prompt
					return i.children.map(renderItem).join('\n');
				}

				if (e.config.missingDependency(this.ctx)) {
					return '';
				}

				type = 'entry';
				id = e.config.name;
				title = `<span title="CONFIG_${e.config.name}">${e.config.text}</span>`;

				if (e.config.type === 'bool') {
					control = `<input type="checkbox" style="align-self: flex-end" id="${id}" ${e.config.evaluate(this.ctx) ? 'checked' : ''}>`;
				}
			} else {
				if (!e.evaluate(this.ctx)) {
					return '';
				}

				if (e instanceof MenuScope) {
					type = 'menu';
					id = e.id;
					title = e.name ?? 'UNDEFINED!';
				} else if (e instanceof ChoiceScope) {
					if (e.choice.config.missingDependency(this.ctx)) {
						return '';
					}

					let chosen = e.choice.chosen(this.ctx);

					type = 'choice';
					id = e.id;
					title = e.choice.text ?? 'choice';
					if (chosen) {
						title += ` (${chosen.text ?? chosen.name})`;
					}

				} else if (e instanceof IfScope) {
					// Non-collapsed ifs are just rendered without scope
					return i.children.map(renderItem).join('\n');
				}
			}

			title = `<div name="title" id="${id}">${title}</div>${control}`;

			var text = `<div class="${type}"><div class="row">`;
			if (i.children.length) {

				if (this.expanded[id]) {
					text += `<div name="btn" id="${id}">▼</div>${title}`;
					text += `</div><div class="children">${i.children.map(renderItem).join('\n')}`;
				} else {
					text += `<div name="btn" id="${id}">▶</div>${title}`;
				}
			} else {
				text += title;
			}

			return `${text}</div></div>`;
		};

		const script = `<script>
			(function() {
				const vscode = acquireVsCodeApi();
				const counter = document.getElementById('lines-of-code-counter');

				const buttons = document.getElementsByName("btn");
				buttons.forEach(el => {
					el.addEventListener("click", () => {
						vscode.postMessage({
							command: "button",
							key: el.id
						});
					});
				});

				const title = document.getElementsByName("title");
				title.forEach(el => {
					el.addEventListener("mouseenter", () => {
						vscode.postMessage({
							command: "help",
							key: el.id
						});
					});
				});
			}())
		</script>`;

		this.panel.webview.html = `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Menuconfig</title>
			<style>
			body {
				// font-family: var(--vscode-editor-font-family), monospaced;
				display: flex;
				flex-direction: column;
				overflow: hidden;
				justify-content: space-between;
				max-height: -webkit-fill-available;
				min-height: -webkit-fill-available;
			}
			div[name="btn"] {
				// color: var(--vscode-foreground);
				// background: var(--vscode-button-background);
				// padding: 5px;
				height: fit-content;
				margin-right: 10px;
				flex-grow: 0;
			}
			div[name="btn"]:hover {
				background: var(--vscode-button-hoverBackground);
				cursor: pointer;
			}
			.children {
				padding-left: 20px;
			}
			.row {
				margin: 10px;
				padding: 10px;
				color: var(--vscode-sideBar-foreground);
				background: var(--vscode-sideBar-background);
				display: flex;
				align-items: center;
			}
			.menuconfig {
				overflow-y: scroll;
			}
			.menuconfig-contents {
				max-width: 800px;
			}
			.help {
				margin: 10px;
				min-height: 200px;
				max-height: 200px;
				flex-shrink: 0;
				padding: 10px;
				background: var(--vscode-activityBar-background);
			}
			input[type="checkbox"] {
				color: var(--vscode-settings-checkboxForeground);
				background: var(--vscode-settings-checkboxForeground);
				border: var(--vscode-settings-checkboxBorder);
			}
			div[name="title"] {
				flex-grow: 1;
			}
			input {
				height: 17px;
				padding: 6px;
				border: solid 1px;
				font-size: 13px;
				font-family: Menlo, Monaco, Consolas, "Droid Sans Mono", "Courier New",
				monospace, "Droid Sans Fallback";
				color: var(--vscode-settings-textInputForeground);
				background: var(--vscode-settings-textInputBackground);
				border: 1px solid var(--vscode-settings-textInputBorder);
			}
			a:focus,
			input:focus,
			select:focus,
			textarea:focus {
				outline: 1px solid -webkit-focus-ring-color;
				outline-offset: -1px;
			}
			</style>
		</head>
		<body>
			<div class="menuconfig">
				<div class="menuconfig-contents">
					${tree.map(renderItem).join('\n')}
				</div>
			</div>
			<div class="help">
				${this.helpText}
			</div>
			${script}
		</body>
		</html>`;

		fs.writeFileSync('/home/trond/vscode/vscode-kconfig/out.html', this.panel.webview.html);
	}
}