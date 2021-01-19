import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Repository, EvalContext, Config, ConfigEntry, Scope, MenuScope, Comment, IfScope, EntryTreeItem, ChoiceScope } from './kconfig';
import { isMaster } from 'cluster';

var extensionPath: string;
var panel: vscode.WebviewPanel;

function mediaPath(file: string): vscode.Uri {
	return panel.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'media', file)));
}

function toId(...text: string[]) {
	return text.map(t => t.toLowerCase().replace(/[_:. ()]/g, '-')).join('-');
}

type EventHandler<T> = (evt: string, params?: T) => any;

class Component {
	children: Component[];
	tag?: string;
	attributes: {[key: string]: string | boolean};
	text?: string;
	atomic = false;

	private handlers: {[evt: string]: EventHandler<any>};

	constructor(kind: string | undefined='div', text?: string) {
		this.tag = kind;
		this.text = text;
		this.children = [];
		this.attributes = {};
		this.handlers = {};
	}

	fire(evt: string, params?: any) {
		this.handlers[evt]?.(evt, params);
	}

	on(evt: string, cb: EventHandler<any>) {
		this.handlers[evt] = cb;
	}

	find(id: string): Component | null {
		if (this.attributes['id'] === id) {
			return this;
		}

		let found: Component | null = null;
		this.children.find(c => found = c.find(id));
		return found;
	}

	set classes(classes: string[] | string | undefined) {
		if (typeof(classes) === 'string') {
			this.attributes['class'] = classes;
			return;
		}

		if (classes === undefined) {
			delete this.attributes['class'];
			return;
		}

		this.attributes['class'] = classes.join(' ');
	}

	set id(id: string | undefined) {
		if (id) {
			this.attributes['id'] = id;
		} else {
			delete this.attributes['id'];
		}
	}

	get id(): string | undefined {
		return <string>this.attributes['id'];
	}

	get raw(): string {
		if (this.tag) {
			const attrs = Object.entries(this.attributes).map(([key, val]) => {
				if (val === true) {
					return key;
				}
				if (val === false) {
					return '';
				}

				return key + ' = "' + val + '"';
			}).join(' ');

			if (this.atomic && !this.children.length && !this.text) {
				return `<${this.tag} ${attrs}/>`;
			}

			return `<${this.tag} ${attrs}>${this.text ?? ''}${this.children.map(c => c.raw).join('')}</${this.tag}>`;
		}

		return this.text ?? '';
	}
}

class Text extends Component {
	constructor(text:string) {
		super(undefined, text);
	}
}

class Div extends Component {
	constructor(id?: string, classAttr?: string, text?: string) {
		super('div', text);
		this.id = id;
		this.classes = classAttr;
	}
}

class Span extends Component {
	constructor(id?: string, classAttr?: string | undefined, text?: string) {
		super('span', text);
		this.id = id;
		this.classes = classAttr;
	}
}

class Img extends Component {
	constructor(src: string, id?: string) {
		super('img');
		this.atomic = true;

		this.attributes['src'] = mediaPath(src).toString();
		this.id = id;
	}
}

class Codicon extends Component {
	constructor(icon: string, kind='i') {
		super(kind);
		this.classes = ['codicon', `codicon-${icon}`];
	}
}

class Input extends Component {
	constructor(type: 'checkbox' | 'text' | 'number' | 'radio' | 'submit' | 'search', id?: string, classAttr?: string) {
		super('input');
		this.attributes['type'] = type;
		this.classes = classAttr;
		this.id = id;
	}
}

class Textbox extends Input {
	constructor(id: string, placeholder?: string, value?: string) {
		super('text', id);
		if (placeholder) {
			this.attributes['placeholder'] = placeholder;
		}
		if (value) {
			this.attributes['value'] = value;
		}
	}

	on(evt: 'change' | 'submit', cb: EventHandler<string>) { super.on(evt, cb); }
}

class IntegerBox extends Textbox {
	constructor(id: string, placeholder?: string, value?: number) {
		super(id, placeholder, value?.toString());
		this.classes = 'integer';
	}
}

class HexBox extends Textbox {
	constructor(id: string, placeholder?: string, value?: number) {
		super(id, placeholder, value?.toString(16));
		this.classes = 'hex';
	}
}

class Search extends Div {
	constructor() {
		super('search', 'search');
		const box = new Div('search-box');
		box.children.push(new Codicon('search', 'div'));
		const input = new Input('text', 'search-input');
		input.attributes['placeholder'] = 'Search entries';
		box.children.push(input);
		this.children.push(box);
	}
}

class CheckBox extends Component {
	constructor(label: string, id: string, checked=false) {
		super('label');
		const input = new Input('checkbox', toId('checkbox', id));
		input.classes = ['hidden', 'checkbox'];
		input.attributes['checked'] = checked;
		this.children.push(input);
		const checkmark = new Span(undefined, 'checkmark');
		checkmark.children.push(new Codicon('check'));
		this.children.push(checkmark);
		this.children.push(new Text(label || 'lol'));
	}

	on(evt: 'checked', cb: EventHandler<boolean>) { super.on(evt, cb); }
}

class Button extends Div {
	constructor(id?:string, enabled=true, onclick?: string) {
		super(id, 'button' + (enabled ? '' : ' disabled'));
		if (onclick) {
			this.attributes['onclick'] = onclick;
		}
	}
}

class Row extends Div {
	constructor(entry: Config, value?: boolean | string | number) {
		super(toId('row', entry.name), 'row');
		this.attributes['tabindex'] = '0';

		const content = new Div(undefined, 'row-content');
		this.children.push(content);

		const title = new Div(toId('title', entry.name), 'entry-title');
		title.text = entry.text;
		content.children.push(title);

		switch (entry.type) {
			case "bool":
			case "tristate":
				content.children.push(new CheckBox(entry.help || entry.text || entry.name, entry.name, <boolean>value ?? false));
				break;
			case "string":
				content.children.push(new Div(toId('help', entry.name), 'help', entry.help ?? 'yes'));
				content.children.push(new Textbox(toId('val', entry.name), undefined, <string>value));
				break;
			case "int":
				content.children.push(new Div(toId('help', entry.name), 'help', entry.help ?? 'yes'));
				content.children.push(new IntegerBox(toId('val', entry.name), undefined, <number>value));
				break;
			case "hex":
				content.children.push(new Div(toId('help', entry.name), 'help', entry.help ?? 'yes'));
				content.children.push(new HexBox(toId('val', entry.name), undefined, <number>value));
				break;
		}

		if (entry.kind === 'menuconfig') {
			const submenu = new Button(undefined, !!value, `submenu('${this.id}', '${entry.name}')`);
			submenu.children.push(new Codicon('chevron-right'));
			this.children.push(submenu);
		}
	}
}

class MenuRow extends Div {
	constructor(menu: Scope) {
		super(toId('row', menu.name), 'row menu-row');
		this.attributes['tabindex'] = '0';

		const content = new Div(undefined, 'row-content');
		this.children.push(content);

		const title = new Div(toId('title', menu.name), 'menu-title');
		title.text = menu.name;
		content.children.push(title);

		const submenu = new Button(undefined, true, `submenu('${this.id}', '${menu.id}')`);
		submenu.children.push(new Codicon('chevron-right'));
		this.children.push(submenu);
	}
}

class CommentRow extends Div {
	constructor(comment: Comment) {
		super(undefined, 'comment-row');

		const content = new Div(undefined, 'row-content');
		content.children.push(new Div(undefined, 'comment', comment.text));

		this.children.push(content);
	}
}

interface ConfigMenu {
	scroll: number;
	scope: Scope;
};

type Event = (
	{ cmd: 'button', key: string } |
	{ cmd: 'help', key: string } |
	{ cmd: 'setVal', id: string, val: string } |
	{ cmd: 'openMenu', id: string, up: boolean }
);

function entryId(entry: ConfigEntry | Scope | Comment) {
	if (entry instanceof ConfigEntry) {
		return entry.config.name;
	}

	if (entry instanceof Scope) {
		return entry.id;
	}

	if (entry instanceof Comment) {
		return entry.text;
	}
}

function entryName(entry: ConfigEntry | Scope | Comment) {
	if (entry instanceof ConfigEntry) {
		return entry.config.text ?? entry.config.name;
	} else if (entry instanceof Scope) {
		return entry.name;
	} else if (entry instanceof Comment) {
		return entry.text;
	}

	return '';
}

export class Menuconfig implements vscode.CustomTextEditorProvider {
	ctx: EvalContext;
	expanded: {[id: string]: boolean};
	helpText: string;
	extensionContext: vscode.ExtensionContext;
	rows: Row[];
	tree: EntryTreeItem[];
	search: Search;
	currMenu: EntryTreeItem;

	constructor(ctx: EvalContext, extensionContext: vscode.ExtensionContext) {
		this.ctx = ctx;
		this.expanded = {};
		this.helpText = '';
		this.rows = [];
		panel = vscode.window.createWebviewPanel(
			'menuconfig',
			'menuconfig',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				enableFindWidget: true,
				localResourceRoots: [
					vscode.Uri.file(path.join(extensionContext.extensionPath, 'media')),
					vscode.Uri.file(path.join(extensionContext.extensionPath, 'node_modules', 'vscode-codicons', 'dist')),
				],
			}
		);

		this.tree = this.ctx.repo.createTree();
		this.currMenu = this.tree[0];
		this.extensionContext = extensionContext;
		extensionPath = extensionContext.extensionPath;
		this.search = new Search();

		panel.webview.onDidReceiveMessage((e: Event) => this.panelEventHandler(e));
	}

	panelEventHandler(e: Event) {
		switch (e.cmd) {
			case 'help':
				if (e.key in this.ctx.repo.configs) {
					let c = this.ctx.repo.configs[e.key];
					this.helpText = c.help;
				} else {
					this.helpText = '';
				}

				panel.webview.postMessage({ command: 'setHelp', data: this.helpText });
				break;
			case 'openMenu': {
				const item = this.findMenu(e.id);
				if (item) {
					this.setMenu(item, e.up);
				}
				break;
			}
			default:
				console.log(`Error: Unknown command ${e.cmd}`);
		}
	}

	resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel, token: vscode.CancellationToken): void | Thenable<void> {
		panel = webviewPanel;
		panel.webview.onDidReceiveMessage((e: Event) => this.panelEventHandler(e));
		panel.title = 'Menuconfig';
		this.render();
	}

	private findMenu(id: string) {
		const searchInTree = (item: EntryTreeItem): EntryTreeItem | undefined => {
			if (entryId(item.entry) === id) {
				return item;
			}

			let found: EntryTreeItem | undefined;
			item.children.find(c => found = searchInTree(c));
			return found;
		};

		let found: EntryTreeItem | undefined;
		this.tree.find(i => found = searchInTree(i));
		return found;
	}

	private toRow(item: EntryTreeItem) {
		if (item.entry instanceof ConfigEntry && item.entry.text) {
			return new Row(item.entry.config, item.entry.config.evaluate(this.ctx));
		}

		if (item.entry instanceof Scope) {
			if (item.children && item.entry.evaluate(this.ctx)) {
				return new MenuRow(item.entry);
			} else {
				return undefined;
			}
		}

		if (item.entry instanceof Comment) {
			return new CommentRow(item.entry);
		}
	}

	private setMenu(item: EntryTreeItem, goingUp=false) {
		const name = entryName(item.entry);

		this.currMenu = item;
		const msg = {
			cmd: 'setMenu',
			name,
			content: item.children.map(c => this.toRow(c)?.raw ?? '').join(''),
			up: item.parent ? entryId(item.parent) : undefined,
			goingUp,
		};

		panel.webview.postMessage(msg);
	}

	render() {
		const findComment = (items: EntryTreeItem[], backtrace: EntryTreeItem[]=[]): EntryTreeItem | undefined => {
			return items.find(i => {
				if (i.entry instanceof Comment) {
					let parent = i.parent;
					console.log(backtrace.map(i => entryName(i.entry)).join(' -> ') + ' -> ' + i.entry.text);
					return false;
				}

				return findComment(i.children, [...backtrace, i]);
			});
		}

		findComment(this.currMenu.children);

		this.rows = <Row[]>this.currMenu.children.map(e => this.toRow(e)).filter(e => e instanceof Component);
		const title = entryName(this.currMenu.entry);

		const codiconsUri = panel.webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'node_modules', 'vscode-codicons', 'dist', 'codicon.css')));

		panel.webview.html = `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Menuconfig</title>
  			<link rel="stylesheet" type="text/css" href="${mediaPath('menuconfig.css')}">
			<link href="${codiconsUri}" rel="stylesheet"/>
		</head>
		<body>
			${this.search.raw}
			<div id="title">
				<div id="up" class="button disabled">
					<i class="codicon codicon-chevron-left"></i>
				</div>
				<div id="menu-title">${title}</div>
			</div>
			<div class="menuconfig">
				<div id="menuconfig-content">
					${this.rows.map(r => r.raw).join('\n')}
				</div>
			</div>
			<script type="text/javascript" src="${mediaPath('script.js')}"></script>
		</body>
		</html>`;

		//help: <div id="help" class="hidden"></div>
		// fs.writeFileSync('/home/trond/vscode/vscode-kconfig/out.html', panel.webview.html);
	}
}