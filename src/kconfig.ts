/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import * as vscode from 'vscode';
import { ParsedFile } from './parse';

export type ConfigValueRange = { max: string; min: string; condition?: string };
export type ConfigValueType = 'string' | 'int' | 'hex' | 'bool' | 'tristate';
export type ConfigDefault = { value: string; condition?: string };
export type ConfigSelect = { name: string; condition?: string };
export type ConfigDependency = { expr: string; condition?: string };
export type LineRange = { start: number; end: number };

export class Comment {
    file: ParsedFile;
    text: string;
    line: number;

    constructor(text: string, file: ParsedFile, line: number) {
        this.text = text;
        this.file = file;
        this.line = line;
    }
}

export abstract class Scope {
    lines: LineRange;
    private _name: string;
    file: ParsedFile;
    children: (Scope | ConfigEntry | Comment)[];
    symbolKind: vscode.SymbolKind;

    constructor(
        public type: string,
        name: string,
        line: number,
        file: ParsedFile,
        symbolKind: vscode.SymbolKind
    ) {
        this._name = name;
        this.lines = { start: line, end: line };
        this.file = file;
        this.symbolKind = symbolKind;
        this.children = [];
    }

    public get name(): string {
        return this._name;
    }
    public set name(value: string) {
        this._name = value;
    }

    addScope(s: Scope): Scope {
        this.children.push(s);
        return s;
    }

    asDocSymbol(): vscode.DocumentSymbol {
        const sym = new vscode.DocumentSymbol(
            this.name,
            '',
            this.symbolKind,
            this.range,
            new vscode.Range(this.lines.start, 0, this.lines.start, 9999)
        );

        sym.children = this.children.reduce((all, c) => {
            if (c instanceof Scope || c instanceof ConfigEntry) {
                all.push(c.asDocSymbol());
            }

            return all;
        }, new Array<vscode.DocumentSymbol>());

        return sym;
    }

    get range(): vscode.Range {
        return new vscode.Range(this.lines.start, 0, this.lines.end, 9999);
    }
}

export class IfScope extends Scope {
    constructor(public expr: string, line: number, file: ParsedFile) {
        super('if', expr, line, file, vscode.SymbolKind.Module);
    }

    public get name(): string {
        const entryName = this.expr.trim().replace(/^CONFIG_/, '');
        const entry = this.file.entries.find((e) => e.name === entryName);

        return entry?.prompt ?? this.expr;
    }
}

export class MenuScope extends Scope {
    dependencies: string[];
    visible?: string;

    constructor(prompt: string, line: number, file: ParsedFile) {
        super('menu', prompt, line, file, vscode.SymbolKind.Class);
        this.dependencies = [];
    }
}

export class ChoiceScope extends Scope {
    choice: ChoiceEntry;
    constructor(choice: ChoiceEntry) {
        super('choice', choice.name, choice.lines.start, choice.file, vscode.SymbolKind.Enum);
        this.choice = choice;
    }

    // Override name property to dynamically get it from the ConfigEntry:
    get name(): string {
        return this.choice.prompt || this.choice.name;
    }

    set name(name: string) {
        /* do nothing */
    }
}

export class RootScope extends Scope {
    constructor(file: ParsedFile) {
        super('root', 'root', 0, file, vscode.SymbolKind.Class);
    }
}

export class ConfigEntry {
    name: string;
    lines: LineRange;
    file: ParsedFile;
    help?: string;
    ranges: ConfigValueRange[];
    type?: ConfigValueType;
    prompt?: string;
    dependencies: ConfigDependency[];
    selects: ConfigSelect[];
    implys: ConfigSelect[];
    defaults: ConfigDefault[];

    constructor(name: string, line: number, file: ParsedFile) {
        this.name = name;
        this.lines = { start: line, end: line };
        this.file = file;
        this.ranges = [];
        this.dependencies = [];
        this.selects = [];
        this.implys = [];
        this.defaults = [];
    }

    extend(lineNumber: number): void {
        if (lineNumber < this.lines.start) {
            throw new Error("Extending upwards, shouldn't be possible.");
        }
        if (lineNumber <= this.lines.end) {
            return;
        }

        this.lines.end = lineNumber;
    }

    get loc(): vscode.Location {
        return new vscode.Location(
            this.file.uri,
            new vscode.Range(this.lines.start, 0, this.lines.end, 99999)
        );
    }

    asDocSymbol(): vscode.DocumentSymbol {
        return new vscode.DocumentSymbol(
            this.prompt ?? this.name,
            this.type || '',
            this.symbolKind(),
            this.loc.range,
            new vscode.Range(this.lines.start, 0, this.lines.start, 9999)
        );
    }

    symbolKind(): vscode.SymbolKind {
        switch (this.type) {
            case 'bool':
                return vscode.SymbolKind.Property;
            case 'tristate':
                return vscode.SymbolKind.EnumMember;
            case 'int':
                return vscode.SymbolKind.Number;
            case 'hex':
                return vscode.SymbolKind.Number;
            case 'string':
                return vscode.SymbolKind.String;
            default:
                return vscode.SymbolKind.Property;
        }
    }
}

export class ChoiceEntry extends ConfigEntry {
    choices: ConfigEntry[];
    optional = false;

    constructor(name: string, line: number, file: ParsedFile) {
        super(name, line, file);
        this.choices = [];
    }
}
