# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

from typing import List
import kconfiglsp
from os import path
from pytest import fixture
from lsp import Diagnostic, FileChangeKind, Position, SymbolKind, Uri, documentStore
from .mock_stream import MockStream
from rpc import RPCNotification, RPCRequest, RPCResponse

io: MockStream
srv: kconfiglsp.KconfigServer
req_id: int
notifications: List[RPCNotification]
requests: List[RPCRequest]

zephyr_root = path.join(path.dirname(__file__), 'resources', 'zephyr')
build_folder = path.join(zephyr_root, 'build')


@fixture(autouse=True)
def setup_test_case():
    global req_id, io, srv, notifications, requests
    io = MockStream()
    req_id = 0
    srv = kconfiglsp.KconfigServer(io, io)
    notifications = []
    requests = []
    documentStore.reset()


def recv(count=10) -> List[RPCResponse]:
    msgs = []
    for _ in range(count):
        if len(io.output) == 0:
            break
        msg = io.recv()
        if isinstance(msg, RPCResponse) and msg.id == req_id:
            msgs.append(msg)
        if isinstance(msg, RPCRequest):
            requests.append(msg)
        if isinstance(msg, RPCNotification):
            notifications.append(msg)
    return msgs


def request(name, params=None):
    global req_id
    io.output = ''  # flush
    req_id += 1
    req = RPCRequest(req_id, name, params)
    srv.handle(req)
    return recv().pop()


def notify(name, params=None):
    notification = RPCNotification(name, params)
    srv.handle(notification)
    recv()


def test_init():
    rsp = request('initialize', {'rootUri': str(Uri.file(zephyr_root))})
    assert rsp.error == None

    # Should report a basic set of features.
    # This tests the server's ability to report features, not the exact feature set.
    # As such, we don't have to check for false negatives, and we don't need to change
    # this every time we add a new feature.
    expected_features = [
        'hoverProvider',
        'definitionProvider',
        'documentSymbolProvider',
        'codeActionProvider',
        'workspaceSymbolProvider',
    ]
    caps = rsp.result['capabilities']
    for feature in expected_features:
        assert feature in caps
        assert caps[feature] == True

    assert caps['textDocumentSync'] == 2  # Incremental


def test_init_no_workspace():
    rsp = request('initialize', {'rootUri': str(Uri.file(zephyr_root)), 'workspaceFolders': None})
    assert rsp.error == None  # Should be an acceptable parameter.


def test_initialized_notification():
    test_init()

    requests.clear()
    notify('initialized')

    # Should register file watcher:
    caps = [
        req.params['registrations'][0] for req in requests
        if req.method == 'client/registerCapability'
    ]
    watchers = [
        reg['registerOptions']['watchers'][0] for reg in caps
        if reg['method'] == 'workspace/didChangeWatchedFiles'
    ]
    assert len(watchers) > 0

    assert watchers == [
        {
            'globPattern': '**/Kconfig*',
            'kind': 7
        },
        {
            'globPattern': '**/edt.pickle',
            'kind': 7
        },
    ]


def test_add_context():
    test_initialized_notification()  # ensure that the server is initialized

    rsp = request(
        'kconfig/addBuild', {
            'uri': str(Uri.file(build_folder)),
            'conf': [path.join(zephyr_root, 'prj.conf')],
            'root': path.join(zephyr_root, 'Kconfig'),
            'env': {
                'TEST_VAR': 'INSERTED',
                'ZEPHYR_BASE': zephyr_root,
                'srctree': zephyr_root,
                'BOARD': 'boardname',
                'ARCH': 'ARM',
                'BOARD_DIR': path.join(zephyr_root, 'board_dir'),
            }
        })
    assert rsp.error == None
    assert path.samefile(Uri.parse(rsp.result['id']).path, build_folder)


def test_parse_context():
    test_add_context()

    # Activate the context and parse it:
    notifications.clear()
    assert request('kconfig/setMainBuild', {'uri': str(Uri.file(build_folder))}).error == None
    assert len(notifications) > 0

    diags = [n.params for n in notifications if n.method == 'textDocument/publishDiagnostics']
    assert len(diags) > 0

    files = [path.normpath(Uri.parse(d['uri']).path) for d in diags]
    assert path.join(zephyr_root, 'board_dir', 'boardname_defconfig') in files
    assert path.join(zephyr_root, 'prj.conf') in files


def test_workspace_symbols():
    test_parse_context()

    rsp = request('workspace/symbol', {'query': ''})
    assert rsp.error == None
    assert [r['name'] for r in rsp.result] == [
        'CONFIG_TEST_ENTRY1', 'CONFIG_TEST_ENTRY2', 'CONFIG_TEST_ENTRY3', 'CONFIG_OPTION_1',
        'CONFIG_OPTION_2', 'CONFIG_OPTION_3', 'CONFIG_HIDDEN_ENTRY', 'CONFIG_ENTRY_INSERTED',
        'CONFIG_BOARD_SPECIFIC_ENTRY', 'CONFIG_plain_ENTRY', 'CONFIG_relative_ENTRY',
        'CONFIG_optional_ENTRY', 'CONFIG_relative_optional_ENTRY', 'CONFIG_OPTION_4'
    ]

    rsp = request('workspace/symbol', {'query': 'TEST'})
    assert rsp.error == None
    assert [r['name'] for r in rsp.result
            ] == ['CONFIG_TEST_ENTRY1', 'CONFIG_TEST_ENTRY2', 'CONFIG_TEST_ENTRY3']

    rsp = request('workspace/symbol', {'query': 'CONFIG_TEST'})
    assert rsp.error == None
    assert [r['name'] for r in rsp.result
            ] == ['CONFIG_TEST_ENTRY1', 'CONFIG_TEST_ENTRY2', 'CONFIG_TEST_ENTRY3']


def test_completion():
    test_parse_context()

    # Root completion:
    rsp = request(
        'textDocument/completion',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
            },
            'position': Position(3, 0).__dict__,  # an empty line
        })

    # Should yield values that can be set:
    assert [i['label'] for i in rsp.result['items']] == [
        'CONFIG_TEST_ENTRY2', 'CONFIG_TEST_ENTRY3', 'CONFIG_OPTION_1', 'CONFIG_OPTION_2',
        'CONFIG_OPTION_3', 'CONFIG_BOARD_SPECIFIC_ENTRY', 'CONFIG_plain_ENTRY',
        'CONFIG_relative_ENTRY', 'CONFIG_optional_ENTRY', 'CONFIG_relative_optional_ENTRY',
        'CONFIG_OPTION_4'
    ]
    assert rsp.result['isIncomplete'] == True  # Didn't yield all results

    # Completion with partial text:
    rsp = request(
        'textDocument/completion',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
            },
            'position': Position(0,
                                 10).__dict__,  # @ CONFIG_TES, should yield CONFIG_TEST_* entries
        })

    # Should yield values that can be set:
    assert [i['label'] for i in rsp.result['items']] == [
        'CONFIG_TEST_ENTRY1',
        'CONFIG_TEST_ENTRY2',
        'CONFIG_TEST_ENTRY3',
    ]
    assert rsp.result['isIncomplete'] == False

    # Partial CONFIG_ completion:
    rsp = request(
        'textDocument/completion',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
            },
            'position': Position(0, 4).__dict__,  # @ CONF, should act like root completion
        })

    # Should yield values that can be set:
    assert [i['label'] for i in rsp.result['items']] == [
        'CONFIG_TEST_ENTRY2', 'CONFIG_TEST_ENTRY3', 'CONFIG_OPTION_1', 'CONFIG_OPTION_2',
        'CONFIG_OPTION_3', 'CONFIG_BOARD_SPECIFIC_ENTRY', 'CONFIG_plain_ENTRY',
        'CONFIG_relative_ENTRY', 'CONFIG_optional_ENTRY', 'CONFIG_relative_optional_ENTRY',
        'CONFIG_OPTION_4'
    ]
    assert rsp.result['isIncomplete'] == True  # Didn't yield all results


def test_doc_symbols():
    test_parse_context()

    rsp = request('textDocument/documentSymbol', {
        'textDocument': {
            'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
        },
    })

    assert rsp.result

    symbols = [{
        'name': sym['name'],
        'line': sym['range']['start']['line'],
        'kind': sym['kind'],
        'detail': sym['detail']
    } for sym in rsp.result]
    assert symbols == [
        {
            'name': 'CONFIG_TEST_ENTRY3',
            'line': 0,
            'kind': SymbolKind.PROPERTY,
            'detail': 'Test entry 3'
        },
        {
            'name': 'CONFIG_TEST_ENTRY1',
            'line': 1,
            'kind': SymbolKind.PROPERTY,
            'detail': 'Test entry 1'
        },
        {
            'name': 'CONFIG_HIDDEN_ENTRY',
            'line': 2,
            'kind': SymbolKind.PROPERTY,
            'detail': None  # hidden
        }
    ]


def test_watcher():
    test_parse_context()
    notify(
        'workspace/didChangeWatchedFiles', {
            'changes': [{
                'uri': str(Uri.file(path.join(zephyr_root, 'Kconfig'))),
                'type': FileChangeKind.CHANGED
            }]
        })

    notifications.clear()

    # Force a reparse:
    request(
        'textDocument/completion',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
            },
            'position': Position(0,
                                 10).__dict__,  # @ CONFIG_TES, should yield CONFIG_TEST_* entries
        })
    # Should have parsed the file tree again.
    # Determine this by the diagnostics posting:
    assert len([n for n in notifications if n.method == 'textDocument/publishDiagnostics']) > 0


def test_hover():
    test_parse_context()

    rsp = request(
        'textDocument/hover',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
            },
            'position': Position(0,
                                 10).__dict__,  # @ CONFIG_TES, should yield CONFIG_TEST_* entries
        })
    assert rsp.result['contents']['value']

    rsp = request(
        'textDocument/hover',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'Kconfig')))
            },
            'position': Position(5, 21).__dict__,  # @ TEST_ENTRY2
        })
    assert rsp.result['contents']['value']

    rsp = request(
        'textDocument/hover',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'source.c')))
            },
            'position': Position(1, 20).__dict__,  # @ CONFIG_TEST_ENTRY1
        })
    assert rsp.result['contents']['value']


def test_menus():
    def menu_item(i):
        return {
            'prompt': i['prompt'],
            'name': i.get('name'),
            'isMenu': i['isMenu'],
            'help': i.get('help'),
            'kind': i['kind'],
            'type': i.get('type'),
            'val': i.get('val'),
        }

    test_parse_context()

    rsp = request('kconfig/getMenu', {})
    assert rsp.error == None
    root = rsp.result
    assert root['name'] == 'Main menu'
    assert root['id']
    assert [menu_item(i) for i in root['items']] == [{
        'prompt': 'Some menu',
        'name': None,
        'isMenu': True,
        'help': None,
        'kind': 'menu',
        'type': None,
        'val': None,
    }, {
        'prompt': 'Board configured entry',
        'name': 'BOARD_SPECIFIC_ENTRY',
        'isMenu': False,
        'help': None,
        'kind': 'symbol',
        'type': 'int',
        'val': '123',
    }, {
        'prompt': 'Subdir entries',
        'name': None,
        'isMenu': True,
        'help': None,
        'kind': 'menu',
        'type': None,
        'val': None,
    }]

    rsp = request('kconfig/getMenu', {'id': root['items'][0]['id']})
    assert rsp.error == None
    menu = rsp.result
    assert menu['name'] == 'Some menu'
    assert menu['id']
    assert [menu_item(i) for i in menu['items']] == [{
        'prompt': 'Test entry 2',
        'name': 'TEST_ENTRY2',
        'isMenu': False,
        'help': 'This is a help text',
        'kind': 'symbol',
        'type': 'bool',
        'val': 'n',
    }, {
        'prompt': 'Test entry 3',
        'name': 'TEST_ENTRY3',
        'isMenu': False,
        'help': None,
        'kind': 'symbol',
        'type': 'bool',
        'val': 'y',
    }, {
        'prompt': 'Some comment',
        'name': None,
        'isMenu': False,
        'help': None,
        'kind': 'comment',
        'type': None,
        'val': None,
    }, {
        'prompt': 'A choice',
        'name': 'CHOICE',
        'isMenu': True,
        'help': None,
        'kind': 'choice',
        'type': 'bool',
        'val': 'Option 1',
    }]

    # Get choices
    rsp = request('kconfig/getMenu', {'id': menu['items'][3]['id']})
    assert rsp.error == None
    choices = rsp.result
    assert choices['name'] == 'A choice'
    assert choices['id']
    assert [menu_item(i) for i in choices['items']] == [{
        'prompt': 'Option 1',
        'name': 'OPTION_1',
        'isMenu': False,
        'help': None,
        'kind': 'symbol',
        'type': 'bool',
        'val': 'y',
    }, {
        'prompt': 'Option 2',
        'name': 'OPTION_2',
        'isMenu': False,
        'help': None,
        'kind': 'symbol',
        'type': 'bool',
        'val': 'n',
    }, {
        'prompt': 'Option 3',
        'name': 'OPTION_3',
        'isMenu': False,
        'help': None,
        'kind': 'symbol',
        'type': 'bool',
        'val': 'n',
    }, {
        'prompt': 'Option 4',
        'name': 'OPTION_4',
        'isMenu': False,
        'help': None,
        'kind': 'symbol',
        'type': 'bool',
        'val': 'n',
    }, {
        'prompt': 'A comment inside a choice',
        'name': None,
        'isMenu': False,
        'help': None,
        'kind': 'comment',
        'type': None,
        'val': None,
    }]


def test_search():
    test_parse_context()

    rsp = request('kconfig/search', {'query': 'TEST_'})  # fuzzy search for TEST_ENTRY_*
    assert rsp.error == None
    assert rsp.result['symbols'] == [
        {
            'name': 'TEST_ENTRY1',
            'prompt': 'Test entry 1',
            'visible': False,
            'type': 'string',
            'help': '',
        },
        {
            'name': 'TEST_ENTRY2',
            'prompt': 'Test entry 2',
            'visible': True,
            'type': 'bool',
            'help': 'This is a help text',
        },
        {
            'name': 'TEST_ENTRY3',
            'prompt': 'Test entry 3',
            'visible': True,
            'type': 'bool',
            'help': '',
        },
    ]


def test_code_action():
    test_parse_context()

    rsp = request(
        'textDocument/codeAction', {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
            },
            'range': {
                'start': {
                    'line': 0,
                    'character': 0,
                },
                'end': {
                    'line': 3,
                    'character': 0,
                }
            },
        })

    assert rsp.error == None
    assert [r['title'] for r in rsp.result] == [
        'Enable CONFIG_TEST_ENTRY2 to resolve dependency', 'Remove entry', 'Remove entry'
    ]


def test_no_contexts():
    test_init()
    commands = [
        'textDocument/completion',
        'textDocument/codeAction',
        'textDocument/hover',
        'textDocument/documentSymbol',
    ]
    for cmd in commands:
        rsp = request(
            cmd,
            {
                'textDocument': {
                    # File exists, but there's no matching context:
                    'uri': str(Uri.file(path.join(zephyr_root, 'Kconfig')))
                },
                'position': Position(5, 5).__dict__,
            })
        # This should just fail silently.
        # Errors should only be reported for critical failures.
        assert rsp.error == None
        assert not rsp.result  # Should be falsy, like None or an empty array


def test_unknown_docs():
    test_parse_context()
    commands = [
        'textDocument/completion',
        'textDocument/codeAction',
        'textDocument/hover',
        'textDocument/documentSymbol',
    ]
    for cmd in commands:
        rsp = request(
            cmd, {
                'textDocument': {
                    'uri': str(Uri.file(path.join(zephyr_root, 'non_existent_file')))
                },
                'position': Position(5, 5).__dict__,
            })
        # This should just fail silently.
        # Errors should only be reported for critical failures.
        assert rsp.error == None
        assert not rsp.result  # Should be falsy, like None or an empty array


def test_change_triggering_reparse():
    test_parse_context()

    notifications.clear()
    notify(
        'textDocument/didChange', {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf'))),
                'version': 1,
            },
            'contentChanges': [{
                'range': {
                    'start': {
                        'line': 0,
                        'character': 0,
                    },
                    'end': {
                        'line': 3,
                        'character': 0,
                    }
                },
                'text': 'CONFIG_TEST_ENTRY2=y'
            }]
        })
    diags = [n.params for n in notifications if n.method == 'textDocument/publishDiagnostics']
    assert len(diags) == 3

    # Should remove all errors:
    for d in diags:
        assert len(d['diagnostics']) == 0


def test_parser_errors():
    test_parse_context()

    notifications.clear()
    notify(
        'textDocument/didChange',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf'))),
                'version': 2,
            },
            'contentChanges': [{
                'range': {
                    'start': {
                        'line': 0,
                        'character': 0,
                    },
                    'end': {
                        'line': 0,
                        'character': 0,
                    }
                },
                'text': 'INVALID_TOKEN\n'  # Invalid
            }]
        })

    diags = [n.params for n in notifications if n.method == 'textDocument/publishDiagnostics']
    assert len(diags) == 3
    conf_diags = next(d for d in diags
                      if d['uri'] == str(Uri.file(path.join(zephyr_root, 'prj.conf'))))
    # Diags from kconfiglib are added at the end:
    assert conf_diags['diagnostics'][-1]['message'] == "ignoring malformed line 'INVALID_TOKEN'"
    assert conf_diags['diagnostics'][-1]['severity'] == Diagnostic.WARNING

    # Failures in the Kconfig tree will block everything else:
    notify(
        'textDocument/didChange',
        {
            'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'Kconfig'))),
                'version': 2,
            },
            'contentChanges': [{
                'range': {
                    'start': {
                        'line': 0,
                        'character': 0,
                    },
                    'end': {
                        'line': 0,
                        'character': 0,
                    }
                },
                'text': 'INVALID_TOKEN\n'  # Invalid
            }]
        })

    # Must trigger file watcher to mark file invalid
    notify(
        'workspace/didChangeWatchedFiles', {
            'changes': [{
                'uri': str(Uri.file(path.join(zephyr_root, 'Kconfig'))),
                'type': FileChangeKind.CHANGED
            }]
        })

    # Trigger reparse:
    notifications.clear()
    request('textDocument/completion',
            {'textDocument': {
                'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf'))),
            }})

    # This is a critical error, which blocks everthing else:
    diags = next(n.params['diagnostics'] for n in notifications
                 if n.method == 'textDocument/publishDiagnostics'
                 and n.params['uri'] == str(Uri.file(path.join(zephyr_root, 'Kconfig'))))
    assert len(diags) == 1
    assert diags[0]['severity'] == Diagnostic.ERROR


def test_set_val():
    test_parse_context()

    rsp = request('kconfig/search', {'query': 'TEST_ENTRY1'})
    assert rsp.result['symbols'][0]['name'] == 'TEST_ENTRY1'

    # invisible because TEST_ENTRY2 (which this depends on) is false
    assert not rsp.result['symbols'][0]['visible']

    notify('kconfig/setVal', {'name': 'TEST_ENTRY2', 'val': 'y'})

    # No longer invisible, since dependency has been resolved:
    assert request('kconfig/search', {'query': 'TEST_ENTRY1'}).result['symbols'][0]['visible']

    # Clear value:
    notify('kconfig/setVal', {'name': 'TEST_ENTRY2'})

    # Invisible again:
    assert not request('kconfig/search', {'query': 'TEST_ENTRY1'}).result['symbols'][0]['visible']


def test_remove_build():
    test_parse_context()

    notify('kconfig/removeBuild', {
        'uri': str(Uri.file(build_folder)),
    })

    rsp = request('textDocument/documentSymbol',
                  {'textDocument': {
                      'uri': str(Uri.file(path.join(zephyr_root, 'prj.conf')))
                  }})
    assert rsp.error == None
    assert not rsp.result  # Should no longer find the context
