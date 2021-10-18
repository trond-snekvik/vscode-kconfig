# Extension architecture

The Kconfig extension provides language features for Kconfig from two components: The Typescript based Kconfig file parser, and the Python based language server.

## TS Kconfig file parser

The Typescript part of the extension runs in the extension host itself, and aims to provide live information for users editing the Kconfig files in the nRF Connect SDK. As the language server is unable to reparse single files in the Kconfig file tree, the Typescript part will do single-file intelligence for these files, and provide:
- Diagnostics
- Completion items
- Document symbols
- Links

The TS part of the extension has no concept of workspace or global symbols, and will not attempt to relate config items in one Kconfig file to config items in others.

The Kconfig language features are implemented in three files:
- src/kconfig.ts: Contains all Kconfig types
- src/parse.ts: Kconfig file parser
- src/langHandler.ts: Manages Kconfig files, and passes their info to VS Code

## Language Server

The language server is implemented in Python, and uses kconfiglib as a backend. Kconfiglib is imported unchanged from the Zephyr repo, and takes care of the entire Kconfig language parsing and indexing mechanism.

```
┌────────────────────────────────┐
│                                │
│         kconfiglsp.py          │
│                                │
├────────────┬───────────────────┤
│            │                   │
│   lsp.py   │                   │
│            │                   │
├────────────┤   kconfiglib.py   │
│            │                   │
│   rpc.py   │                   │
│            │                   │
└────────────┴───────────────────┘
```

The entrie language server is implemented under srv/, and only uses standard Python libraries, with no third-party dependencies.

### General implementation notes

The Kconfig language server is written in snake_case to match the underlying kconfiglib, although some fields in the standard LSP types are written in pascalCase to fit the specification. Generally, this should not be exposed to other parts of the code base, and should be avoided if possible.

The language server is also using the Python 3 typing system to aid development. The linter will complain when a variable is written with an ambiguous type (like lists), and the pattern is generally to attempt to shut it up, without strictly defining a type for absolutely everything.

### Generic Language Server implementation

In addition to kconfiglib, the language server contains the language server infrastructure, built up of two modules:
- rpc.py: The Remote Procedure Call server, that the language server is built on top of. Implements JSONRPC 2.0.
- lsp.py: A generic Language server, with built-in text document synchronization. Implements all relevant types defined in the LSP Specification, as well as a language server with some basic behavior, such as initialization and capabilities reporting.

### Kconfig server

The Kconfig specific behavior of the language server is implemented in kconfiglsp.py. The Kconfig server holds a dict of Kconfig contexts, which each represents a build of an application. For each request the language server receives, it will pick the most relevant Kconfig context, based on the files referenced in the request, and what context is most recently used.

Each Kconfig context is a separate instantiation of the kconfiglib's Kconfig class, and will parse the entire Kconfig file tree separately. This is required to ensure that any variables referenced in the tree (such as the board name, or the set of West modules in the build) are properly set. This architecture is different from other users of the kconfiglib, which always instantiate a single Kconfig object instance. As the kconfiglib is built with this "one Kconfig tree" architecture in mind, it has some built in limitations and assumptions. An extension of the Kconfig class is implemented in the kconfiglsp.py module to get around some of these limitations.

### Language Server Tests

Core parts of the language server is tested in tests under ./srv/tests. The tests are automatically discovered by the VS Code Python extension's test runner, but can also be run by pytest from the root directory.

The goal of the tests is to cover the core components and the corner cases they have that won't typically show up in general user testing.

### Kconfig language client

The language server client is the extension host side of the Kconfig language server, and is responsible for communicating with the language server. The client searches the workspace for kconfig contexts, and passes them to the Kconfig language server.

The language client is implemented in src/lsp.ts.
