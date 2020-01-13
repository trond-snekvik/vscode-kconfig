import * as vscode from 'vscode';
import * as path from 'path';

export function getConfig(name: string): any {
	var config = vscode.workspace.getConfiguration("kconfig");
	return config.get(name);
}


var env: { [name: string]: string };

export function update() {
	env = {};
	var conf = getConfig('env');
	Object.keys(conf).forEach(k => env[k] = conf[k]);

	try {
		Object.keys(env).forEach(key => {
			var match;
			while ((match = env[key].match(/\${(.+?)}/)) !== null) {
				var replacement: string;
				if (match[1] === key) {
					vscode.window.showErrorMessage(`Kconfig environment is circular: variable ${key} references itself`);
					throw new Error('Kconfig environment is circular');
				} else if (match[1] in env) {
					replacement = env[match[1]];
				} else if (match[1].startsWith('workspaceFolder')) {
					if (!vscode.workspace.workspaceFolders) {
						return;
					}

					var folder = match[1].match(/workspaceFolder:(.+)/);
					if (folder) {
						var wsf = vscode.workspace.workspaceFolders.find(f => f.name === folder![1]);
						if (!wsf) {
							return;
						}
						replacement = wsf.uri.fsPath;
					} else {
						replacement = vscode.workspace.workspaceFolders[0].uri.fsPath;
					}
				} else {
					return;
				}

				env[key] = env[key].replace(new RegExp(`\\\${${match[1]}}`, 'g'), replacement);
			}
		});
	} catch (e) {
		// ignore
	}
}

export function pathReplace(fileName: string): string {
	fileName = fileName.replace(/\${workspaceFolder:(.+?)}/g, (original, name) => {
		var folder = vscode.workspace.workspaceFolders!.find(folder => folder.name === name);
		return folder ? folder.uri.fsPath : original;
	});

	fileName = fileName.replace(/\$[{(](.+?)[})]/g, (original: string, v: string) => {
		if (v in process.env) {
			return process.env[v] as string;
		} else if (v in env) {
			return env[v];
		}
		return original;
	});

	return fileName.replace(/$\([^)]+\)/g, '');
}

export function getRoot(file?: string): string {
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

export function resolvePath(fileName: string, root?: string) {
	if (!root) {
		root = getRoot(fileName);
	}
	fileName = fileName.replace('${workspaceFolder}', root);
	fileName = pathReplace(fileName);
	return path.normalize(path.isAbsolute(fileName) ? fileName : path.join(root ? root : root, fileName));
}

export type Environment = { [variable: string]: string };

export function replace(text: string, env: Environment) {
	return text.replace(/\$\((.+?)\)/, (original, variable) => ((variable in env) ? env[variable] : original));
}
