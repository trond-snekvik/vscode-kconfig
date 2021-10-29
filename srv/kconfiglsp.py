# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

from typing import Optional, List, Dict
import kconfiglib as kconfig
import sys
import os
import re
import enum
import argparse
from rpc import handler, RPCError
from lsp import (CodeAction, CompletionItemKind, Diagnostic, DiagnosticRelatedInfo, DocumentSymbol,
                 FileChangeKind, InsertTextFormat, LSPServer, MarkupContent, Position, Location,
                 Snippet, SymbolInformation, SymbolKind, TextEdit, Uri, TextDocument, Range,
                 documentStore)

VERSION = '1.0'

#################################################################################################################################
# Kconfig LSP Server
#################################################################################################################################

# Environment variables passed to menuconfig:
# - ZEPHYR_BASE
# - ZEPHYR_TOOLCHAIN_VARIANT -> default to "zephyr"
# - PYTHON_EXECUTABLE
# - srctree=${ZEPHYR_BASE}
# - KERNELVERSION from ./VERSION, as a hex number, see version.cmake
# - KCONFIG_CONFIG=${PROJECT_BINARY_DIR}/.config
# - ARCH
# - ARCH_DIR
# - BOARD_DIR
# - SHIELD_AS_LIST
# - KCONFIG_BINARY_DIR=${CMAKE_BINARY_DIR}/Kconfig
# - TOOLCHAIN_KCONFIG_DIR -> default to ${TOOLCHAIN_ROOT}/cmake/toolchain/${ZEPHYR_TOOLCHAIN_VARIANT}
# - EDT_PICKLE
# - ZEPHYR_{modules}_MODULE_DIR -> get from west?
# - EXTRA_DTC_FLAGS -> Appear to be unused
# - DTS_POST_CPP -> ${PROJECT_BINARY_DIR}/${BOARD}.dts.pre.tmp
# - DTS_ROOT_BINDINGS -> ${DTS_ROOTs}/dts/bindings

KCONFIG_WARN_LVL = Diagnostic.WARNING
ID_SEP = '@'


class KconfigErrorCode(enum.IntEnum):
    """Set of Kconfig specific error codes reported in response to failing requests"""
    UNKNOWN_NODE = 1  # The specified node is unknown.
    # The kconfig data has been changed, and the menu tree is out of sync.
    DESYNC = 2
    PARSING_FAILED = 3  # Kconfig tree couldn't be parsed.


class Kconfig(kconfig.Kconfig):
    def __init__(self, filename='Kconfig'):
        """
        Wrapper of kconfiglib's Kconfig object.

        Overrides the diagnostics mechanism to keep track of them in a dict instead
        of writing them to stdout.

        Overrides the _open function to inject live editor data from the documentStore.
        """
        self.diags: Dict[str, List[Diagnostic]] = {}
        self.warn_assign_undef = True
        self.warn_assign_override = True
        self.warn_assign_redun = True
        self.filename = filename
        self.valid = False

    def parse(self):
        """
        Parse the kconfig tree.

        This is split out from the constructor to avoid nixing the whole object on parsing errors.
        """
        self.valid = False
        self._init(self.filename, True, False, 'utf-8')
        if self.unique_defined_syms:
            self.valid = True

    def loc(self):
        if self.filename and self.linenr != None:
            return Location(Uri.file(os.path.join(self.srctree, self.filename)),
                            Range(Position(self.linenr - 1, 0), Position(self.linenr - 1, 99999)))

    # Overriding _open to work on virtual file storage when required:
    def _open(self, filename, mode):
        # Read from document store, but don't create an entry if it doesn't exist:
        doc = documentStore.get(Uri.file(filename), create=False)
        if doc:
            doc.open(mode)
            return doc
        if os.path.isdir(filename):
            raise kconfig.KconfigError(
                f'Attempting to open directory {filename} as file @{self.filename}:{self.linenr}')
        return super()._open(filename, mode)

    def _warn(self, msg: str, filename=None, linenr=None):
        super()._warn(msg, filename, linenr)
        if not filename:
            filename = ''
        if not linenr:
            linenr = 1

        ignored_diags = ['set more than once.']

        if len([ignore for ignore in ignored_diags if ignore in msg]) > 0:
            # Ignore this diagnostic. It is either too verbose, or already covered by some
            # manual check.
            return

        if not filename in self.diags:
            self.diags[filename] = []

        # Strip out potentially very long definition references.
        # They're redundant, since the user can ctrl+click on the symbol to interactively find them.
        msg = re.sub(r'\s*\(defined at.*?\)\s*', ' ', msg)

        self.diags[filename].append(
            Diagnostic(msg,
                       Position(int(linenr - 1), 0).range, KCONFIG_WARN_LVL))


def _prompt(sym: kconfig.Symbol, ignore_expr=False):
    """
    Get the most accessible prompt for a given kconfig Symbol.

    Each symbol may have multiple prompts (as it may be defined in several kconfig files).
    Pick the first valid prompt.

    This'll only consider prompts whose if expressions are true.
    """
    for node in sym.nodes:
        if node.prompt and (ignore_expr or kconfig.expr_value(node.prompt[1])):
            return node.prompt[0]


def _visible(node):
    """Check whether a node is visible."""
    return node.prompt and kconfig.expr_value(node.prompt[1]) and not \
        (node.item == kconfig.MENU and not kconfig.expr_value(node.visibility))


def _children(node):
    """Get the child nodes of a given MenuNode"""
    def get_children(node):
        children = []
        node = node.list
        while node:
            children.append(node)
            node = node.next
        return children

    if isinstance(node.item, kconfig.Choice):
        # Choices may be appended to in multiple locations.
        # For ease of use, gather all options added to this choice, so users
        # can see all valid option in every location.
        # See menuconfig.py's _shown_nodes for additional info.
        choice: kconfig.Choice = node.item
        children = []
        # Gather the current node's symbols first, so those are preferred when the symbol
        # is added in multiple places:
        symbols = {n.item for n in get_children(node) if isinstance(n, kconfig.Symbol)}

        for choice_node in choice.nodes:
            for child in get_children(choice_node):
                if not isinstance(child.item, kconfig.Symbol):
                    children.append(child)
                elif child.item not in symbols or choice_node is node:
                    children.append(child)
                    # Only show each symbol once:
                    symbols.add(child.item)

        return children

    return get_children(node)


def _suboption_depth(node):
    """In menuconfig, nodes that aren't children of menuconfigs are rendered
       in the same menu, but indented. Get the depth of this indentation.
    """
    parent = node.parent
    depth = 0
    while not parent.is_menuconfig:
        depth += 1
        parent = parent.parent
    return depth


def _loc(sym: kconfig.Symbol):
    """Get a list of locations where the given kconfig symbol is defined"""
    return [
        Location(Uri.file(os.path.join(n.kconfig.srctree, n.filename)),
                 Position(n.linenr - 1, 0).range) for n in sym.nodes
    ]


def _symbolitem(sym: kconfig.Symbol):
    item = {
        'name': sym.name,
        'prompt': _prompt(sym, True),
        'visible': sym.visibility > 0,
        'type': kconfig.TYPE_TO_STR[sym.type],
        'help': next((n.help for n in sym.nodes if n.help), '')
    }

    prompt = _prompt(sym)
    if prompt:
        item['prompt'] = prompt
    return item


def _filter_match(filter: str, name: str):
    """Filter match function used for narrowing lists in searches and autocompletions"""
    return name.startswith(filter)  # TODO: implement fuzzy match?


def _missing_deps(sym):
    """
    Get a list of the dependency expressions that fail for a symbol
    """
    deps = kconfig.split_expr(sym.direct_dep, kconfig.AND)
    return [dep for dep in deps if kconfig.expr_value(dep) == 0]


class KconfigMenu:
    def __init__(self, ctx, node: kconfig.MenuNode, id, show_all):
        """
        A single level in a Menuconfig menu.
        """
        self.ctx = ctx
        self.node = node
        self.id = id
        self.show_all = show_all

    @property
    def name(self):
        return self.node.prompt[0]

    def _menuitem(self, node: kconfig.MenuNode):
        sym = node.item
        item = {
            'visible':
            _visible(node) != 0,
            'loc':
            Location(Uri.file(os.path.join(self.ctx.env['ZEPHYR_BASE'], node.filename)),
                     Position(node.linenr - 1, 0).range),
            'isMenu':
            node.is_menuconfig,
            'hasChildren':
            node.list != None or isinstance(sym, kconfig.Choice),
            'depth':
            _suboption_depth(node),
            'id':
            self.ctx._node_id(node),
        }

        if node.prompt:
            item['prompt'] = node.prompt[0]

        if hasattr(node, 'help') and node.help:
            item['help'] = node.help

        if isinstance(sym, kconfig.Symbol):
            item['type'] = kconfig.TYPE_TO_STR[sym.orig_type]
            item['val'] = sym.str_value
            item['userValue'] = sym.user_value
            item['name'] = sym.name
            if hasattr(sym, 'assignable') and sym.assignable:
                item['options'] = list(sym.assignable)
            item['kind'] = 'symbol'
        elif isinstance(sym, kconfig.Choice):
            item['type'] = kconfig.TYPE_TO_STR[sym.type]
            item['val'] = _prompt(sym.selection)
            item['userValue'] = sym.user_value
            item['name'] = sym.name
            item['kind'] = 'choice'
        elif sym == kconfig.COMMENT:
            item['kind'] = 'comment'
        elif sym == kconfig.MENU:
            item['kind'] = 'menu'
        else:
            item['kind'] = 'unknown'

        return item

    @property
    def items(self):
        """The list of MenuItems this menu presents."""
        return [
            self._menuitem(node) for node in _children(self.node)
            if self.show_all or (node.prompt and _visible(node))
        ]

    def to_dict(self):
        return {
            'name': self.name,
            'id': self.id,
            'items': self.items,
        }


class ConfEntry:
    def __init__(self, name: str, loc: Location, assignment: str, value_range: Range):
        """
        Single configuration entry in a prj.conf file, like CONFIG_ABC=y
        """
        self.name = name
        self.loc = loc
        self.raw = assignment.strip()
        self.value_range = value_range

    @property
    def range(self):
        """Range of the name text, ie CONFIG_ABC"""
        return self.loc.range

    def __eq__(self, o: object) -> bool:
        if not isinstance(o, ConfEntry):
            return False
        return self.loc == o.loc

    @property
    def full_range(self):
        """Range of the entire assignment, ie CONFIG_ABC=y"""
        return Range(self.range.start, self.value_range.end)

    def is_string(self):
        return self.raw.startswith('"') and self.raw.endswith('"')

    def is_bool(self):
        return self.raw in ['y', 'n']

    def is_hex(self):
        return re.match(r'0x[a-fA-F\d]+', self.raw)

    def is_int(self):
        return re.match(r'\d+', self.raw)

    @property
    def value(self):
        """Value assigned in the entry, as seen by kconfig"""
        if self.is_string():
            return self.raw[1:-1]  # strip out quotes
        if self.is_bool():
            return self.raw
        if self.is_hex():
            return int(self.raw, 16)
        if self.is_int():
            return int(self.raw)

    @property
    def type(self):
        """Human readable entry type, derived from the assigned value."""
        if self.is_string():
            return kconfig.TYPE_TO_STR[kconfig.STRING]
        if self.is_hex():
            return kconfig.TYPE_TO_STR[kconfig.HEX]
        if self.is_int():
            return kconfig.TYPE_TO_STR[kconfig.INT]
        if self.is_bool():
            return kconfig.TYPE_TO_STR[kconfig.BOOL]

        return kconfig.TYPE_TO_STR[kconfig.UNKNOWN]

    @property
    def line_range(self):
        """Entire line range."""
        return Range(Position(self.range.start.line, 0), Position(self.range.start.line + 1, 0))

    def remove(self, title='Remove entry') -> CodeAction:
        """Create a code action that will remove this entry"""
        action = CodeAction(title)
        action.edit.add(self.loc.uri, TextEdit.remove(self.line_range))
        return action


class ConfFile:
    def __init__(self, uri: Uri):
        """
        Single .conf file.

        Each Kconfig context may contain a list of conf files that must be parsed.
        The .conf file does not parse or understand the entry names and their interpreted value.
        """
        self.uri = uri
        self.diags: List[Diagnostic] = []

    @property
    def doc(self) -> TextDocument:
        """The TextDocument this file represents"""
        return documentStore.get(self.uri)

    def entries(self) -> List[ConfEntry]:
        """The ConfEntries in this file"""
        entries = []
        for linenr, line in enumerate(self.doc.lines):
            match = re.match(r'^\s*(CONFIG_(\w+))\s*\=("[^"]+"|\w+)', line)
            if match:
                range = Range(Position(linenr, match.start(1)), Position(linenr, match.end(1)))
                value_range = Range(Position(linenr, match.start(3)),
                                    Position(linenr, match.end(3)))
                entries.append(ConfEntry(match[2], Location(self.uri, range), match[3],
                                         value_range))
        return entries

    def find(self, name) -> List[ConfEntry]:
        """Find all ConfEntries that configure a symbol with the given name."""
        return [entry for entry in self.entries() if entry.name == name]

    def __repr__(self):
        return str(self.uri)


class BoardConf:
    def __init__(self, name, arch, dir):
        """Board configuration object, representing a single Zephyr board"""
        self.name = name
        self.arch = arch
        self.dir = dir

    @property
    def conf_file(self):
        """Get the path of the conf file that must be included when building with this board"""
        return ConfFile(Uri.file(os.path.join(self.dir, self.name + '_defconfig')))


class KconfigContext:
    def __init__(self, uri: Uri, root, conf_files: List[ConfFile] = [], env={}):
        """A single instance of a kconfig compilation.
        Represents one configuration of one application, equalling a single
        build in Zephyr.
        """
        self.uri = uri
        self.env = env
        self.conf_files = conf_files
        self.board = BoardConf(env['BOARD'], env['ARCH'], env['BOARD_DIR'])
        self.version = 0
        self._root = root
        self._kconfig: Optional[Kconfig] = None
        self.menu = None
        self.cmd_diags: List[Diagnostic] = []
        self.last_access = 0
        self.kconfig_diags: Dict[str, List[Diagnostic]] = {}

    def initialize_env(self):
        """
        Apply the context environment for the entire process.

        kconfig will access os.environ without a wrapper to
        resolve variables like ZEPHYR_BASE.
        """
        for key, value in self.env.items():
            os.environ[key] = value

        functions_path = os.path.join(self.env['ZEPHYR_BASE'], 'scripts', 'kconfig')
        if not functions_path in sys.path:
            sys.path.append(functions_path)

    def parse(self):
        """
        Parse the full kconfig tree.
        Will set up the environment and invoke kconfig to parse the entire kconfig
        file tree. This is only necessary to do once - or if any files in the Kconfig
        file tree changes.

        Throws kconfig errors if the tree can't be parsed.
        """
        self.menu = None
        self.modified = {}
        self.clear_diags()
        self.initialize_env()

        self._kconfig = Kconfig(self._root)

        try:
            self._kconfig.parse()
        except kconfig.KconfigError as e:
            loc = self._kconfig.loc()

            # Strip out the GCC-style location indicator that is placed on the start of the
            # error message for some messages:
            match = re.match(r'(^[\w\/\\-]+:\d+:\s*)?(error:)?\s*(.*)', str(e))
            if match:
                msg = match[3]
            else:
                msg = str(e)

            if loc:
                self.kconfig_diag(loc.uri, Diagnostic.err(msg, loc.range))
            else:
                self.cmd_diags.append(Diagnostic.err(msg, Range(Position.start(),
                                                                Position.start())))
        except Exception as e:
            self.cmd_diags.append(
                Diagnostic.err('Kconfig failed: ' + str(e), Range(Position.start(),
                                                                  Position.start())))
        self.version += 1

    def kconfig_diag(self, uri: Uri, diag: Diagnostic):
        if not str(uri) in self.kconfig_diags:
            self.kconfig_diags[str(uri)] = []
        self.kconfig_diags[str(uri)].append(diag)

    @property
    def valid(self):
        return self._kconfig != None and self._kconfig.valid

    def invalidate(self):
        if self._kconfig:
            self._kconfig.valid = False

    @property
    def all_conf_files(self):
        """All configuration files going into this build. Includes the board conf file."""
        return [self.board.conf_file, *self.conf_files]

    def has_file(self, uri: Uri):
        """Check whether the given URI represents a conf file this context uses. Does not check board files."""
        return any([(file.uri == uri) for file in self.all_conf_files])

    def _node_id(self, node: kconfig.MenuNode):
        """Encode a unique ID string for the given menu node"""
        if not self._kconfig:
            return ''

        if node == self._kconfig.top_node:
            parts = ['MAINMENU']
        elif node.item == kconfig.MENU:
            parts = ['MENU', str(self._kconfig.menus.index(node))]
        elif isinstance(node.item, kconfig.Symbol):
            parts = ['SYM', node.item.name, str(node.item.nodes.index(node))]
        elif isinstance(node.item, kconfig.Choice):
            parts = [
                'CHOICE',
                str(self._kconfig.choices.index(node.item)),
                str(node.item.nodes.index(node))
            ]
        elif node.item == kconfig.COMMENT:
            parts = ['COMMENT', str(self._kconfig.comments.index(node))]
        else:
            parts = ['UNKNOWN', node.filename, str(node.linenr)]

        parts.insert(0, str(self.version))

        return ID_SEP.join(parts)

    def find_node(self, id):
        """Find a menu node based on a node ID"""
        [version, type, *parts] = id.split(ID_SEP)

        if int(version) != self.version:
            # Since we're building on the exact layout of the internals of the
            # kconfig tree, the node IDs depend on the fact that the tree is unchanged:
            return None

        if type == 'MENU':
            return self._kconfig.menus[int(parts[0])]

        if type == 'SYM':
            return self._kconfig.syms[parts[0]].nodes[int(parts[1])]

        if type == 'CHOICE':
            return self._kconfig.choices[int(parts[0])].nodes[int(parts[1])]

        if type == 'COMMENT':
            return self._kconfig.comments[int(parts[0])]

        if type == 'MAINMENU':
            return self._kconfig.top_node

    def get_menu(self, id=None, show_all=False):
        """Get the KconfigMenu for the menu node with the given ID"""
        if not self.valid:
            return
        if id:
            node = self.find_node(id)
        else:
            node = self._kconfig.top_node
            id = self._node_id(node)

        if not node:
            return
        return KconfigMenu(self, node, id, show_all)

    def set(self, name, val):
        """Set a config value (without changing the conf files)"""
        sym = self.get(name)
        if not sym:
            raise RPCError(KconfigErrorCode.UNKNOWN_NODE, 'Unknown symbol {}'.format(name))
        valid = sym.set_value(val)
        if valid and not name in self.modified:
            self.modified.append(name)

    def unset(self, name):
        """Revert a previous self.set() call."""
        sym = self.get(name)
        if sym:
            sym.unset_value()

    def get(self, name) -> Optional[kconfig.Symbol]:
        """Get a kconfig symbol based on its name. The name should NOT include the CONFIG_ prefix."""
        if self._kconfig:
            return self._kconfig.syms.get(name)
        return None

    def conf_file(self, uri):
        """Get the config file with the given URI, if any."""
        return next((file for file in self.all_conf_files if file.uri == uri), None)

    def diags(self, uri):
        """Get the diagnostics for the conf file with the given URI"""
        conf = self.conf_file(uri)
        if conf:
            return conf.diags

    def clear_diags(self):
        """Clear all diagnostics"""
        if self._kconfig:
            self._kconfig.diags.clear()
        for list in self.kconfig_diags.values():
            list.clear()

        self.cmd_diags.clear()
        for conf in self.all_conf_files:
            conf.diags.clear()

    def symbols(self, filter):
        """Get a list of symbols matching the given filter string. Can be used for search or auto completion."""
        if filter and filter.startswith('CONFIG_'):
            filter = filter[len('CONFIG_'):]
        return [
            sym for sym in self._kconfig.syms.values()
            # Literal values are also symbols, but can be filtered out by checking sym.nodes
            # which only exists if this is a proper config symbol:
            if hasattr(sym, 'nodes') and len(sym.nodes) and (
                not filter or _filter_match(filter, sym.name))
        ]

    def symbol_search(self, query):
        """Search for a symbol with a specific name. Returns a list of symbols as SymbolItems."""
        return [_symbolitem(sym) for sym in self.symbols(query)]

    def all_entries(self) -> List[ConfEntry]:
        entries = []
        for file in self.all_conf_files:
            entries.extend(file.entries())
        return entries

    # Link checks for config file entries:

    def check_undefined(self, file: ConfFile, entry: ConfEntry, sym: kconfig.Symbol):
        if sym.type == kconfig.UNKNOWN:
            file.diags.append(
                Diagnostic.err(f'Undefined symbol CONFIG_{sym.name}', entry.full_range))
            return True

    def check_type(self, file: ConfFile, entry: ConfEntry, sym: kconfig.Symbol):
        """Check that the configured value has the right type."""
        if kconfig.TYPE_TO_STR[sym.type] != entry.type:
            diag = Diagnostic.err(f'Invalid type. Expected {kconfig.TYPE_TO_STR[sym.type]}',
                                  entry.full_range)

            # Add action to convert between hex and int:
            if sym.type in [kconfig.HEX, kconfig.INT] and (entry.is_hex() or entry.is_int()):
                action = CodeAction('Convert value to ' + str(kconfig.TYPE_TO_STR[sym.type]))
                if sym.type == kconfig.HEX:
                    action.edit.add(entry.loc.uri, TextEdit(entry.value_range, hex(entry.value)))
                else:
                    action.edit.add(entry.loc.uri, TextEdit(entry.value_range, str(entry.value)))
                diag.add_action(action)

            file.diags.append(diag)
            return True

    def check_assignment(self, file: ConfFile, entry: ConfEntry, sym: kconfig.Symbol):
        """Check that the assigned value actually was propagated."""
        user_value = sym.user_value
        if sym.type in [kconfig.BOOL, kconfig.TRISTATE]:
            user_value = kconfig.TRI_TO_STR[user_value]

        actions = []
        if user_value == sym.str_value:
            if user_value == 'y':
                return
            msg = f'CONFIG_{sym.name} was already disabled.'
            severity = Diagnostic.HINT
        elif len(sym.str_value):
            msg = f'CONFIG_{sym.name} was assigned the value {entry.raw}, but got the value {sym.str_value}.'
            severity = Diagnostic.WARNING
        else:
            msg = f'CONFIG_{sym.name} couldn\'t be set.'
            severity = Diagnostic.WARNING

        deps = _missing_deps(sym)
        if deps:
            msg += ' Missing dependencies:\n'
            msg += ' && '.join([kconfig.expr_str(dep) for dep in deps])
            edits = []

            for dep in deps:
                if isinstance(dep, kconfig.Symbol) and dep.type == kconfig.BOOL:
                    dep_entry = next((entry for entry in file.entries() if entry.name == dep.name),
                                     None)
                    if dep_entry:
                        edits.append({
                            'dep': dep.name,
                            'edit': TextEdit(dep_entry.value_range, 'y')
                        })
                    else:
                        edits.append({
                            'dep':
                            dep.name,
                            'edit':
                            TextEdit(Range(entry.line_range.start, entry.line_range.start),
                                     f'CONFIG_{dep.name}=y\n')
                        })

            if len(edits) == 1:
                action = CodeAction(f'Enable CONFIG_{edits[0]["dep"]} to resolve dependency')
                action.edit.add(file.uri, edits[0]['edit'])
                actions.append(action)
            elif len(edits) > 1:
                action = CodeAction(f'Enable {len(edits)} entries to resolve dependencies')

                # Dependencies are registered with a "nearest first" approach in kconfig.
                # As the nearest dependency is likely lowest in the menu hierarchy, we'll
                # reverse the list of edits, so the highest dependency is inserted first:
                edits.reverse()

                for edit in edits:
                    action.edit.add(file.uri, edit['edit'])
                actions.append(action)

            actions.append(entry.remove())

            diag = Diagnostic(msg, entry.range, severity)
            if severity == Diagnostic.HINT:
                diag.mark_unnecessary()
            for action in actions:
                diag.add_action(action)

            file.diags.append(diag)
            return True

    def check_visibility(self, file: ConfFile, entry: ConfEntry, sym: kconfig.Symbol):
        """Check whether the configuration entry actually can be set in config files."""
        if not any(node.prompt for node in sym.nodes):
            diag = Diagnostic.warn(f'Symbol CONFIG_{entry.name} cannot be set (has no prompt)',
                                   entry.full_range)
            diag.add_action(entry.remove())
            file.diags.append(diag)
            return True

    def check_defaults(self, file: ConfFile, entry: ConfEntry, sym: kconfig.Symbol):
        """Check whether an entry's value matches the default value, and mark it as redundant"""
        if sym._str_default() == sym.user_value:
            diag = Diagnostic.hint(f'Value is {entry.raw} by default', entry.full_range)
            diag.mark_unnecessary()
            diag.add_action(entry.remove('Remove redundant entry'))
            file.diags.append(diag)
            return True

    def check_multiple_assignments(self, file: ConfFile, entry: ConfEntry,
                                   all_entries: List[ConfEntry]):
        matching = [e for e in all_entries if e.name == entry.name]
        if len(matching) > 1 and matching[0] != entry:
            existing = matching[0]
            diag = Diagnostic.warn(
                f'{entry.name} set more than once. Old value "{existing.value}", new value "{entry.value}".',
                entry.full_range)
            diag.related_info = [
                DiagnosticRelatedInfo(e.loc, f'Already set to "{e.value}" here') for e in matching
                if e != entry
            ]
            if existing.value == entry.value:
                diag.mark_unnecessary()
                diag.severity = Diagnostic.HINT
                diag.add_action(entry.remove('Remove redundant entry'))
            file.diags.append(diag)
            return True

    def lint(self):
        """
        Run a set of checks on the contents of the conf files.

        Adds diagnostics to the failing entries to help developers fix errors
        that will come up when compiling. Reimplements some checks from
        generate_config.py that show up during the build, as these aren't
        part of kconfig.
        """
        all_entries = self.all_entries()
        for file in self.conf_files:
            entries = file.entries()
            for entry in entries:
                if not entry.name in self._kconfig.syms:
                    continue

                sym: kconfig.Symbol = self._kconfig.syms[entry.name]
                if self.check_undefined(file, entry, sym):
                    continue
                if self.check_type(file, entry, sym):
                    continue
                if self.check_assignment(file, entry, sym):
                    continue
                if self.check_visibility(file, entry, sym):
                    continue
                if self.check_defaults(file, entry, sym):
                    continue
                if self.check_multiple_assignments(file, entry, all_entries):
                    continue

    def load_config(self):
        """Load configuration files and update the diagnostics"""
        if not self.valid:
            pass

        try:
            self._kconfig.load_config(self.board.conf_file.uri.path, replace=True)

            for file in self.conf_files:
                self._kconfig.load_config(file.uri.path, replace=False)

            self.lint()

            for filename, diags in self._kconfig.diags.items():
                if filename == '':
                    self.cmd_diags.extend(diags)
                else:
                    uri = Uri.file(filename)
                    conf = self.conf_file(uri)
                    if conf:
                        conf.diags.extend(diags)
                    else:
                        self.cmd_diags.extend(diags)
        except AttributeError as e:
            self.cmd_diags.append(
                Diagnostic.err('Kconfig tree parse failed: Invalid attribute ' + str(e),
                               Range(Position.start(), Position.start())))
        except Exception as e:
            self.cmd_diags.append(
                Diagnostic.err('Kconfig tree parse failed: ' + str(e),
                               Range(Position.start(), Position.start())))

    def symbol_at(self, uri: Uri, pos):
        """Get the symbol referenced at a given position in a conf file."""
        doc = documentStore.get(uri)
        if not doc:
            return

        word = doc.word_at(pos)
        if word:
            if re.match(r'Kconfig.*', uri.basename):
                return self.get(word)

            if word.startswith('CONFIG_'):
                return self.get(word[len('CONFIG_'):])

    def __repr__(self):
        return str(self.uri)


class KconfigServer(LSPServer):
    def __init__(self, istream=None, ostream=None):
        """
        The Kconfig LSP Server.

        The LSP Server should be instantiated once for each IDE instance, and is capable of
        handling multiple different Kconfig contexts using create_ctx().

        To run a kconfig server, instantiate it and call loop():
        KconfigServer().loop()

        This will keep running until KconfigServer.running is false.
        """
        super().__init__('zephyr-kconfig', VERSION, istream, ostream)
        self.main_uri = None
        self.access_count = 0
        self.ctx: Dict[str, KconfigContext] = {}
        self.dbg('Python version: ' + sys.version)

    def publish_diags(self, uri, diags: List[Diagnostic]):
        """Send a diagnostics publication notification"""
        self.notify('textDocument/publishDiagnostics', {
            'uri': uri,
            'diagnostics': diags,
        })

    def refresh_ctx(self, ctx: KconfigContext):
        """Reparse the given Kconfig context, and publish diagsnostics"""
        ctx.clear_diags()
        if not ctx.valid:
            self.dbg('Parsing...')
            ctx.parse()

        if ctx.valid:
            self.dbg('Load config...')
            ctx.load_config()

            self.dbg('Done. {} diags, {} warnings'.format(
                sum([len(file.diags) for file in ctx.all_conf_files]),
                len(ctx._kconfig.warnings if ctx._kconfig else 0)))

        for conf in ctx.all_conf_files:
            self.publish_diags(conf.uri, conf.diags)

        self.publish_diags(Uri.file('command-line'), ctx.cmd_diags)

        for uri, diags in ctx.kconfig_diags.items():
            self.publish_diags(uri, diags)

    def create_ctx(self, uri: Uri, root, conf_files, env):
        """
        Create a Kconfig Context with the given parameters.

        A context represents a single build directory.
        """
        self.dbg(f'Creating context {uri}')
        ctx = KconfigContext(uri, root, conf_files, env)

        self.ctx[str(uri)] = ctx
        return ctx

    def sorted_contexts(self):
        return sorted(self.ctx.values(), key=lambda ctx: ctx.last_access)

    @property
    def last_ctx(self):
        """Get most recent context"""
        return [None, *self.sorted_contexts()].pop()

    def best_ctx(self, uri: Uri):
        """
        Get the context that is the most likely owner of the given URI.

        Keeps track of the currently referenced context, and will prefer
        this if it owns the given URI.
        """
        is_conf_file = uri.basename.endswith('.conf')

        ctx = self.ctx.get(str(self.main_uri))
        if ctx:
            if not is_conf_file or ctx.has_file(uri):
                self.access_count += 1
                ctx.last_access = self.access_count
                return ctx

        # Candidate contexts are all contexts that has the file:
        def has_uri(ctx):
            if is_conf_file:
                return ctx.has_file(uri)
            return True

        # Get most recent candidate:
        ctx = [None, *[c for c in self.sorted_contexts() if has_uri(c)]].pop()

        if ctx:
            self.access_count += 1
            ctx.last_access = self.access_count

        return ctx

    def get_sym(self, params):
        """
        Get the symbol located at the given Location.
        Interprets location from a common location parameter format:
        - textDocument.uri -> URI
        - position -> Position
        """
        uri = Uri.parse(params['textDocument']['uri'])
        ctx = self.best_ctx(uri)
        if not ctx:
            self.dbg('No context for {}'.format(uri.path))
            return

        if not ctx.valid:
            self.refresh_ctx(ctx)

        return ctx.symbol_at(uri, Position.create(params['position']))

    @handler('initialized')
    def handle_initialized(self, params):
        self.watch_files('**/Kconfig*')
        self.watch_files('**/edt.pickle')

    @handler('kconfig/addBuild')
    def handle_add_build(self, params):
        uri = Uri.parse(params['uri'])
        if uri:
            confFiles = [ConfFile(Uri.file(f)) for f in params['conf']]
            ctx = self.create_ctx(uri, params['root'], confFiles, params['env'])

            # This is the active build. Parse it right away:
            if uri == self.main_uri:
                self.refresh_ctx(ctx)
            return {'id': ctx.uri}

    @handler('kconfig/removeBuild')
    def handle_remove_build(self, params):
        uri = Uri.parse(params['uri'])
        if self.ctx.get(str(uri)):
            del self.ctx[str(uri)]
            self.dbg('Deleted build ' + str(uri))

    @handler('kconfig/setMainBuild')
    def handle_set_build(self, params):
        uri = Uri.parse(params['uri'])
        self.main_uri = uri
        ctx = self.ctx.get(str(self.main_uri))
        if ctx:
            self.dbg(f'Main build: {uri}')
            self.dbg('\t' + "\n\t".join([str(f) for f in ctx.conf_files]))
            self.refresh_ctx(ctx)

    def get_ctx(self, id):
        """Get context from ID, or fall back to other contexts."""
        if id:
            return self.ctx.get(id)
        if self.main_uri:
            return self.ctx.get(str(self.main_uri))
        return self.last_ctx

    @handler('kconfig/search')
    def handle_search(self, params):
        ctx = self.get_ctx(params.get('ctx'))
        if not ctx:
            return

        return {
            'ctx': str(ctx.uri),
            'query': params['query'],
            'symbols': ctx.symbol_search(params['query']),
        }

    @handler('textDocument/didChange')
    def handle_change(self, params):
        super().handle_change(params)
        if self.last_ctx:
            self.refresh_ctx(self.last_ctx)

    @handler('kconfig/getMenu')
    def handle_get_menu(self, params):
        ctx = self.get_ctx(params.get('ctx'))
        if not ctx:
            return

        if not ctx.valid:
            self.refresh_ctx(ctx)

        show_all = 'options' in params and params['options'].get('showAll')

        return ctx.get_menu(params.get('id'), show_all)

    @handler('kconfig/setVal')
    def handle_setval(self, params):
        ctx = self.get_ctx(params.get('ctx'))
        if not ctx:
            return

        if 'val' in params:
            ctx.set(params['name'], params['val'])
        else:
            ctx.unset(params['name'])

    # @handler('kconfig/getEntry')
    # def handle_getentry(self, params):
    #     pass # TODO: Should get the "help" page for the entry

    @handler('textDocument/completion')
    def handle_completion(self, params):
        uri = Uri.parse(params['textDocument']['uri'])
        ctx = self.best_ctx(uri)
        if not ctx:
            self.dbg('No context for {}'.format(uri.path))
            return

        if not ctx.valid:
            self.refresh_ctx(ctx)
            if not ctx.valid:
                return

        doc = documentStore.get(uri)
        if not doc:
            self.dbg('Unknown document')
            return

        pos = Position.create(params['position'])
        line = doc.line(pos.line)
        show_non_visible = False
        if line:
            prefix = line[:pos.character]
            word = prefix.lstrip()

            if len(word) > 0:
                # Ensure word starts with 'CONFIG_'. By using commonprefix, we can also detect and correct
                # partial matches:
                common = os.path.commonprefix([word, 'CONFIG_'])
                if len(common) < len('CONFIG_'):
                    word = 'CONFIG_' + word[len(common):]
                else:
                    show_non_visible = True

        else:
            word = None

        def insert_text(sym: kconfig.Symbol):
            insert = Snippet('CONFIG_')
            insert.add_text(sym.name)
            insert.add_text('=')
            if sym.type in [kconfig.BOOL, kconfig.TRISTATE]:
                choices = [kconfig.TRI_TO_STR[val] for val in list(sym.assignable)]
                choices.reverse()  # sym.assignable shows 'n' first, but user normally wants 'y'
                insert.add_choice(choices)
            elif sym.type == kconfig.STRING:
                insert.add_text('"')
                insert.add_tabstop()
                insert.add_text('"')
            elif sym.type == kconfig.HEX:
                insert.add_text('0x')
            else:
                pass  # freeform value

            return insert.text

        items = [{
            'label':
            'CONFIG_' + sym.name,
            'kind':
            CompletionItemKind.VARIABLE,
            'detail':
            kconfig.TYPE_TO_STR[sym.type],
            'documentation':
            next((n.help.replace('\n', ' ') for n in sym.nodes if n.help), ' '),
            'insertText':
            insert_text(sym),
            'insertTextFormat':
            InsertTextFormat.SNIPPET
        } for sym in ctx.symbols(word) if sym.visibility or show_non_visible
                 ]  # Only show visible symbols on completion without a prefix

        self.dbg('Filter: "{}" Total symbols: {} Results: {}'.format(word,
                                                                     len(ctx._kconfig.syms.items()),
                                                                     len(items)))
        # When performing a completion request without any prefix, we'll only show the visible symbols.
        # Since we want to start showing users non-visible symbols when they start typing, we need
        # to mark the non-prefixed completion list incomplete to make the client re-requests a new list
        return {'isIncomplete': not show_non_visible, 'items': items}

    @handler('textDocument/definition')
    def handle_definition(self, params):
        sym = self.get_sym(params)
        if sym:
            return _loc(sym)

    @handler('textDocument/hover')
    def handle_hover(self, params):
        uri = Uri.parse(params['textDocument']['uri'])
        ctx = self.best_ctx(uri)
        if not ctx:
            self.dbg('No context for {}'.format(uri.path))
            return

        if not ctx.valid:
            self.refresh_ctx(ctx)

        sym = ctx.symbol_at(uri, Position.create(params['position']))
        if not sym:
            return

        contents = MarkupContent('')

        prompt = _prompt(sym, True)
        if prompt:
            contents.add_text(prompt)

        contents.paragraph()
        contents.add_markdown('Type: `{}`'.format(kconfig.TYPE_TO_STR[sym.type]))
        if len(sym.str_value) > 0:
            contents.linebreak()
            contents.add_markdown('Value: `{}`'.format(sym.str_value))
        contents.paragraph()

        help = '\n\n'.join([n.help.replace('\n', ' ') for n in sym.nodes if n.help])
        if help:
            contents.add_text(help)

        if not uri.basename.endswith('.conf') and len(ctx.conf_files) != 0:
            contents.paragraph()
            contents.add_markdown('_Kconfig environment: [{}]({})_'.format(
                os.path.relpath(ctx.uri.path, os.path.join(ctx.uri.path, '..', '..')),
                ctx.conf_files[0].uri))

        return {'contents': contents}

    @handler('textDocument/documentSymbol')
    def handle_doc_symbols(self, params):
        uri = Uri.parse(params['textDocument']['uri'])
        ctx = self.best_ctx(uri)
        if not ctx:
            return

        file = ctx.conf_file(uri)
        if not file:
            return

        def doc_sym(e: ConfEntry):
            sym = ctx.get(e.name)
            if sym:
                prompt = _prompt(sym, True)
            else:
                prompt = None
            return DocumentSymbol('CONFIG_' + e.name, SymbolKind.PROPERTY, e.full_range, prompt)

        return [doc_sym(e) for e in file.entries()]

    @handler('workspace/symbol')
    def handle_workspace_symbols(self, params):
        query = params['query']
        ctx = self.last_ctx
        if not ctx or not ctx.valid:
            return

        def sym_info(sym: kconfig.Symbol):
            return SymbolInformation('CONFIG_' + sym.name, SymbolKind.PROPERTY,
                                     _loc(sym)[0], _prompt(sym, True))

        return [sym_info(s) for s in ctx.symbols(query) if len(s.nodes)]

    @handler('textDocument/codeAction')
    def handle_code_action(self, params):
        uri = Uri.parse(params['textDocument']['uri'])
        ctx = self.best_ctx(uri)
        if not ctx:
            self.dbg('No context for {}'.format(uri.path))
            return

        if not ctx.valid:
            self.refresh_ctx(ctx)

        conf = ctx.conf_file(uri)
        if not conf:
            self.dbg('No conf file for {}'.format(uri.path))
            return

        range: Range = Range.create(params['range'])
        actions = []
        for diag in conf.diags:
            if range.overlaps(diag.range):
                actions.extend(diag.actions)

        return actions

    def on_file_change(self, uri: Uri, kind: FileChangeKind):
        if uri.basename.startswith('Kconfig'):
            for ctx in self.ctx.values():
                ctx.invalidate()
                self.dbg(f'Invalidated context because of change in {uri}')
        elif uri.basename == 'edt.pickle':
            # When the DTS context for this context changes, it should be invalidated:
            changedCtx = self.ctx.get(str(Uri.file(uri.path.replace('/zephyr/edt.pickle', ''))))
            if changedCtx:
                changedCtx.invalidate()
                self.dbg(f'Invalidated {changedCtx} due to dts changes.')


def wait_for_debugger():
    import debugpy
    # 5678 is the default attach port in the VS Code debug configurations.
    debugpy.listen(5678)
    debugpy.wait_for_client()


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--debug',
        action='store_true',
        help='Enable debug mode. Will wait for a debugger to attach before starting the server.')
    parser.add_argument(
        '--log',
        action='store_true',
        help=
        'Enable logging. Will write debug logs to an lsp.log file in the current working directory.'
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    if args.debug:
        wait_for_debugger()

    srv = KconfigServer()
    if args.log:
        srv.logging = True

    srv.loop()
