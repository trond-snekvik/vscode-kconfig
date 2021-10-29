# Copyright (c) 2021 Nordic Semiconductor ASA
#
# SPDX-License-Identifier: LicenseRef-Nordic-1-Clause

import inspect
from typing import Any, Callable, Union, Optional
import sys
import os
import json
import enum
from datetime import datetime
"""
Remote procedure call implementation.

This file implements a JSON remote procedure call server, for JSON-RPC version 2.0.
"""

JSONRPC = '2.0'
if os.linesep == '\n':
    LINE_ENDING = '\r\n'
else:
    # On Windows, Python will replace any \n characters in stdout with \r\n.
    # Since this can't be easily changed, it's easier to just let it do its thing.
    # See https://stackoverflow.com/questions/49709309/prevent-python-prints-automatic-newline-conversion-to-crlf-on-windows
    LINE_ENDING = '\n'


def encode_json(o):
    def encoder(obj):
        if hasattr(obj, 'to_dict'):
            return obj.to_dict()
        return obj.__dict__

    return json.dumps(o, default=encoder)


class RPCMsg:
    def __init__(self, jsonrpc: str):
        """
        RPC message baseclass for all RPC communication between an RPC Server and an RPC Client.

        Parameters
        ----------
        jsonrpc: str
            JSON-RPC version. Should normally be '2.0'
        """
        self.jsonrpc = jsonrpc

    @staticmethod
    def from_obj(obj):
        if 'id' in obj:
            if 'method' in obj:
                return RPCRequest(obj['id'], obj['method'], obj.get('params'))

            return RPCResponse(obj['id'], obj.get('result'),
                               RPCError.create(obj['error']) if obj.get('error') else None)

        return RPCNotification(obj['method'], obj.get('params'))


class RPCRequest(RPCMsg):
    def __init__(self, id: Union[str, int], method: str, params: Any = None):
        """
        RPC request message.

        Requests can be issued in both directions, and the receiver should issue an
        RPC response message with a matching ID.

        The request is a remote procedure call to the given method, which must be
        implemented by the receiving side.

        Parameters
        ----------
        id: str | int
            Unique request ID.
        method: str
            Remote method to invoke.
        params: object, list, None
            Optional parameters to pass to the invoked method.
            The parameters are recursively encoded to json before being sent.
        """
        super().__init__(JSONRPC)
        self.id = id
        self.method = method
        self.params = params


class RPCErrorCode(enum.IntEnum):
    """Standard error codes for RPC messages"""
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    SERVER_NOT_INITIALIZED = -32002
    UNKNOWN_ERROR_CODE = -32001
    CONTENT_MODIFIED = -32801
    REQUEST_CANCELLED = -32800


class RPCError(Exception):
    def __init__(self, code: int, message: str, data=None):
        """
        RPC Error exception type.

        RPCErrors may be raised by request handlers to notify the other party that the
        request failed. The error will be caught by the server class and encoded as an
        RPCResponse for the current RPCRequest.

        Parameters
        ----------
        code: int
            Error code. Either a standard RPCErrorCode, or an application specific error.
        message: str
            Human readable error message. Will be presented in the UI.
        data: Any
            Error data.
        """
        super().__init__()
        self.code = code
        self.message = message
        self.data = data

    def to_dict(self):
        return {"code": self.code, "message": self.message, "data": self.data}

    @staticmethod
    def create(obj):
        return RPCError(obj['code'], obj['message'], obj.get('data'))


class RPCResponse(RPCMsg):
    def __init__(self, id: Optional[Union[str, int]] = None, result=None, error: RPCError = None):
        """
        RPC Response message.

        RPCResponses are issued as a response to an RPCRequest. The response's ID must match the
        corresponding request ID.

        Parameters
        ----------
        id: str | int
            ID of the request this response belongs to.
        result: Any | None
            Optional result of the request. Encoded as a json object.
        error: Any | None
            Optional RPCError associated with the response.
        """
        super().__init__(JSONRPC)
        self.id = id
        self.result = result
        self.error = error


class RPCNotification(RPCMsg):
    def __init__(self, method: str, params=None):
        """
        RPC Notification message.

        RPCNotifications are unacknowledged messages, that may be issued both by the server and the
        client. Notifications do not contain an ID, and the receiver cannot provide a response to
        the sender.

        Parameters
        ----------
        method: str
            Remote method to invoke.
        params: object, list, None
            Optional parameters to pass to the invoked method.
            The parameters are recursively encoded to json before being sent.
        """
        super().__init__(JSONRPC)
        self.method = method
        self.params = params


def handler(method: str):
    """
    RPC message handler attribute.
    Used to wrap handler methods in the RPCServer class:

    @handler('textDocument/didChange')
    def handle_did_change(self, params):
        pass

    Parameters
    ----------
    method: str
        The method implemented by the handler.
    """
    def wrapper(f):
        f._rsp_method = method
        return f

    return wrapper


class RPCServer:
    def __init__(self, istream=None, ostream=None):
        """
        RPC Server class.

        The RPC Server handles and issues RPC messages from an RPC Client.
        Handlers should be registered as methods using the handler attribute
        above.

        The RPCServer should not be instantiated as-is, but rather be extended
        by a class implementing all the requested handlers (such as LSPServer).
        To start listening from the given IO streams, call the RPCServer
        instance's loop() function. This will block until self.running is False.

        Message handlers registerd with @handler() will process requests and
        notifications. The RPCServer class will generate a response to request
        messages based on the return value of the handler function.
        To respond to a successfully processed request message, either return
        from the handler function, or call RPCServer.rsp(). To return an error
        from a handler function, either raise an exception or pass an error
        to RPCServer.rsp(). Raise an RPCError exception to control the status
        code and parameters of the error response.

        Parameters
        ----------
        istream: TextIO | None
            Input stream for the incoming data, or sys.stdin if None.
        ostream: TextIO | None
            Output stream for the incoming data, or sys.stdout if None.
        """
        self._send_stream = ostream if ostream else sys.stdout
        self._recv_stream = istream if istream else sys.stdin
        self._req = None
        self.log_file = 'lsp.log'
        self.logging = False
        self.running = True
        self.handlers = {}
        self.requests = {}
        self.request_id = 0
        for method_name, _ in inspect.getmembers(self.__class__):
            method = getattr(self.__class__, method_name)
            if hasattr(method, '_rsp_method'):
                self.handlers[method._rsp_method] = method

        # Flush log file:
        with open(self.log_file, 'a') as f:
            f.write('=' * 80 + '\n')

    def dbg(self, *args):
        """Write a debug message to the log file."""
        if self.logging:
            with open(self.log_file, 'a') as f:
                for line in args:
                    f.write('dbg: ' + str(line) + '\n')

    def log(self, *args):
        """Write an info message to the log file."""
        if self.logging:
            sys.stderr.write('\n'.join(*args) + '\n')
            with open(self.log_file, 'a') as f:
                for line in args:
                    f.write('inf: ' + str(line) + '\n')

    def _read_headers(self):
        """Internal: Read RPC headers from the input stream"""
        length = 0
        content_type = ''
        while True:
            line = self._recv_stream.readline().strip()
            if len(line) == 0:
                return length, content_type

            parts = [p.strip() for p in line.split(':')]
            if len(parts) != 2:
                continue

            [key, value] = parts

            if key == 'Content-Length':
                length = int(value)
            elif key == 'Content-Type':
                content_type = value

    def rsp(self, result=None, error: RPCError = None):
        """
        Manually respond to the request currently being processed.
        An RPCResponse object is created with the request's ID and the given result and error
        parameters, and issued to the connected client.

        Responses are normally created from the handlers return value, but may be issued
        manually if the request is expected to take a long time, or returning the response
        through the handler is somehow not practical. If a response has been sent, the
        return code of the handler is ignored.

        Note that attempting to send a response when handling a notification raises an
        exception.

        Parameters
        ----------
        result: Any
            Optional result of the current request.
        error: RPCError | None
            Optional
        """
        if not self._req:
            raise Exception('No command')

        self._send(RPCResponse(self._req.id, result, error))
        self._req = None

    def req(self, method: str, params, handler: Optional[Callable[[RPCResponse], Any]] = None):
        """
        Issue a request to the client.

        Requests must specify a remote method to invoke, and may optionally supply parameters to
        the method and a response handler.

        The response handler will be called once the client issues an RPCResponse with an ID
        matching the issued request. The request ID is generated from an internal counter.

        Example::

            self.req('remoteFunction', [1, 2, 3], lambda rsp: print(rsp.result))

        Parameters
        ----------
        method: str
            Remote method to invoke.
        params: Any
            Optional parameters for the method.
        handler: Callable
            Optional response handler. Takes an RPCResponse object as its only parameter
        """
        if handler:
            self.requests[self.request_id] = handler
        self._send(RPCRequest(self.request_id, method, params))
        self.request_id += 1

    def notify(self, method: str, params):
        """
        Issue a notification to the client.

        Notifications must specify a remote method to invoke, and may optionally supply parameters
        to the method. Notifications do not get responses.

        Example::

            self.notify('remoteFunction', [1, 2, 3])

        Parameters
        ----------
        method: str
            Remote method to invoke.
        params: Any
            Optional parameters for the method.
        """

        self._send(RPCNotification(method, params))

    def _send(self, msg: RPCMsg):
        """Internal: Send an RPCMessage to the client"""
        raw = encode_json(msg)
        self.dbg('send: ' + raw)
        self._send_stream.write(
            LINE_ENDING.join([
                'Content-Type: "application/vscode-jsonrpc; charset=utf-8"',
                'Content-Length: ' + str(len(raw)), '', raw
            ]))
        self._send_stream.flush()

    def _recv(self) -> Union[RPCNotification, RPCRequest, RPCResponse]:
        """Internal: Receive an RPCMessage from the recv_stream"""
        length, _ = self._read_headers()
        data = self._recv_stream.read(length)

        self.dbg('recv: {}'.format(data))

        obj = json.loads(data)

        return RPCMsg.from_obj(obj)

    def handle(self, msg: Union[RPCNotification, RPCRequest, RPCResponse]):
        """
        Handle an RPCMessage.
        Forwards the message to the appropriate message handler, or the registered response
        handler, if the message is an RPCResponse.

        For requests, the return value of the handler will be issued as a response, unless the
        handler calls self.rsp() manually.
        """
        if isinstance(msg, RPCResponse):
            handler = self.requests.get(msg.id)
            if handler:
                handler(msg)
                del self.requests[msg.id]
            return

        if isinstance(msg, RPCRequest):
            self._req = msg

        self.dbg('{} Method: {}'.format(type(msg).__name__, msg.method))

        if msg.method in self.handlers:
            error = None
            result = None
            start = datetime.now()
            try:
                result = self.handlers[msg.method](self, msg.params)
            except RPCError as e:
                self.dbg('Failed with error ' + str(e))
                error = e
            except Exception as e:
                self.dbg('Failed with error ' + str(e))
                error = RPCError(RPCErrorCode.UNKNOWN_ERROR_CODE, 'Exception: "{}"'.format(e.args))

            end = datetime.now()
            self.dbg('Handled in {} us'.format((end - start).microseconds))

            if self._req:
                self.rsp(result, error)
        else:
            self.dbg('No handler for "{}"'.format(msg.method))
            if self._req:
                self.rsp(
                    None,
                    RPCError(RPCErrorCode.METHOD_NOT_FOUND,
                             'Unknown method "{}"'.format(msg.method)))

    def loop(self):
        """
        Process messages in a loop.
        The loop is only aborted if self.running is set to False,
        or a keyboard interrupt is received.
        """
        try:
            while self.running:
                self.handle(self._recv())
        except KeyboardInterrupt:
            pass
