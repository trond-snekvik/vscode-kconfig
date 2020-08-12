# v1.1.7 Multiple SOC roots

- Add support for multiple SOC roots through a config entry. By default, only the zephyr repo's SOC directory is included.
- Contextual filtering of keyword completion items in kconfig files
- New icon, inspired by the Zephyr documentation page
- Add the most common Kconfig filenames to the list of associated filenames

# v1.1.6 Out-of-folder application support

- Add support for applications outside the Zephyr folder
  - Improved detection of local Kconfig files
  - Prompt for using local Kconfig file when opening .prj-files
  - Reworked detection of Zephyr to be a lot more liberal
- Support unbraced variable replacements in file paths (e.g. `$ZEPHYR_BASE` in addition to `${ZEPHYR_BASE}`)
- Support `$(KCONFIG_BINARY_DIR)` environment variable
- Rework dependency detection in project files
  - Now tries to suggest dependency additions recursively, forcing a clear path through the dependency tree down to the added config item
  - Significantly improved performance on linting
- Improved Kconfig file detection, excluding false positives
- Add support for `if` after prompts in Kconfig files
- Add extension deactivation
- Bugfix: Provide workspace entries without prefix prompt
- Provide language features in virtual files
- Remove unused recursive configuration option
- Fixed comments not being highlighted when trailing other symbols
- Cleaner symbol views
- Perform extension activation asynchronously
- Bundle with webpack
- Cleanup of repo in preparation for Extension Marketplace publication

# v1.1.5

- Support Windows paths in Zephyr modules
- Fix syntax highlighting for line continuation inside parenthesis
- Improve config file feedback for invalid syntax

# v1.1.4 Improved Zephyr default board selection and west error reporting

Uses zephyr.base as zephyrPath, and looks for the default board directories directly, instead of by glob. Shows users an error message if west fails.

# v1.1.3 Zephyr quality of life

Improves the workflow for Zephyr configurations, with better defaults and more flexible checks.
- Support for more Zephyr workspace configurations.
- Added default Zephyr board to avoid undefined file includes
- Syntax highlight: Supporting if in prompts

# v1.1.1 Performance and correctness improvements

Improves evaluated output, removing all known discrepancies with kconfig lib.
Internal performance improvements for file symbols and scope evaluation.
Propfile reparsing triggered by more events, like editor changing and background changes.

# v1.1.0 Evaluation overhaul

Major evaluation overhaul, improving speed and correctness.
- All scopes are evaluated, reducing lint misfires
- Lint made asynchronous, greatly improving responsiveness when editing properties files.
- Lint evaluation time reduced by 80% through caching and smarter evaluation.
- Bug: "Show references" would show all entries. Now only shows entries that are selectors or dependent on the selected entry.
- Zephyr: board dir resolved the way West does.
- Space no longer commits a completion item, removing unintentional completions when writing comments or help texts
- Ignore unresolved macros in expressions
- Watch file changes to pick up on git checkouts and other async behavior.
- Now accepting west.yml files without "build" entries
- Clean up breadcrumb duplicate entries

# v1.0.3 Bugfix: Load static config in scan

Moves loading of the static config into the scan step to avoid unknown entries-warnings in the static conf files.
Only serializes entries when needed, slightly increasing lint speed

# v1.0.2 West on Windows

- Moves the working directory of `west` to the current zephyr directory on Windows to ensure that it works out of the box.
- Adds diagnostics to Kconfig files
- Slight improvements to properties files parsing speed

# v1.0.1 Bugfix: silence extension when not needed

Prevents the extension from making any noise when it's not needed by checking the presence of a Kconfig root.

# v1.0.0

First release of the Kconfig extension.