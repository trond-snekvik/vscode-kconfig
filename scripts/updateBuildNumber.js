/* Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

const pkgJson = require('../package.json');
const { resolve } = require('path');

require('fs').writeFileSync(
    resolve(__dirname, '../package.json'),
    JSON.stringify(
        {
            ...pkgJson,
            version: `${process.argv[2]}`,
        },
        null,
        2
    )
);
