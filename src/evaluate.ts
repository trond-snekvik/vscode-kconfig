import { ConfigLocation, ConfigValue, ConfigValueType, ConfigOverride } from "./extension";
import { AssertionError } from "assert";

export enum TokenKind {
	VAR = "VAR",
	NUMBER = "NUMBER",
	STRING = "STRING",
	TRISTATE = "TRISTATE",
	NOT = "NOT",
	AND = "AND",
	OR = "OR",
	OPEN_PARENTHESIS = "OPEN_PARENTHESIS",
	CLOSING_PARENTHESIS = "CLOSING_PARENTHESIS",
	EQUAL = "EQUAL",
	NEQUAL = "NEQUAL",
	GREATER = "GREATER",
	LESS = "LESS",
	GREATER_EQUAL = "GREATER_EQUAL",
	LESS_EQUAL = "LESS_EQUAL",
}
export enum Operator {
	VAR = "VAR",
	LITERAL = "LITERAL",
	NOT = "NOT",
	AND = "AND",
	OR = "OR",
	PARENTHESIS = "PARENTHESIS",
	EQUAL = "EQUAL",
	NEQUAL = "NEQUAL",
	GREATER = "GREATER",
	LESS = "LESS",
	GREATER_EQUAL = "GREATER_EQUAL",
	LESS_EQUAL = "LESS_EQUAL",
	UNKNOWN = "UNKNOWN",

}
export interface Token { kind: TokenKind; value: string; }

export class ExpressionError extends Error {
	token?: Token;
	constructor(message: string, token?: Token) {
		super(message);
		this.token = token;
	}
}

function operatorFromToken(t: Token): Operator {
	switch (t.kind) {
		case TokenKind.VAR: return Operator.VAR;
		case TokenKind.NUMBER: return Operator.LITERAL;
		case TokenKind.STRING: return Operator.LITERAL;
		case TokenKind.TRISTATE: return Operator.LITERAL;
		case TokenKind.NOT: return Operator.NOT;
		case TokenKind.AND: return Operator.AND;
		case TokenKind.OR: return Operator.OR;
		case TokenKind.OPEN_PARENTHESIS:
		case TokenKind.CLOSING_PARENTHESIS:
			return Operator.PARENTHESIS;
		case TokenKind.EQUAL: return Operator.EQUAL;
		case TokenKind.NEQUAL: return Operator.NEQUAL;
		case TokenKind.GREATER: return Operator.GREATER;
		case TokenKind.LESS: return Operator.LESS;
		case TokenKind.GREATER_EQUAL: return Operator.GREATER_EQUAL;
		case TokenKind.LESS_EQUAL: return Operator.LESS_EQUAL;
	}
}


export interface Expression { operator: Operator; operands: Expression[]; var?: Token; }

export function tokenizeExpression(expr: string): Token[] {
	var tokens: Token[] = [];

	var constant_tokens: Token[] = [
		{ kind: TokenKind.NEQUAL, value: '!=' },
		{ kind: TokenKind.NOT, value: '!' },
		{ kind: TokenKind.AND, value: '&&' },
		{ kind: TokenKind.OR, value: '||' },
		{ kind: TokenKind.OPEN_PARENTHESIS, value: '(' },
		{ kind: TokenKind.CLOSING_PARENTHESIS, value: ')' },
		{ kind: TokenKind.GREATER_EQUAL, value: '>=' },
		{ kind: TokenKind.LESS_EQUAL, value: '<=' },
		{ kind: TokenKind.EQUAL, value: '=' },
		{ kind: TokenKind.GREATER, value: '>' },
		{ kind: TokenKind.LESS, value: '<' },
		// { kind: TokenKind.TRISTATE, value: 'y' },
		// { kind: TokenKind.TRISTATE, value: 'n' },
		// { kind: TokenKind.TRISTATE, value: 'm' },
	];

	while (expr.length > 0) {

		var skippable = expr.match(/^[\s\r\n\\]+/);
		if (skippable) {
			expr = expr.slice(skippable[0].length);
			continue;
		}

		var token = constant_tokens.find(t => expr.startsWith(t.value));
		if (token) {
			tokens.push(token);
			expr = expr.slice(token.value.length);
			continue;
		}

		var tristate = expr.match(/^[ymn]\b/);
		if (tristate) {
			tokens.push({ kind: TokenKind.TRISTATE, value: tristate[0] });
			expr = expr.slice(tristate[0].length);
			continue;
		}

		var string = expr.match(/^(?:""|"(.*?[^\\])")/);
		if (string) {
			tokens.push({ kind: TokenKind.STRING, value: string[1] });
			expr = expr.slice(string[0].length);
			continue;
		}

		var number = expr.match(/^(?:0x[\da-fA-F]+|\d+)/);
		if (number) {
			tokens.push({ kind: TokenKind.NUMBER, value: number[0] });
			expr = expr.slice(number[0].length);
			continue;
		}

		var variable = expr.match(/^\w[\w\d_]+/);
		if (variable) {
			tokens.push({ kind: TokenKind.VAR, value: variable[0] });
			expr = expr.slice(variable[0].length);
			continue;
		}

		throw new ExpressionError(`Unknown symbol: ${expr}`);
	}

	return tokens;
}

export function makeExpr(tokens: Token[]): Expression {
	// Tokens in order of precendence:
	var tokenOrder = [
		TokenKind.VAR, TokenKind.STRING, TokenKind.NUMBER, TokenKind.TRISTATE,
		TokenKind.NOT, TokenKind.OR, TokenKind.AND,
		TokenKind.GREATER_EQUAL, TokenKind.LESS_EQUAL, TokenKind.GREATER, TokenKind.LESS,
		TokenKind.NEQUAL, TokenKind.EQUAL,
	];

	var depth = 0;
	var best: { token: Token, index: number, score: number } | undefined;

	tokens.forEach((t, i) => {
		switch (t.kind) {
			case TokenKind.OPEN_PARENTHESIS:
				depth++;
				break;
			case TokenKind.CLOSING_PARENTHESIS:
				depth--;
				if (depth < 0) {
					throw new ExpressionError('Unmatched closing parenthesis', t);
				}
				break;
			default: {
				if (depth === 0) {
					var score = tokenOrder.indexOf(t.kind);
					if (!best || score > best.score) {
						best = { token: t, index: i, score: score };
					}
				}
				break;
			}
		}
	});

	if (depth !== 0) {
		throw new ExpressionError('Unmatched opening parethesis');
	}

	if (best === undefined) {
		// the expression is surrounded by parentheses:
		return { operator: Operator.PARENTHESIS, operands: [makeExpr(tokens.slice(1, tokens.length - 1))] };
	}

	if (best.token.kind === TokenKind.VAR) {
		return { operator: Operator.VAR, operands: [], var: best.token };
	}

	if ([TokenKind.STRING, TokenKind.NUMBER, TokenKind.TRISTATE].includes(best.token.kind)) {
		return { operator: Operator.LITERAL, operands: [], var: best.token };
	}

	var groups: Token[][] = [];

	if (best.index > 0) {
		groups.push(tokens.slice(0, best.index));
	}
	if (best.index < tokens.length - 1) {
		groups.push(tokens.slice(best.index + 1));
	}

	var op = operatorFromToken(best.token);

	if (((operator: Operator) => {
		switch (operator) {
			case Operator.VAR: return 0;
			case Operator.NOT: return 1;
			case Operator.AND: return 2;
			case Operator.OR: return 2;
			case Operator.PARENTHESIS: return 1;
			case Operator.EQUAL: return 2;
			case Operator.NEQUAL: return 2;
			case Operator.GREATER: return 2;
			case Operator.LESS: return 2;
			case Operator.GREATER_EQUAL: return 2;
			case Operator.LESS_EQUAL: return 2;
			case Operator.UNKNOWN: return 0;
		}
	})(op) !== groups.length) {
		throw new ExpressionError('Missing operator', best.token);
	}

	var operands: Expression[] = groups.map(g => makeExpr(g));

	return { operator: op, operands: operands };
}

export function resolveExpression(raw: string, all: ConfigLocation[], overrides: ConfigOverride[]): ConfigValue {

	var tokens = tokenizeExpression(raw);
	var expr = makeExpr(tokens);

	var solve = function (expr: Expression): ConfigValue {

		var typecheck = (op: string, val: ConfigValue, ...types: string[]) => {
			if (!types.includes(typeof val)) {
				throw new ExpressionError(`Invalid type for ${op} operator: ${typeof val}`);
			}
			return val;
		};

		var lhs, rhs;

		switch (expr.operator) {
			case Operator.VAR:
				lhs = all.find(v => expr.var!.value === v.name);
				if (!lhs) {
					return false;
				}
				return lhs.evaluate(all, overrides);
			case Operator.LITERAL:
				if (!expr.var) {
					throw new ExpressionError('Parser error');
				}
				if (expr.var.kind === TokenKind.STRING) {
					return expr.var.value;
				}
				if (expr.var.kind === TokenKind.NUMBER) {
					return Number(expr.var.value);
				}
				if (expr.var.kind === TokenKind.TRISTATE) {
					return expr.var.value === 'y' || expr.var.value === 'm';
				}
				throw new ExpressionError('Unknown literal', expr.var);
			case Operator.NOT:
				return !typecheck('!', solve(expr.operands[0]), 'boolean');
			case Operator.AND:
				return typecheck('&&', solve(expr.operands[0]), 'boolean') && typecheck('&&', solve(expr.operands[1]), 'boolean');
			case Operator.OR:
				return typecheck('||', solve(expr.operands[0]), 'boolean') || typecheck('||', solve(expr.operands[1]), 'boolean');
			case Operator.PARENTHESIS:
				return solve(expr.operands[0]);
			case Operator.EQUAL:
				lhs = solve(expr.operands[0]);
				rhs = solve(expr.operands[1]);
				return (lhs === rhs);
			case Operator.NEQUAL:
				lhs = solve(expr.operands[0]);
				rhs = solve(expr.operands[1]);
				return (lhs !== rhs);
			case Operator.GREATER:
				lhs = solve(expr.operands[0]);
				rhs = solve(expr.operands[1]);
				return (lhs > rhs);
			case Operator.LESS:
				lhs = solve(expr.operands[0]);
				rhs = solve(expr.operands[1]);
				return (lhs < rhs);
			case Operator.GREATER_EQUAL:
				lhs = solve(expr.operands[0]);
				rhs = solve(expr.operands[1]);
				return (lhs >= rhs);
			case Operator.LESS_EQUAL:
				lhs = solve(expr.operands[0]);
				rhs = solve(expr.operands[1]);
				return (lhs <= rhs);
		}
		throw new ExpressionError('Invalid expression');
	};

	return solve(expr);
}

