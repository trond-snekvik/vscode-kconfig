# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

import os
import re
import enum
from typing import Any, Callable, Optional, List, Dict
from rpc import RPCServer, RPCResponse, handler
"""
Language Server implementation.

This file implements the language server protocol, including a document store,
a language server and all the required surrounding classes.
"""


class Uri:
    """
    Uniform Resource Identifier implementation.
    Implements https://datatracker.ietf.org/doc/html/rfc3986.
    URIs are used to encode resources in the Language Server Protocol, such as files or URLs.

    URIs are structured like this (example from IETF RFC3986)::

            foo://example.com:8042/over/there?name=ferret#nose
            \_/   \______________/\_________/ \_________/ \__/
            |           |            |            |        |
        scheme     authority       path        query   fragment
    """
    def __init__(self,
                 scheme: str,
                 authority: str = '',
                 path: str = '',
                 query: str = '',
                 fragment: str = ''):
        """
        Instantiate a new URI.

        Parameters
        ----------
        scheme: str
            Scheme of the URI, e.g. https
        authority: str
            Authority of the URI, e.g. www.example.com
        path: str,
            Path of the URI, e.g. /some/file
        query: str
            Query of the URI, i.e. the part after ?
        fragment: str
            Fragment of the URI, i.e. the part after #
        """
        self.scheme = scheme or ''
        self.authority = authority or ''
        path = re.sub(r'^/(\w:/)', r'\1', path)
        self.path = path or ''
        self.query = query or ''
        self.fragment = fragment or ''

    def escape(self, text):
        def escape_char(c):
            if c in "!#$&'()*+,\\:;=?@[]":
                return '%{:02X}'.format(ord(c))
            return c

        return ''.join([escape_char(c) for c in text])

    def __repr__(self):
        path = self.path
        if not path.startswith('/'):
            path = '/' + path
        uri = '{}://{}{}'.format(
            *[self.escape(part) for part in [self.scheme, self.authority, path]])
        if self.query:
            uri += '?' + self.query
        if self.fragment:
            uri += '#' + self.fragment
        return uri

    def __str__(self):
        return self.__repr__()

    def __eq__(self, o: object) -> bool:
        if isinstance(o, str):
            return Uri.parse(o) == self
        if not isinstance(o, Uri):
            return NotImplemented
        return str(self) == str(o)

    @property
    def basename(self):
        """The Uri's path's basename"""
        return os.path.basename(self.path)

    @staticmethod
    def parse(raw: str):
        """Parse a URI from a raw string"""
        def sanitize(part):
            if part:
                return re.sub(r'%([\da-fA-F]{2})', lambda x: chr(int(x.group(1), 16)), part)
            else:
                return ''

        if not isinstance(raw, str):
            return NotImplemented

        sanitized = sanitize(raw)

        # Convert windows paths:
        if re.match(r'\w:\\', sanitized):
            sanitized = 'file:///' + sanitized.replace('\\', '/')

        match = re.match(r'(.*?):(?://([^?\s/#]*))?(/[^?\s]*)?(?:\?([^#]+))?(?:#(.+))?', sanitized)
        if match:
            return Uri(*list(match.groups()))

    @staticmethod
    def file(path: str):
        """Convert a file path to a URI"""
        return Uri('file', '', path.replace('\\', '/'))

    def to_dict(self):
        return str(self)


class WorkspaceFolder:
    """
    Workspace folder representation.
    """
    def __init__(self, uri: Uri, name: str):
        self.uri = uri
        self.name = name


class Position:
    def __init__(self, line: int, character: int):
        """
        TextDocument position, as a zero-indexed line and character.

        Parameters
        ----------
        line: int
            Zero-indexed line. The first line in a file is line 0.
        character: int
            Zero-indexed character on a line. The first character on a line is character 0.
        """
        self.line = line
        self.character = character

    @property
    def range(self):
        """Range of this position, ie an empty range starting a this position."""
        return Range(self, self)

    def before(self, other):
        """
        Check whether this position is before the other.

        Parameters
        ----------
        other: Position
            Position to compare against.
        """
        if not isinstance(other, Position):
            return NotImplemented
        return (self.line < other.line) or (self.line == other.line
                                            and self.character < other.character)

    def after(self, other):
        """
        Check whether this position is after the other.

        Parameters
        ----------
        other: Position
            Position to compare against.
        """
        if not isinstance(other, Position):
            return NotImplemented
        return (self.line > other.line) or (self.line == other.line
                                            and self.character > other.character)

    def __eq__(self, other):
        if not isinstance(other, Position):
            return False
        return self.line == other.line and self.character == other.character

    def __repr__(self):
        return '{}:{}'.format(self.line + 1, self.character)

    @staticmethod
    def create(obj):
        """Create position from a serialized object."""
        return Position(obj['line'], obj['character'])

    @staticmethod
    def start():
        """Get the start position in any file."""
        return Position(0, 0)

    @staticmethod
    def end():
        """Get the end position in any file."""
        return Position(999999, 999999)


class Range:
    def __init__(self, start: Position, end: Position):
        """
        TextDocument range.

        Parameters
        ----------
        start: Position
            The range's start position (inclusive)
        end: Position
            The range's end position (exclusive)
        """
        self.start = start
        self.end = end

    def single_line(self):
        """Check whether this range starts and ends on the same line."""
        return self.start.line == self.end.line

    @staticmethod
    def union(a, b):
        """Create a range that includes both ranges a and b."""
        if not isinstance(a, Range) or not isinstance(b, Range):
            return NotImplemented
        return Range(a.start if a.start.before(b.start) else b.start,
                     b.end if a.end.before(b.end) else b.end)

    def contains(self, pos_or_range):
        """Check whether this range fully contains the other Range or Position"""
        if isinstance(pos_or_range, Position):
            return (not pos_or_range.before(self.start)) and (not self.end.before(pos_or_range))
        if isinstance(pos_or_range, Range):
            return self.contains(pos_or_range.start) and self.contains(pos_or_range.end)
        return NotImplemented

    def overlaps(self, range):
        """Check whether this range overlaps with the other Range"""
        if not isinstance(range, Range):
            return NotImplemented
        return not self.start.after(range.end) and not range.start.after(self.end)

    def __eq__(self, other):
        if not isinstance(other, Range):
            return NotImplemented

        return self.start == other.start and self.end == other.end

    def __repr__(self):
        return '{} - {}'.format(self.start, self.end)

    @staticmethod
    def create(obj):
        """Create a range from a serialized object."""
        return Range(Position.create(obj['start']), Position.create(obj['end']))


class Location:
    """
    TextDocument location.

    A location object represents a unique text range in a resource in a workspace.
    """
    def __init__(self, uri: Uri, range: Range):
        self.uri = uri
        self.range = range

    def __repr__(self):
        return '{}: {}'.format(self.uri, self.range)

    def __eq__(self, other):
        if not isinstance(other, Location):
            return NotImplemented
        return self.uri == other.uri and self.range == other.range

    @staticmethod
    def create(obj):
        """Create a location from a serialized object."""
        return Location(Uri.parse(obj['uri']), Range.create(obj['range']))


class TextDocument:
    """
    Versioned text document.

    A text document object that can be read, written and manipulated.

    Text documents are normally maintained by a DocumentStore, which keeps them in sync
    with the editor's representation of the document.
    """

    UNKNOWN_VERSION = -1

    def __init__(self, uri: Uri, text: str = None, languageId: str = None, version: int = None):
        """
        Create a text document.

        Parameters
        ----------
        uri: URI
            URI the document represents.
        text: str | None
            Optional initial content of the document.
        languageId: str | None
            Optional language identifier of the file, e.g. 'cpp'.
        version: int | None
            Initial version of the document.
        """
        if version == None:
            version = TextDocument.UNKNOWN_VERSION

        self.uri = uri
        self.languageId = languageId
        self.version = version
        self.modified = version != 0
        self._inside = False
        self._mode = None
        self._scanpos = 0
        self.lines: List[str] = []
        self._cbs: List[Callable[['TextDocument'], Any]] = []
        self._virtual = self.uri.scheme != 'file'
        self.loaded = False
        if text:
            self._set_text(text)

    def on_change(self, cb: Callable[['TextDocument'], Any]):
        """
        Register a callback to be called each time the document is changed.

        Parameters
        ----------
        cb: Callable
            A callback that takes the document as a parameter.
        """
        self._cbs.append(cb)

    def _set_text(self, text):
        """Internal: Replace the contents of the document."""
        self.lines = text.splitlines()
        self.loaded = True
        for cb in self._cbs:
            cb(self)

    @property
    def text(self):
        """Full contents of the document, using newline as a line separator."""
        return '\n'.join(self.lines) + '\n'

    def line(self, index):
        """Get the contents of a line in the document. Does not include the line separator."""
        if index < len(self.lines):
            return self.lines[index]

    def offset(self, pos: Position):
        """
        Get the content offset of the given position, ie the number of characters the document contains
        before the given position.
        """
        if pos.line >= len(self.lines):
            return len(self.text)
        character = min(len(self.lines[pos.line]) + 1, pos.character)
        return len(''.join([l + '\n' for l in self.lines[:pos.line]])) + character

    def pos(self, offset: int):
        """Get the Position at the given content offset."""
        content = self.text[:offset]
        lines = content.splitlines()
        if len(lines) == 0:
            return Position(0, 0)
        return Position(len(lines) - 1, len(lines[-1]))

    def get(self, range: Range = None):
        """Get the text in the given range."""
        if not range:
            return self.text
        text = self.text[self.offset(range.start):self.offset(range.end)]

        # Trim trailing newline if the range doesn't end on the next line:
        if text.endswith('\n') and range.end.character != 0 and range.end.line < len(self.lines):
            return text[:-1]
        return text

    def word_at(self, pos: Position):
        """
        Get the word occurring at the given position.
        Words are strings containing the characters a-z, A-Z, 0-9 and _.
        """
        line = self.line(pos.line)
        if line:
            before = re.match(r'.*?(\w*)$', line[:pos.character])
            after = re.match(r'^\w*', line[pos.character:])
            if before and after:
                return before[1] + after[0]

    def replace(self, text: str, range: Range = None):
        """
        Replace a text range with new text.

        Parameters
        ----------
        text: str
            The new text, or '' to just delete the given range.
        range: Range | None
            Range to replace, or None to replace the entire content of the document.
        """
        # Ignore range if the file is empty:
        if range and len(self.lines) > 0:
            self._set_text(self.text[:self.offset(range.start)] + text +
                           self.text[self.offset(range.end):])
        else:
            self._set_text(text)
        self.modified = True

    def _write_to_disk(self):
        """Internal: Store the file on disk. The document's must use the `file` scheme."""
        if not self._virtual:
            with open(self.uri.path, 'w') as f:
                f.write(self.text)
            self.modified = False
            self.version = TextDocument.UNKNOWN_VERSION

    def _read_from_disk(self):
        """Internal: Restore the document from disk. The document's must use the `file` scheme."""
        # will raise environment error if the file doesn't exist. This has to be caught outside:
        with open(self.uri.path, 'r') as f:
            text = f.read()
        if text == None:
            raise IOError('Unable to read from file {}'.format(self.uri.path))

        self._set_text(text)
        self.modified = False
        self.version = TextDocument.UNKNOWN_VERSION

    @staticmethod
    def from_disk(uri: Uri):
        """Create a TextDocument by reading its contents from disk."""
        with open(uri.path, 'r') as f:
            doc = TextDocument(uri, f.read())
        return doc

    # Standard File behavior:

    def __enter__(self):
        self._inside = True
        return self

    def __exit__(self, type, value, traceback):
        if self._inside:
            self._inside = False
            self.close()

    class LineIterator:
        """
        Iterator allowing users to go through the lines in the document
        in a loop.
        """
        def __init__(self, doc):
            self._linenr = 0
            self._lines = doc.lines

        def __next__(self):
            if self._linenr >= len(self._lines):
                raise StopIteration
            line = self._lines[self._linenr]
            self._linenr += 1
            return line

    def __iter__(self):
        return TextDocument.LineIterator(self)

    def open(self, mode='r'):
        """Open the document like a stream."""
        if not mode in ['w', 'a', 'r']:
            raise IOError('Unknown mode ' + str(mode))

        if mode == 'w':
            self._set_text('')
            self.modified = True
            self.version = TextDocument.UNKNOWN_VERSION
        elif not self.loaded:
            self._read_from_disk()
        self._mode = mode
        self._scanpos = 0
        return self

    def close(self):
        """Close the document stream."""
        if self._mode in ['a', 'w'] and self.modified:
            self._write_to_disk()
        self._mode = None

    def write(self, text: str):
        """Write to the document stream."""
        if not self._mode in ['a', 'w']:
            raise IOError('Invalid mode for writing: ' + str(self._mode))
        if not self.loaded:
            raise IOError('File not loaded in RAM: {}'.format(self.uri.path))

        self._set_text(self.text + text)
        if self._mode == 'a':
            self._scanpos = len(self.text)
        self.modified = True
        self.version = TextDocument.UNKNOWN_VERSION

    def writelines(self, lines):
        """Write lines to the document stream."""
        for line in lines:
            self.write(line)

    def read(self, length=None):
        """Read from the document stream."""
        if self._mode != 'r':
            raise IOError('Invalid mode for reading: ' + str(self._mode))

        if self._scanpos >= len(self.text):
            return ''

        if length == None:
            out = self.text[self._scanpos:]
            self._scanpos = len(self.text)
        else:
            out = self.text[self._scanpos:self._scanpos + length]
            self._scanpos += length
        return out

    def readline(self, size=None):
        """Read a line from the document stream."""
        if self._mode != 'r':
            raise IOError('Invalid mode for reading: ' + str(self._mode))

        if self._scanpos >= len(self.text):
            return ''
        out = self.text[self._scanpos:].splitlines(True)[0]
        if size != None:
            out = out[:size]
        self._scanpos += len(out)
        return out

    def readlines(self, _=None):
        """Read lines from the document stream."""
        if self._mode != 'r':
            raise IOError('Invalid mode for reading: ' + str(self._mode))

        if self._scanpos >= len(self.text):
            return []
        out = self.text[self._scanpos:].splitlines()
        self._scanpos = len(self.text)
        return out

    def flush(self):
        pass

    def seek(self, offset):
        """Move the document stream"""
        if self._mode == None:
            raise IOError('Cannot seek on closed file')
        self._scanpos = offset

    def tell(self):
        """Get the stream position"""
        return self._scanpos

    def next(self):
        """Get the next line in the stream"""
        if self._mode != 'r':
            raise IOError('Invalid mode for reading: ' + str(self._mode))
        if self._scanpos >= len(self.text):
            raise StopIteration
        return self.readline()


class DocProvider:
    """
    Document provider class for getting virtual documents from non-file URI schemes.

    Can be extended and registered in the DocumentStore to provide contents for URIs
    that don't represent on-disk documents, such as webpages or virtual documents.
    """
    def __init__(self, scheme: str):
        """
        Create a new DocProvider.

        Parameters
        ----------
        scheme: str
            URI scheme this provider provides documents for. E.g. http.
        """
        self.scheme = scheme

    def get(self, uri: Uri) -> Optional[TextDocument]:
        """Get the document with the given URI."""
        return None

    def exists(self, uri):
        """Check whether the document with the given URI exists."""
        return self.get(uri) != None


class DocumentStore:
    """
    Document store class.
    The document store maintains a set of open documents, and ensures that documents
    with the same URI always resolve to the same document class.

    The DocumentStore is instantiated as a singleton, which is referenced from the LSPServer.
    """
    def __init__(self):
        self.docs: Dict[str, TextDocument] = {}
        self._providers: Dict[str, DocProvider] = {}

    def open(self, doc: TextDocument):
        """Register the given document in the document store."""
        self.docs[str(doc.uri)] = doc

    def close(self, uri: Uri):
        """Close the given URI in the document store."""
        pass

    def provider(self, provider):
        """Register a DocumentProvider for a specific URI scheme."""
        self._providers[provider.uri.scheme] = provider

    def reset(self):
        """
        Reset the document store to its original state, discarding all changes.
        """
        self.docs = {}
        self._providers = {}

    def get(self, uri: Uri, create=True):
        """
        Get the TextDocument object representing the given URI, or create one from disk,
        if available.

        Parameters
        ----------
        uri: Uri
            URI of the document to get.
        create: boolean
            Whether to create the document object if it doesn't already exist. Defaults to True.
        """
        if uri.scheme in self._providers:
            return self._providers[uri.scheme].get(uri)

        if str(uri) in self.docs:
            return self.docs[str(uri)]

        try:
            if create:
                return self._from_disk(uri)
        except EnvironmentError as e:
            # File doesn't exist
            return None

    def _from_disk(self, uri: Uri):
        # will raise environment error if the file doesn't exist. This has to be caught outside
        with open(uri.path, 'r') as f:
            text = f.read()
        if text == None:
            return None
        doc = TextDocument(uri, text)
        self.docs[str(uri)] = doc
        return doc


class CompletionItemKind(enum.IntEnum):
    """Completion item kinds, as defined by the LSP specification."""
    TEXT = 1
    METHOD = 2
    FUNCTION = 3
    CONSTRUCTOR = 4
    FIELD = 5
    VARIABLE = 6
    CLASS = 7
    INTERFACE = 8
    MODULE = 9
    PROPERTY = 10
    UNIT = 11
    VALUE = 12
    ENUM = 13
    KEYWORD = 14
    SNIPPET = 15
    COLOR = 16
    FILE = 17
    REFERENCE = 18
    FOLDER = 19
    ENUM_MEMBER = 20
    CONSTANT = 21
    STRUCT = 22
    EVENT = 23
    OPERATOR = 24
    TYPE_PARAMETER = 25


class SymbolKind(enum.IntEnum):
    """Symbol kinds, as defined by the LSP specification"""
    FILE = 1
    MODULE = 2
    NAMESPACE = 3
    PACKAGE = 4
    CLASS = 5
    METHOD = 6
    PROPERTY = 7
    FIELD = 8
    CONSTRUCTOR = 9
    ENUM = 10
    INTERFACE = 11
    FUNCTION = 12
    VARIABLE = 13
    CONSTANT = 14
    STRING = 15
    NUMBER = 16
    BOOLEAN = 17
    ARRAY = 18
    OBJECT = 19
    KEY = 20
    NULL = 21
    ENUM_MEMBER = 22
    STRUCT = 23
    EVENT = 24
    OPERATOR = 25
    TYPE_PARAMETER = 26


class InsertTextFormat(enum.IntEnum):
    """Text format, as defined by the LSP specification."""
    PLAINTEXT = 1
    SNIPPET = 2


class DiagnosticRelatedInfo:
    """Additional information attached to a Diagnostic item."""
    def __init__(self, loc: Location, message: str):
        self.location = loc
        self.message = message


class TextEdit:
    """
    A single text edit applied to a TextDocument.
    TextEdits are used by CodeActions to manipulate TextDocuments,
    e.g. to delete redundant assignments.

    TextEdits are normally included in a larger WorkspaceEdit that defines the URI
    the TextEdit should be applied to.
    """
    def __init__(self, range: Range, new_text: str):
        self.range = range
        self.newText = new_text

    @staticmethod
    def remove(range: Range):
        """Create a TextEdit that just removes the text in the given range."""
        return TextEdit(range, '')


class WorkspaceEdit:
    """
    Workspace edit.

    A workspace edit is a collection of TextEdits applied to TextDocuments at various URIs.
    """
    def __init__(self):
        self.changes = {}

    def add(self, uri: Uri, edit: TextEdit):
        """Add a TextEdit for a URI"""
        key = str(uri)
        if not key in self.changes:
            self.changes[key] = []
        self.changes[key].append(edit)

    def has_changes(self):
        """Check whether this WorkspaceEdit will make any changes to URIs in the workspace."""
        return len([c for c in self.changes.values() if len(c) > 0]) > 0


class CodeActionKind(enum.Enum):
    """Kinds of CodeActions, as defined by the LSP specification."""
    QUICKFIX = 'quickfix'
    REFACTOR = 'refactor'
    REFACTOREXTRACT = 'refactor.extract'
    REFACTORINLINE = 'refactor.inline'
    REFACTORREWRITE = 'refactor.rewrite'
    SOURCE = 'source'
    SOURCEORGANIZEIMPORTS = 'source.organizeImports'
    SOURCEFIXALL = 'source.fixAll'


class CodeAction:
    """
    Code actions are text changes suggested to the user as quickfixes or automatic refactoring.
    CodeActions typically appear in the editor as a small icon next to errors and warnings,
    allowing them to quickly resolve trivial mistakes, such as typos or missing statements.
    """
    def __init__(self, title: str, kind: CodeActionKind = CodeActionKind.QUICKFIX):
        """
        Create a new CodeAction.

        Parameters
        ----------
        title: str
            Title of the action, as presented to the user in the UI. Typically describes the
            change that will be applied, like 'Add missing semicolon'
        kind: CodeActionKind
            The kind of CodeAction this is. Defaults to QUICKFIX.
        """
        self.title = title
        self.kind = kind
        self.command = None
        self.data = None
        self.diagnostics: List[Diagnostic] = []
        self.edit = WorkspaceEdit()

    def to_dict(self):
        result = {
            'title': self.title,
            'kind': self.kind.value,
        }
        if self.command:
            result['command'] = self.command,
        if self.data:
            result['data'] = self.data
        if len(self.diagnostics) > 0:
            result['diagnostics'] = self.diagnostics
        if self.edit.has_changes():
            result['edit'] = self.edit
        return result


class Diagnostic:
    """
    Diagnostic message that appears in the UI as an error, a warning, some information or a hint.
    """
    ERROR = 1
    WARNING = 2
    INFORMATION = 3
    HINT = 4

    class Tag(enum.IntEnum):
        """Diagnostic tag that can be added to Diagnostic.tags."""
        UNNECESSARY = 1
        DEPRECATED = 2

    def __init__(self, message, range: Range, severity=WARNING):
        """
        Parameters
        ----------
        message: str
            Message presented to the user, describing the issue.
        range: Range
            Text range the diagnostic applies to within a document.
        severity: int
            Severity of the diagnostic. Must be one of:
            - Diagnostic.ERROR
            - Diagnostic.WARNING (default)
            - Diagnostic.INFORMATION
            - Diagnostic.HINT
        """
        self.message = message
        self.range = range
        self.severity = severity
        self.tags: List[Diagnostic.Tag] = []
        self.related_info: List[DiagnosticRelatedInfo] = []
        self.actions: List[CodeAction] = []

    @staticmethod
    def severity_str(severity):
        return ['Unknown', 'Error', 'Information', 'Hint'][severity]

    def __str__(self) -> str:
        return '{}: {}: {}'.format(self.range, Diagnostic.severity_str(self.severity), self.message)

    def to_dict(self):
        obj = {"message": self.message, "range": self.range, "severity": self.severity}
        if len(self.tags):
            obj['tags'] = self.tags
        if len(self.related_info):
            obj['relatedInformation'] = [info.__dict__ for info in self.related_info]

        return obj

    def add_action(self, action: CodeAction):
        action.diagnostics.append(self)
        self.actions.append(action)

    def mark_unnecessary(self):
        self.tags.append(Diagnostic.Tag.UNNECESSARY)

    @staticmethod
    def err(message, range):
        return Diagnostic(message, range, Diagnostic.ERROR)

    @staticmethod
    def warn(message, range):
        return Diagnostic(message, range, Diagnostic.WARNING)

    @staticmethod
    def info(message, range):
        return Diagnostic(message, range, Diagnostic.INFORMATION)

    @staticmethod
    def hint(message, range):
        return Diagnostic(message, range, Diagnostic.HINT)


class DocumentSymbol:
    """
    Document symbols represent a single language construct, like a variable, a function or a symbol.
    Document symbols show up in the breadcrumbs view and can be searched for by the user.
    """
    def __init__(self, name: str, kind: SymbolKind, range: Range, detail=''):
        self.name = name
        self.kind = kind
        self.range = range
        self.detail = detail
        self.selectionRange = range
        self.children: List[DocumentSymbol] = []


class SymbolInformation:
    """
    Symbol information items represent single language constructs, and presents some basic information
    about them. SymbolInformation is the workspace level representation of a DocumentSymbol.
    """
    def __init__(self, name: str, kind: SymbolKind, loc: Location, detail: str = None):
        self.name = name
        self.kind = kind
        self.location = loc
        self.detail = detail

    def to_dict(self):
        retval = {
            'name': self.name,
            'kind': self.kind,
            'location': self.location,
        }
        if self.detail:
            retval['containerName'] = self.detail
        return retval


class MarkupContent:
    """
    A string formatted using markdown or plaintext.
    MarkupContent is used to present rich text in the UI, such as hover information or
    symbol definitions.
    """
    PLAINTEXT = 'plaintext'
    MARKDOWN = 'markdown'

    def __init__(self, value='', kind=None):
        """Create a new markup string"""
        self.value = value
        self.kind = kind if kind else MarkupContent.MARKDOWN

    def _sanitize(self, text):
        text = re.sub(r'[`{}\[\]]', r'\\\0', text)
        text = re.sub(r'<', '&lt;', text)
        text = re.sub(r'>', '&gt;', text)
        return text

    def add_text(self, text):
        """Add plaintext"""
        if self.kind == MarkupContent.MARKDOWN:
            self.value += self._sanitize(text)
        else:
            self.value += text

    def add_markdown(self, md):
        """Add preformatted markdown. Will convert this to markdown content."""
        if self.kind == MarkupContent.PLAINTEXT:
            self.value = self._sanitize(self.value)
            self.kind = MarkupContent.MARKDOWN
        self.value += md

    def paragraph(self):
        """Add a new paragraph."""
        self.value += '\n\n'

    def linebreak(self):
        """Add a linebreak."""
        if self.kind == MarkupContent.MARKDOWN:
            self.value += '\n\n'
        else:
            self.value += '\n'

    def add_code(self, lang, code):
        """
        Add a code snippet with the given language.
        Will be presented as raw code in the UI.

        Parameters
        ----------
        lang: str
            Markdown language identifier, like 'py' or 'cpp'
        code: str
            Raw code.
        """
        self.add_markdown('\n```{}\n{}\n```\n'.format(lang, code))

    def add_link(self, url, text=''):
        """Add a clickable link."""
        self.add_markdown('[{}]({})'.format(text, url))

    @staticmethod
    def plaintext(value):
        """Create plaintext content."""
        return MarkupContent(value, MarkupContent.PLAINTEXT)

    @staticmethod
    def markdown(value):
        """Create markdown content."""
        return MarkupContent(value, MarkupContent.MARKDOWN)

    @staticmethod
    def code(lang, value):
        """
        Create raw code content.

        Parameters
        ----------
        lang: str
            Markdown language identifier, like 'py' or 'cpp'
        code: str
            Raw code.
        """
        return MarkupContent.markdown('```{}\n{}\n```'.format(lang, value))


NEXT_TABSTOP = -1


class Snippet:
    """
    Interactive snippet string, used to build boilerplate strings with user interaction.
    See https://code.visualstudio.com/docs/editor/userdefinedsnippets.
    """
    def __init__(self, value=''):
        """Create a new snippet with some raw text."""
        self.text = value
        self._next_tabstop = 1

    def add_text(self, text: str):
        """Add raw text to the snippet."""
        self.text += text

    def add_tabstop(self, number=NEXT_TABSTOP):
        """
        Add a point for the user to enter their own text.
        The index of this tabstop can be overridden by setting number.
        Tabstops with the same number are visited just once, but the inserted text will change in
        all locations.
        The cursor will be moved to tabstop 0 when the user is done editing. By default, this is at
        the end of the snippet.
        """
        if number == NEXT_TABSTOP:
            number = self._next_tabstop

        self.text += ''.join(['${', str(number), '}'])
        self._next_tabstop = number + 1

    def add_placeholder(self, text, number=NEXT_TABSTOP):
        """
        Add a point for the user to enter their own text, with some placeholder text there by default.
        """
        if number == NEXT_TABSTOP:
            number = self._next_tabstop
        self.text += ''.join(['${', str(number), ':', text, '}'])
        self._next_tabstop = number + 1

    def add_choice(self, choices, number=NEXT_TABSTOP):
        """
        Add a point for the user to insert text from a list of choices.
        """
        if number == NEXT_TABSTOP:
            number = self._next_tabstop

        # Don't try to format and insert an empty list
        choices_text = '|{choices}|'.format(choices=','.join(choices)) if choices else ''

        self.text += '${{{number}{choices_text}}}'.format(number=number, choices_text=choices_text)
        self._next_tabstop = number + 1


class FileChangeKind(enum.IntEnum):
    """File change event types, as defined by the LSP specification."""
    CREATED = 1
    CHANGED = 2
    DELETED = 3


documentStore = DocumentStore()
"""Document store singleton"""


class LSPServer(RPCServer):
    """
    Language Server implementation.
    Implements server lifecycle management, integration with the document store and document
    watchers.
    """
    def __init__(self, name: str, version: str, istream, ostream):
        """
        Create a new language server instance. All language server instances will share the same
        document store. Typically, the language server should not be instantiated, but rather be
        extended by a class that implements actual language specific behavior.

        Parameters
        ----------
        name: str
            Name of the language server. Will show up in the UI when the language server itself is
            referenced, such as on crashes.
        version: str
            Version number of the language server. Can be used by the client to determine the feature set.
        istream: TextIO | None
            Input stream for the incoming data, or sys.stdin if None.
        ostream: TextIO | None
            Output stream for the incoming data, or sys.stdout if None.
        """
        super().__init__(istream, ostream)
        self.rootUri: str
        self.workspaceFolders: List[WorkspaceFolder]
        self.name = name
        self.version = version
        self.trace = 'off'
        self.capability_id = 0

    def capabilities(self):
        """
        Get the language server capabilities.
        See https://microsoft.github.io/language-server-protocol/specifications/specification-3-17/#serverCapabilities.
        Automatically determines the feature set based on the implemented handlers, but can be
        overridden to change change the reported feature set. Clients will only attempt to
        use features that have been reported by the server.

        Capabilities may also be registered asynchronously, see LSPServer.register_capability.
        """
        def has(method):
            return method in self.handlers

        caps = {
            'hoverProvider': has('textDocument/hover'),
            'declarationProvider': has('textDocument/declaration'),
            'definitionProvider': has('textDocument/definition'),
            'typeDefinitionProvider': has('textDocument/typeDefinition'),
            'implementationProvider': has('textDocument/implementation'),
            'referencesProvider': has('textDocument/references'),
            'documentHighlightProvider': has('textDocument/documentHighlight'),
            'documentSymbolProvider': has('textDocument/documentSymbol'),
            'codeActionProvider': has('textDocument/codeAction'),
            'colorProvider': has('textDocument/documentColor'),
            'documentFormattingProvider': has('textDocument/formatting'),
            'documentRangeFormattingProvider': has('textDocument/rangeFormatting'),
            'renameProvider': has('textDocument/rename'),
            'foldingRangeProvider': has('textDocument/foldingRange'),
            'selectionRangeProvider': has('textDocument/selectionRange'),
            'linkedEditingRangeProvider': has('textDocument/linkedEditingRange'),
            'callHierarchyProvider': has('textDocument/prepareCallHierarchy'),
            'monikerProvider': has('textDocument/moniker'),
            'workspaceSymbolProvider': has('workspace/symbol'),
            'textDocumentSync': 2,  # incremental
        }

        if has('textDocument/completion'):
            caps['completionProvider'] = {}

        return caps

    def dbg(self, *args: str):
        """Write a debug message to the log file, and report it to the client, if tracing is enabled."""
        super().dbg(*args)
        if self.trace != 'off':
            self.notify('$/logTrace', {'message': '\n'.join(args)})

    def log(self, *args):
        """Write an info message to the log file, and report it to the client, if tracing is enabled."""
        super().log(*args)
        if self.trace == 'message':
            self.notify('$/logTrace', {'message': '\n'.join(args)})

    def register_capability(self,
                            method: str,
                            options=None,
                            handler: Optional[Callable[[RPCResponse], Any]] = None):
        """
        Asynchronously register a capability to the client.

        Example::

            self.register_capability('hoverProvider', lambda rsp: self.supports_hover = not rsp.error)

        Parameters
        ----------
        method: str
            Capability to register. Matches the capability name in LSPServer.capabilities().
        options: Any
            Options for the capability. See the LSP specification.
        handler: Callable
            Optional callback for the response message from the client.
        """
        self.capability_id += 1
        capability = {'id': str(self.capability_id), 'method': method, 'registerOptions': options}
        self.req('client/registerCapability', {'registrations': [capability]}, handler)
        return str(self.capability_id)

    def watch_files(self, pattern: str, created=True, changed=True, deleted=True):
        """
        Enable a file watcher for the given glob pattern.
        File watchers will notify the LSPServer if any changes occurred to any file matching the
        pattern. There is no way to detect which file matcher was triggered, so all file changes
        are reported to the common LSPServer.on_file_change() function, which should be overridden
        by extending classes.
        """
        watcher = {
            'globPattern': pattern,
            'kind': (created * 1) + (changed * 2) + (deleted * 4),
        }
        self.register_capability('workspace/didChangeWatchedFiles', {'watchers': [watcher]})

    def on_file_change(self, uri: Uri, kind: FileChangeKind):
        pass  # Override in extending class

    ############################
    # Server lifecycle handlers:
    ############################
    @handler('$/setTrace')
    def handle_set_trace(self, params):
        self.trace = params['value']

    @handler('$/cancelRequest')
    def handle_cancel(self, params):
        pass

    @handler('$/progress')
    def handle_progress(self, params):
        pass

    @handler('shutdown')
    def handle_shutdown(self, params):
        self.running = False

    @handler('initialize')
    def handle_initialize(self, params):
        self.rootUri = params['rootUri']
        if 'trace' in params:
            self.trace = params['trace']
        if params.get('workspaceFolders'):
            self.dbg('workspaceFolders: ' + str(params['workspaceFolders']))
            self.workspaceFolders = [
                WorkspaceFolder(Uri.parse(folder['uri']), folder['name'])
                for folder in params['workspaceFolders']
            ]
        else:
            self.workspaceFolders = []
        return {
            'capabilities': self.capabilities(),
            'serverInfo': {
                'name': self.name,
                'version': self.version
            }
        }

    ################################
    # Text document synchronization:
    ################################
    @handler('textDocument/didOpen')
    def handle_open(self, params):
        doc = params['textDocument']
        uri = Uri.parse(doc['uri'])
        if uri:
            documentStore.open(TextDocument(uri, doc['text'], doc['languageId'], doc['version']))
        else:
            self.dbg(f'Invalid URI: {doc["uri"]}')

    @handler('textDocument/didChange')
    def handle_change(self, params):
        uri = Uri.parse(params['textDocument']['uri'])
        doc = documentStore.get(uri)
        if not doc:
            return

        for change in params['contentChanges']:
            if 'range' in change:
                range = Range.create(change['range'])
            else:
                range = None

            doc.replace(change['text'], range)

        doc.version = params['textDocument']['version']

    @handler('textDocument/didClose')
    def handle_close(self, params):
        documentStore.close(Uri.parse(params['textDocument']['uri']))

    @handler('workspace/didChangeWatchedFiles')
    def handle_changed_watched_files(self, params):
        for change in params['changes']:
            uri = Uri.parse(change['uri'])
            kind = FileChangeKind(change['type'])
            self.on_file_change(uri, kind)
