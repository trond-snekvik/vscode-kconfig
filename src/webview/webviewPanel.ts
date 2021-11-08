/* Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { StateUpdateMessage, CallFunctionRequestMessage, GenericMessage } from './messages';

import { RemoteFunctionProvider } from './pages/callbackTypes';
import { context } from '../extension';

const extensionPath = context.extensionPath;

interface WebviewState {
    [key: string]: unknown;
}

export abstract class MessageListener {
    protected webview: WebviewPanel;

    constructor(webview: WebviewPanel) {
        this.webview = webview;
    }

    abstract dispatch(message: GenericMessage): Promise<void>;
}

export default abstract class WebviewPanel implements RemoteFunctionProvider {
    /**
     * The location on disk where all the webview resources are located.
     */
    public static WEBVIEW_ROOT = vscode.Uri.file(path.join(__dirname, 'webview'));

    /**
     * The location on disk of the default style file.
     */
    public static GLOBAL_STYLE_PATH = vscode.Uri.joinPath(WebviewPanel.WEBVIEW_ROOT, 'styles.css');

    /**
     * The location on disk of the image files.
     */
    public static IMAGE_ROOT = vscode.Uri.file(path.join(__dirname, 'images'));

    /**
     * The location on disk of the codicons.
     */
    public static CODICONS_ROOT = vscode.Uri.joinPath(WebviewPanel.WEBVIEW_ROOT, 'codicon.css');

    /**
     * The string displayed in the panel's tab bar entry.
     */
    protected abstract title: string;

    /**
     * Identifier used by the IDE to represent the panel.
     */
    protected abstract viewType: string;

    /**
     * Path to the HTML document that will make up the webview.
     */
    // protected abstract htmlPath: vscode.Uri;
    private static htmlPath = vscode.Uri.joinPath(WebviewPanel.WEBVIEW_ROOT, 'webview.html');

    /**
     * Path to the JavaScript file that will run in the webview.
     */
    protected abstract scriptPath: vscode.Uri;

    /**
     * Path to the CSS file that will be loaded in the webview.
     */
    protected abstract stylePath: vscode.Uri;

    async #onMessageReceived(message: GenericMessage): Promise<unknown> {
        if (message.type === 'PAGE_LOADED') {
            return this.#onPageLoad();
        }
        const stateMsg = message as StateUpdateMessage;
        if (stateMsg.type === 'STATE_UPDATE_REQUEST') {
            this.webviewState[stateMsg.payload.key] = stateMsg.payload.value;
            return;
        }
        const callMsg = message as CallFunctionRequestMessage;
        if (callMsg.type === 'CALL_FUNCTION_REQUEST') {
            this.postMessage({
                type: 'CALL_FUNCTION_RESPONSE',
                payload: {
                    callId: callMsg.payload.callId,
                    args: [
                        // @ts-ignore
                        await this[callMsg.payload.functionName](...callMsg.payload.args),
                    ],
                },
            });
            return;
        }
    }

    protected abstract onStateUpdateRequest(key: string, value: unknown): Promise<unknown>;
    protected sendStateUpdate(key: string, value: unknown): void {
        if (this.webviewState[key] !== value) {
            throw new Error(
                `Webview state update failed. ${key} is ${this.webviewState[key]} but should be ${value}`
            );
        }
        this.postMessage({ type: 'STATE_UPDATE', payload: { key, value } });
    }

    /**
     * This function will be called when the webview has loaded. Use it to
     * send initial data and so on that is necessary for the view to render
     * correctly. Use this function to set initial state of the webview
     * by Object.assign(this.webviewState, ...);
     */
    protected abstract onMount(): Promise<void>;

    protected disposable?: vscode.Disposable;
    protected disposablesPanel?: vscode.Disposable;
    protected panel?: vscode.WebviewPanel;
    protected panelActivated = new vscode.EventEmitter<void>();
    protected webviewState: WebviewState;

    constructor(private initialState: WebviewState = {}) {
        this.disposable = vscode.Disposable.from(this.panelActivated);

        // Let's start with an empty state object. Every change will call the proxy set function.
        this.webviewState = new Proxy({} as WebviewState, {
            set: (target: WebviewState, key: string, value): boolean => {
                this.onStateUpdateRequest(key, value).then((newValue) => {
                    Reflect.set(target, key, newValue);
                    this.sendStateUpdate(key, newValue);
                });
                return true;
            },
        });
    }

    async #onPageLoad(): Promise<void> {
        Object.assign(this.webviewState, this.initialState, {});
        return this.onMount();
    }

    public async createOrShow(): Promise<void> {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        //If we already have a panel, show it.
        if (this.panel) {
            this.panel.reveal(column, false);
            this.panel.webview.html = this.getHtml();
            return;
        }

        // Otherwise, create a new panel.
        this.panel = vscode.window.createWebviewPanel(
            this.viewType,
            this.title,
            column || vscode.ViewColumn.One,
            {
                enableCommandUris: true,
                enableScripts: true,

                //TODO: Find a better way to save variables when the tab is hidden to improve performance
                retainContextWhenHidden: true,

                //Restrict the webview only to loading content from these directories
                localResourceRoots: [
                    vscode.Uri.file(path.join(extensionPath, 'dist', 'webview')),
                    vscode.Uri.file(path.join(extensionPath, 'dist', 'images')),
                ],
            }
        );

        this.disposablesPanel = vscode.Disposable.from(
            this.panel,
            this.panel.onDidDispose(this.onPanelDisposed, this),
            this.panel.webview.onDidReceiveMessage(this.#onMessageReceived, this)
        );

        this.panel.webview.html = this.getHtml();
    }

    public dispose(): void {
        this.panel?.dispose();
        this.disposable?.dispose();
        this.disposablesPanel?.dispose();
    }

    private onPanelDisposed(): void {
        if (this.disposablesPanel) {
            this.disposablesPanel.dispose();
            this.panel = undefined;
        }
    }

    public postMessage(message: GenericMessage): Thenable<boolean> {
        if (!this.panel) {
            return Promise.resolve(false);
        }
        return this.panel!.webview.postMessage(message);
    }

    private getHtml(): string {
        const webview = this.panel!.webview;

        const scriptUri = webview.asWebviewUri(this.scriptPath);
        const styleSrc = webview.asWebviewUri(this.stylePath);
        const globalStyleSrc = webview.asWebviewUri(WebviewPanel.GLOBAL_STYLE_PATH);
        const images = webview.asWebviewUri(WebviewPanel.IMAGE_ROOT);
        const codicons = webview.asWebviewUri(WebviewPanel.CODICONS_ROOT);

        const data = fs.readFileSync(WebviewPanel.htmlPath.fsPath, 'utf8');
        let content = data.replace(/#{cspSource}/g, webview.cspSource);
        content = content.replace(/#{styleSrc}/g, styleSrc.toString());
        content = content.replace(/#{globalStyleSrc}/g, globalStyleSrc.toString());
        content = content.replace(/#{scriptUri}/g, scriptUri.toString());
        content = content.replace(/#{codicons}/g, codicons.toString());
        content = content.replace(/#{images}/g, images.toString());
        content = content.replace(/#{title}/, this.title);

        return content;
    }
}
