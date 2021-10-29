# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

import json
from rpc import RPCError, RPCServer, handler
from .mock_stream import MockStream, StreamEnd


class Server(RPCServer):
    def __init__(self):
        self.io = MockStream()
        self.received = []
        super().__init__(self.io, self.io)

    @handler('test')
    def handle_test_method(self, params):
        self.received.append(params)

    @handler('request')
    def handle_request(self, params):
        return params

    @handler('errorReq')
    def handle_error_request(self, params):
        raise RPCError(1234, 'error')

    @handler('manualResponse')
    def handle_manual_response(self, params):
        self.rsp(params)
        return {'invalid': 'invalid'}  # should be ignored


class Packet:
    def __init__(self, headers={}, content=None):
        self.headers = headers
        self.content = content

    def as_object(self):
        return json.loads(self.content)

    @staticmethod
    def create(obj):
        content = json.dumps(obj)
        return Packet({'Content-Length': len(content)}, content)

    def __str__(self):
        return ''.join([f'{h}: {self.headers[h]}\r\n'
                        for h in self.headers.keys()]) + '\r\n' + self.content


def pull_packet(io: MockStream):
    packet = Packet()
    while True:
        line = io.pull(io.output.index('\n') + 1)
        if len(line.strip()) == 0:
            break
        [name, value] = [part.strip() for part in line.split(':', 2)]
        packet.headers[name] = value
        if name == 'Content-Length':
            length = int(value)
    packet.content = io.pull(length)
    return packet


def push_packet(io: MockStream, obj):
    io.push(str(Packet.create(obj)))


def test_recv():
    srv = Server()

    # Push a raw packet to ensure that the push_packet format isn't broken:
    srv.io.push(''.join(['Content-Length: 36\r\n\r\n', '{"jsonrpc": "2.0", "method": "test"}']))

    push_packet(srv.io, {'jsonrpc': '2.0', 'method': 'test'})

    try:
        srv.loop()
    except StreamEnd:
        assert len(srv.received) == 2
        assert srv.received[0] == None
        assert srv.received[1] == None
        return
    assert False


def test_invalid_len():
    srv = Server()

    # too short:
    srv.io.push(''.join(['Content-Length: 34\r\n\r\n', '{"jsonrpc": "2.0", "method": "test"}']))

    try:
        srv.loop()
    except json.decoder.JSONDecodeError:
        assert len(srv.received) == 0
        return  # expected, as the value isn't long enough
    except:
        assert False

    srv.io.push(''.join(['Content-Length: 39\r\n\r\n', '{"jsonrpc": "2.0", "method": "test"}']))

    try:
        srv.loop()
    except StreamEnd:
        assert len(srv.received) == 0
        return  # expected, as the value is too long
    except:
        assert False


def test_unknown_headers():
    srv = Server()

    srv.io.push(''.join([
        'Some random header: "some random value that is ignored"\r\n', 'Another random header\r\n',
        '\r\r\r\r\r\rignoring CR\r\n', 'Content-Length: 36\r\n\r\n',
        '{"jsonrpc": "2.0", "method": "test"}'
    ]))

    try:
        srv.loop()
    except StreamEnd:
        assert len(srv.received) == 1
        return
    assert False


def test_notify():
    srv = Server()
    srv.notify('someMethod', {'param': [1, 2, 3]})
    notification = pull_packet(srv.io)
    assert len(notification.headers.keys()) == 2
    assert notification.headers['Content-Length']
    assert len(notification.content) == int(notification.headers['Content-Length'])
    assert notification.as_object() == {
        "jsonrpc": "2.0",
        "method": "someMethod",
        "params": {
            "param": [1, 2, 3]
        }
    }


def test_req():
    srv = Server()

    rsp = None

    def handle_rsp(r):
        nonlocal rsp
        assert rsp == None
        rsp = r

    srv.req('someMethod', {'param': [1, 2, 3]}, handle_rsp)

    req = pull_packet(srv.io)
    assert len(req.headers.keys()) == 2
    assert req.headers['Content-Length']
    assert len(req.content) == int(req.headers['Content-Length'])
    assert req.as_object() == {
        "jsonrpc": "2.0",
        "id": 0,
        "method": "someMethod",
        "params": {
            "param": [1, 2, 3]
        }
    }

    rsp_params = {'param': [1, 2, 3]}
    push_packet(srv.io, {'jsonrpc': '2.0', 'id': 0, 'result': rsp_params})

    # Second response is ignored:
    push_packet(srv.io, {'jsonrpc': '2.0', 'id': 0, 'result': {'invalid params': 'unexpected'}})

    try:
        srv.loop()
    except StreamEnd:
        pass

    assert rsp
    assert rsp.result == rsp_params
    assert rsp.error == None


def test_req_handler():
    srv = Server()
    req_params = {'test': True}

    # Send a request:
    push_packet(srv.io, {'jsonrpc': '2.0', 'id': 5, 'method': 'request', 'params': req_params})

    try:
        srv.loop()
    except StreamEnd:
        pass

    # got a response:
    rsp = pull_packet(srv.io).as_object()
    assert rsp['id'] == 5
    assert rsp['result'] == req_params  # handler is just returning our params

    # Send another request:
    push_packet(srv.io, {
        'jsonrpc': '2.0',
        'id': 6,
        'method': 'manualResponse',
        'params': req_params
    })

    try:
        srv.loop()
    except StreamEnd:
        pass

    # got a response:
    rsp = pull_packet(srv.io).as_object()
    assert rsp['id'] == 6
    assert rsp['result'] == req_params  # handler is just returning our params

    # Send a request that results in an error:
    push_packet(srv.io, {'jsonrpc': '2.0', 'id': 7, 'method': 'errorReq', 'params': req_params})

    try:
        srv.loop()
    except StreamEnd:
        pass

    # got an error response:
    rsp = pull_packet(srv.io).as_object()
    assert rsp['id'] == 7
    assert rsp['error']['code'] == 1234
    assert rsp['error']['message'] == 'error'
    assert rsp['result'] == None


def test_notification_handler():
    srv = Server()
    req_params = {'test': True}

    # Send a notification to a handler that returns a response:
    push_packet(srv.io, {'jsonrpc': '2.0', 'method': 'request', 'params': req_params})
    # Send a notification to a handler that sends a response:
    push_packet(srv.io, {'jsonrpc': '2.0', 'method': 'manualResponse', 'params': req_params})
    # Send a notification to a handler that raises an exception:
    push_packet(srv.io, {'jsonrpc': '2.0', 'method': 'errorReq', 'params': req_params})

    try:
        srv.loop()
    except StreamEnd:
        pass  # Not expecting any exceptions to break the loop

    # Expect no response, as we were sending notifications:
    assert srv.io.pull() == ''
