/* Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

export interface GenericMessage {
    type: string;
    payload: unknown;
}

export interface StateUpdateMessage extends GenericMessage {
    payload: {
        key: string;
        value: unknown;
    };
}

export interface CallFunctionRequestMessage extends GenericMessage {
    payload: {
        functionName: string;
        callId: number;
        args: unknown[];
    };
}

export interface CallFunctionResponseMessage extends GenericMessage {
    payload: {
        callId: number;
        args: unknown[];
    };
}
