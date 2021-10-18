# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

from lsp import Position, Range, TextDocument, Uri
import os.path as path

# Test the LSP TextDocument class and accompanying classes

start_range = Range(Position.start(), Position.start())
test_file = path.join(path.dirname(__file__), 'resources', 'test.txt')


def test_position():
    with open(test_file, 'r') as f:
        doc = TextDocument(Uri.file(test_file), f.read())
    assert doc.pos(0) == Position.start()
    assert doc.pos(138) == Position(1, 27)
    assert doc.offset(Position(0, 111)) == doc.offset(Position(0, 999))  # end of line
    assert doc.offset(Position(32, 0)) == doc.offset(Position(999, 0))  # end of file
    assert doc.word_at(Position(1, 29)) == 'Nullam'  # at " Nu|llam"
    assert doc.word_at(Position(1, 27)) == 'Nullam'  # at " |Nullam"
    assert doc.word_at(Position(1, 33)) == 'Nullam'  # at " Nullam|"
    assert doc.word_at(Position(33, 0)) == None  # out-of-bounds
    assert doc.get(Range(Position.start(), Position.end())) == doc.text
    assert doc.get(Range(Position(0, 0), Position(0, 999999))) == doc.lines[0]
    assert doc.get(Range(Position(0, 0), Position(1, 0))) == doc.lines[0] + '\n'


def test_replace():
    doc = TextDocument(Uri.file('/some/file.txt'))
    doc.replace('the first line', start_range)
    assert doc.text == 'the first line\n'

    doc.replace('<insert>', start_range)
    assert doc.text == '<insert>the first line\n'

    doc.replace('<replace>', Range(Position(0, 0), Position(0, len('<insert>'))))
    assert doc.text == '<replace>the first line\n'

    doc.replace('<replace>', Range(Position(0, 13), Position(0, 18)))
    assert doc.text == '<replace>the <replace> line\n'

    doc.replace('', Range(Position(0, 13), Position(0, 23)))
    assert doc.text == '<replace>the line\n'

    doc.replace('\nsecond ', Range(Position(0, 12), Position(0, 13)))
    assert doc.text == '<replace>the\nsecond line\n'

    doc.replace('updated line', Range(Position(1, 0), Position(1, 9999)))
    assert doc.text == '<replace>the\nupdated line\n'

    # delete second line:
    doc.replace('', Range(Position(1, 0), Position(1, 9999)))
    assert doc.text == '<replace>the\n'

    # add more lines:
    doc.replace('\n\n\n', Range(Position(0, 9999), Position(0, 9999)))
    assert doc.text == '<replace>the\n\n\n\n'

    # Replace multiple lines:
    doc.replace('abc\ndef', Range(Position(1, 0), Position(3, 9999)))
    assert doc.text == '<replace>the\nabc\ndef\n'


def test_disk_access():
    def fail_read():
        try:
            doc.read(5)
            assert False  # should have thrown in read, since doc is closed
        except IOError as e:
            pass

    doc = TextDocument(Uri.file(test_file))
    doc.open()
    assert doc.readline(
    ) == 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Aliquam in elit arcu. Nunc vitae facilisis mauris. Ut\n'
    assert doc.readline(
    ) == 'venenatis euismod lacinia. Nullam nibh felis, scelerisque id dapibus nec, elementum nec velit. Vestibulum vel metus\n'
    assert doc.read(9) == 'et tortor'
    doc.seek(6)
    assert doc.read(5) == 'ipsum'
    doc.close()
    fail_read()

    with doc.open('r') as opened:
        assert opened.read(11) == 'Lorem ipsum'
    fail_read()

    doc = TextDocument.from_disk(Uri.file(test_file))
    assert doc.word_at(Position.start()) == 'Lorem'
    fail_read()

    try:
        TextDocument.from_disk(Uri.file('./some/file/that/doesnt/exist'))
        assert False  # Expected to throw
    except IOError as e:
        pass


def test_line_iterator():
    doc = TextDocument.from_disk(Uri.file(test_file))

    for i, line in enumerate(doc):
        assert line == doc.lines[i]
