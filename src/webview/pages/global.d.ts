/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

interface Window {
    acquireVsCodeApi: <Message = unknown, State = unknown>() => {
        getState: () => State;
        setState: (data: State) => void;
        postMessage: (msg: Message) => void;
    };
}
