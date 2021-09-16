/* Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

// import * as fs from 'fs';
// import { globby } from 'globby';
import fs = require('fs');
import globby = require('globby');

const currentYear = new Date().getFullYear();

const COPYRIGHT_NOTICE = `/* Copyright (c) ${currentYear} Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

`;

const insert = Buffer.from(COPYRIGHT_NOTICE);

function addCopyrightNotice(filePath: string) {
    // Script modified from: https://stackoverflow.com/a/49889780/2480017
    const contents = fs.readFileSync(filePath);

    if (contents.slice(0, 16).equals(insert.slice(0, 16))) {
        console.info(`Skipping ${filePath}`);
        return;
    }

    const fileDescriptor = fs.openSync(filePath, 'w+');
    fs.writeSync(fileDescriptor, insert, 0, insert.length, 0);
    fs.writeSync(fileDescriptor, contents, 0, contents.length, insert.length);
    console.info(`Adding copyright notice to ${filePath}`);
    fs.close(fileDescriptor, (err) => {
        if (err) {
            throw err;
        }
    });
}

function checkCopyrightNotice(filePath: string) {
    // Script modified from: https://stackoverflow.com/a/49889780/2480017
    const contents = fs.readFileSync(filePath);

    // Return true if the copyright notice doesn't match so it is listed as a failure
    return !contents.slice(0, 16).equals(insert.slice(0, 16));
}

function main(args: string[]) {
    const mode = args[0];
    const allowedModes = ['apply', 'check'];
    if (!allowedModes.includes(mode)) {
        console.error(`Usage: npm run copyright <mode>

Where mode is: apply, check
`);
        return Promise.resolve(1);
    }

    const checkMode = mode === 'check';

    return globby([
        'scripts/**/*.(ts|js)',
        'src/**/*.(ts|tsx|js|css)',
        'test/**/*.(js|ts)',
        'assets/**/*.css',
    ]).then((files) => {
        if (checkMode) {
            const failed = files.filter(checkCopyrightNotice);

            if (failed.length !== 0) {
                console.error(`No copyright notice detected for: ${failed.join(', ')}\n`);
                return 1;
            }

            console.info('Finished checking copyright notices.');
            return 0;
        } else {
            files.forEach(addCopyrightNotice);
            console.info('Finished adding copyright notices.');
            return 0;
        }
    });
}

main(process.argv.slice(2)).then(function (status) {
    process.exit(status);
});
