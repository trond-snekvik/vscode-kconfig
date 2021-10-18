# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

import lsp

# Test LSP Uri class


def test_parse_file():
    uri = lsp.Uri.parse('file:///home/user/file.txt')
    assert uri.scheme == 'file'
    assert uri.authority == ''
    assert uri.path == '/home/user/file.txt'
    assert uri.basename == 'file.txt'
    assert uri.query == ''
    assert uri.fragment == ''


def test_parse_http():
    uri = lsp.Uri.parse('https://example.com/some/path.html?q=1&b=2#fragment')
    assert uri.scheme == 'https'
    assert uri.authority == 'example.com'
    assert uri.path == '/some/path.html'
    assert uri.basename == 'path.html'
    assert uri.query == 'q=1&b=2'
    assert uri.fragment == 'fragment'


def test_parse_windows_path_escaped():
    uri = lsp.Uri.parse('c:%5CUsers%5CUser%5Cfolder%5Cfilename')
    assert uri.scheme == 'file'
    assert uri.authority == ''
    assert uri.path == '/c:/Users/User/folder/filename'
    assert uri.basename == 'filename'
    assert uri.query == ''
    assert uri.fragment == ''


def test_parse_windows_path():
    uri = lsp.Uri.parse('c:\\Users\\User\\folder\\filename')
    assert uri.scheme == 'file'
    assert uri.authority == ''
    assert uri.path == '/c:/Users/User/folder/filename'
    assert uri.basename == 'filename'
    assert uri.query == ''
    assert uri.fragment == ''


def test_parse_windows_file():
    uri = lsp.Uri.parse('file:///c%3A/Users/User/folder/filename')
    assert uri.scheme == 'file'
    assert uri.authority == ''
    assert uri.path == '/c:/Users/User/folder/filename'
    assert uri.basename == 'filename'
    assert uri.query == ''
    assert uri.fragment == ''


def test_parse_git():
    """The built-in git extension uses a non-standard format with an encoded query"""
    uri = lsp.Uri.parse(
        'git:/home/user/samples/bluetooth/mesh/light/prj.conf?%7B%22path%22%3A%22%2Fhome%2Fuser%2Fsamples%2Fbluetooth%2Fmesh%2Flight%2Fprj.conf%22%2C%22ref%22%3A%22~%22%7D'
    )
    assert uri.scheme == 'git'
    assert uri.authority == ''
    assert uri.path == '/home/user/samples/bluetooth/mesh/light/prj.conf'
    assert uri.basename == 'prj.conf'
    assert uri.query == '{"path":"/home/user/samples/bluetooth/mesh/light/prj.conf","ref":"~"}'
    assert uri.fragment == ''


def test_file():
    uri = lsp.Uri.file('/path/to/some/file')
    assert uri.scheme == 'file'
    assert uri.authority == ''
    assert uri.path == '/path/to/some/file'
    assert uri.basename == 'file'
    assert uri.query == ''
    assert uri.fragment == ''


def test_file_windows():
    uri = lsp.Uri.file('c:\\Users\\User\\folder\\filename')
    assert uri.scheme == 'file'
    assert uri.authority == ''
    assert uri.path == 'c:/Users/User/folder/filename'


def test_encode_windows_path():
    uri = lsp.Uri.file('c:\\Users\\User\\folder\\filename')
    assert str(uri) == 'file:///c%3A/Users/User/folder/filename'
