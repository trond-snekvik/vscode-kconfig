/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

export type RemoteFunctionSignatures = {};

type RemoteFunctionSignature = {
    [key in keyof RemoteFunctionSignatures]?: RemoteFunctionSignatures[key];
};

export type RemoteFunctionProvider = RemoteFunctionSignature;
