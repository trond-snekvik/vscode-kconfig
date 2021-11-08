/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

import { GenericMessage } from './messages';

// @ts-ignore
export const vscode = window.acquireVsCodeApi<GenericMessage>();
