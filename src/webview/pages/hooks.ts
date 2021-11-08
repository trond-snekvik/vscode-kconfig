/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import { StateUpdater, useState, useCallback } from 'preact/hooks';
import { CallFunctionResponseMessage, StateUpdateMessage } from '../messages';
import { vscode } from '../vscodeInstance';
import { RemoteFunctionSignatures } from './callbackTypes';

type GenericCallback = (...args: unknown[]) => void;

const keyUpdaters: { [key: string]: StateUpdater<unknown> } = {};
let callId = 0;
const remoteCallbacks: { [key: number]: GenericCallback } = {};

function listenForMessages(evt: MessageEvent<{ type: string; payload: unknown }>) {
    if (evt.data.type === 'STATE_UPDATE') {
        const data = evt.data as StateUpdateMessage;
        const { key, value } = data.payload;
        if (keyUpdaters[key]) {
            keyUpdaters[key](value);
        }
    }
    if (evt.data.type === 'CALL_FUNCTION_RESPONSE') {
        const data = evt.data as CallFunctionResponseMessage;
        const { callId, args } = data.payload;
        const callback = remoteCallbacks[callId];
        delete remoteCallbacks[callId];
        callback(...args);
    }
}

window.addEventListener('message', listenForMessages);

type RemoteState = {};

export function useRemoteState<K extends keyof RemoteState, T = RemoteState[K]>(
    key: K
): [T | null, StateUpdater<T>] {
    const [value, setValue] = useState<T | null>(null);
    keyUpdaters[key] = setValue as StateUpdater<unknown>;

    function setRemoteValue(newValue: T | ((prevState: T) => T)) {
        vscode.postMessage({
            type: 'STATE_UPDATE_REQUEST',
            payload: { key, value: newValue },
        });
    }

    return [value, setRemoteValue];
}

/**
 * Returns a callback hook that will call the given function with the given arguments.
 * The functionName must be listed in `callbackTypes.ts` with a promise return type.
 * The function implementation is expected to be in the host class as a member function with
 * matching signature.
 *
 * @param functionName The name of the function to call.
 */
export function useRemoteFunction<FnName extends keyof RemoteFunctionSignatures>(
    functionName: FnName
): RemoteFunctionSignatures[FnName] {
    // @ts-ignore
    return useCallback((...args: unknown[]): Promise<unknown> => {
        // @ts-ignore
        return new Promise<unknown>((resolve) => {
            remoteCallbacks[callId] = resolve;
            vscode.postMessage({
                type: 'CALL_FUNCTION_REQUEST',
                payload: { functionName, callId: callId++, args },
            });
        });
    }, []);
}
