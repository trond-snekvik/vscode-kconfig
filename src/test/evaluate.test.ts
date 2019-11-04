

// The module 'assert' provides assertion methods from node
import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { TokenKind, Token, Expression, Operator, tokenizeExpression, makeExpr, resolveExpression, ExpressionError } from '../evaluate';
import { ConfigLocation } from '../extension';

var configs: ConfigLocation[] = [
  new ConfigLocation('SETTINGS', new vscode.Location(vscode.Uri.file('Kconfig'), new vscode.Position(0, 0)), 'config', 'bool'),
  new ConfigLocation('FLASH', new vscode.Location(vscode.Uri.file('Kconfig'), new vscode.Position(0, 0)), 'config', 'bool'),
  new ConfigLocation('NAME', new vscode.Location(vscode.Uri.file('Kconfig'), new vscode.Position(0, 0)), 'config', 'string'),
  new ConfigLocation('NUMBER', new vscode.Location(vscode.Uri.file('Kconfig'), new vscode.Position(0, 0)), 'config', 'int'),
];

function assertTokens(actual: Token[], expected: Token[]) {
  assert(actual.length === expected.length);
  actual.forEach((t, i) => assert(expected[i].kind === t.kind && expected[i].value === t.value, `Token ${i} is different: Expected ${expected} got ${actual}`));
}

function assertExpr(actual: Expression, expected: Expression) {
  assert(actual.operator === expected.operator);
  if (actual.var !== undefined) {
    assert(expected.var !== undefined);
    assertTokens([actual.var], [expected.var!]);
  } else {
    assert(expected.var === undefined);
  }
  assert(actual.operands.length === expected.operands.length);
  actual.operands.forEach((o, i) => assertExpr(o, expected.operands[i]));
}

// Defines a Mocha test suite to group tests of similar kind together
suite("Evaluate Tests", () => {

  test("tokenize", () => {
    assertTokens(tokenizeExpression('SETTINGS'), [{ kind: TokenKind.VAR, value: 'SETTINGS' }]);
    assertTokens(tokenizeExpression('!SETTINGS'), [{ kind: TokenKind.NOT, value: '!'}, { kind: TokenKind.VAR, value: 'SETTINGS' }]);
    assertTokens(tokenizeExpression('(SETTINGS)'), [{ kind: TokenKind.OPEN_PARENTHESIS, value: '('}, { kind: TokenKind.VAR, value: 'SETTINGS' }, { kind: TokenKind.CLOSING_PARENTHESIS, value: ')'}]);
    assertTokens(tokenizeExpression('(!SETTINGS || VAL)'), [{ kind: TokenKind.OPEN_PARENTHESIS, value: '('}, { kind: TokenKind.NOT, value: '!'}, { kind: TokenKind.VAR, value: 'SETTINGS' }, { kind: TokenKind.OR, value: '||' }, { kind: TokenKind.VAR, value: 'VAL' }, { kind: TokenKind.CLOSING_PARENTHESIS, value: ')'}]);
  });

  test("makeExpr", () => {
    assertExpr(makeExpr(tokenizeExpression('SETTINGS')), {operator: Operator.VAR, operands: [], var: {kind: TokenKind.VAR, value: 'SETTINGS'}});
    assertExpr(makeExpr(tokenizeExpression('!SETTINGS')),
      {
        operator: Operator.NOT,
        operands: [
          { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'SETTINGS' } }
        ]
      });
    assertExpr(makeExpr(tokenizeExpression('(SETTINGS)')),
      {
        operator: Operator.PARENTHESIS,
        operands: [
          { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'SETTINGS' } }
        ]
      });
    assertExpr(makeExpr(tokenizeExpression('(!SETTINGS)')),
      {
        operator: Operator.PARENTHESIS,
        operands: [{
          operator: Operator.NOT,
          operands: [
            { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'SETTINGS' } }]
        }
        ]
      });
    assertExpr(makeExpr(tokenizeExpression('VAR1 || VAR2')),
      {
        operator: Operator.OR,
        operands: [
          { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'VAR1' } },
          { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'VAR2' } },
        ]
      });
    assertExpr(makeExpr(tokenizeExpression('!(VAR1 || !VAR2) = (VAR3 >= 50)')),
      {
        operator: Operator.EQUAL,
        operands: [
          {
            operator: Operator.NOT, operands: [
              {
                operator: Operator.PARENTHESIS, operands: [
                  {
                    operator: Operator.OR, operands: [
                      { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'VAR1' } },
                      {
                        operator: Operator.NOT, operands: [
                          { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'VAR2' } },
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          },
          {
            operator: Operator.PARENTHESIS,
            operands: [
              {
                operator: Operator.GREATER_EQUAL, operands: [
                  { operator: Operator.VAR, operands: [], var: { kind: TokenKind.VAR, value: 'VAR3' } },
                  { operator: Operator.LITERAL, operands: [], var: { kind: TokenKind.NUMBER, value: '50' } },
                ]
              }
            ]
          }
        ]
      });
  });

  test("evaluate", () => {
    assert(resolveExpression('SETTINGS', configs, [{ config: configs[0], value: 'y', line: 0 }]));
    assert(!resolveExpression('SETTINGS', configs, [{ config: configs[0], value: 'n', line: 0 }]));
    assert(!resolveExpression('!SETTINGS', configs, [{ config: configs[0], value: 'y', line: 0 }]));
    assert(resolveExpression('!SETTINGS', configs, [{ config: configs[0], value: 'n', line: 0 }]));
    assert(resolveExpression('(SETTINGS)', configs, [{ config: configs[0], value: 'y', line: 0 }]));
    assert(resolveExpression('(!SETTINGS)', configs, [{ config: configs[0], value: 'n', line: 0 }]));
    assert(!resolveExpression('(!SETTINGS)', configs, [{ config: configs[0], value: 'y', line: 0 }]));

    assert(resolveExpression('SETTINGS || !SETTINGS', configs, [{ config: configs[0], value: 'y', line: 0 }]));
    assert(!resolveExpression('SETTINGS && !SETTINGS', configs, [{ config: configs[0], value: 'y', line: 0 }]));
    assert(resolveExpression('SETTINGS || !SETTINGS', configs, [{ config: configs[0], value: 'n', line: 0 }]));
    assert(resolveExpression('(SETTINGS || !SETTINGS)', configs, [{ config: configs[0], value: 'n', line: 0 }]));
    assert(!resolveExpression('!(SETTINGS || !SETTINGS)', configs, [{ config: configs[0], value: 'n', line: 0 }]));

    assert(!resolveExpression('NUMBER > 50', configs, [{ config: configs[3], value: '50', line: 0 }]));
    assert(!resolveExpression('NUMBER < 50', configs, [{ config: configs[3], value: '50', line: 0 }]));
    assert(!resolveExpression('NUMBER != 50', configs, [{ config: configs[3], value: '50', line: 0 }]));
    assert(resolveExpression('NUMBER = 50', configs, [{ config: configs[3], value: '50', line: 0 }]));
    assert(resolveExpression('NUMBER >= 50', configs, [{ config: configs[3], value: '50', line: 0 }]));
    assert(resolveExpression('NUMBER <= 50', configs, [{ config: configs[3], value: '50', line: 0 }]));

    assert(!resolveExpression('NUMBER <= 50', configs, [{ config: configs[3], value: '60', line: 0 }]));
    assert(resolveExpression('NUMBER >= 50', configs, [{ config: configs[3], value: '60', line: 0 }]));
    assert(resolveExpression('NUMBER != 50', configs, [{ config: configs[3], value: '60', line: 0 }]));
    assert(!resolveExpression('NUMBER = 50', configs, [{ config: configs[3], value: '60', line: 0 }]));

    configs[2].defaults.push({ value: 'name' });
    assert(!resolveExpression('NAME = 50', configs, []));
    assert(resolveExpression('NAME = "name"', configs, []));
    assert(!resolveExpression('NAME = "nAme"', configs, []));
    assert(resolveExpression('NAME != "nAme"', configs, []));
    assert(resolveExpression('NAME != 1', configs, []));
    assert(resolveExpression('NAME != 0', configs, []));

    configs[2].dependencies.push('NUMBER = 50');
    assert(resolveExpression('NAME = "name"', configs, [{ config: configs[3], value: '50', line: 0 }]));
    assert(!resolveExpression('NAME = "name"', configs, [{ config: configs[3], value: '60', line: 0 }]));
    assert(!resolveExpression('NAME != "name"', configs, [{ config: configs[3], value: '50', line: 0 }]));

    configs[2].dependencies.push('FLASH || SETTINGS');
    configs[3].defaults.push({ value: '50' });
    configs[0].defaults.push({ value: 'y', condition: 'NUMBER = 50' }); // is true
    assert(resolveExpression('NAME = "name"', configs, []));
    assert(!resolveExpression('NAME != "name"', configs, []));

    configs[2].dependencies.push('FLASH'); // is false
    assert(!resolveExpression('NAME = "name"', configs, []));
    assert(resolveExpression('NAME != "name"', configs, []));

    configs[1].defaults.push({ value: 'y', condition: 'NUMBER = 40' }); // is false
    assert(!resolveExpression('NAME = "name"', configs, []));
    assert(resolveExpression('NAME != "name"', configs, []));

    configs[1].defaults.push({ value: 'y', condition: 'SETTINGS' }); // is true
    assert(resolveExpression('NAME = "name"', configs, []));
    assert(!resolveExpression('NAME != "name"', configs, []));

    configs[1].dependencies.push('50 = 60'); // false, FLASH can never be true now
    assert(!resolveExpression('NAME = "name"', configs, []));
    assert(resolveExpression('NAME != "name"', configs, []));
  });
});
