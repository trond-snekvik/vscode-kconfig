/* Copyright (c) 2020 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

const path = require('path');
const { spawn } = require('child_process');

const shouldFix = process.argv[2] === '--fix';

function spawnInPromise(command, argv) {
    return new Promise((resolve, reject) => {
        spawn(command, argv, {
            env: process.env,
            shell: true,
            stdio: 'inherit',
        }).on('exit', (code) => (code !== 0 ? reject(code) : resolve()));
    });
}

function runESLint() {
    const eslint = path.join('node_modules', '.bin', 'eslint');
    const configFile = `"${require.resolve('../.eslintrc.js')}"`;
    const args = ['src', '--config', configFile];

    if (shouldFix) {
        args.push('--fix');
    }

    return spawnInPromise(eslint, args);
}

function runPrettier() {
    const prettier = path.join('node_modules', '.bin', 'prettier');
    const configFile = `"${require.resolve('../.prettierrc.js')}"`;
    const args = [shouldFix ? '--write' : '--check', '--config', configFile, 'src'];
    return spawnInPromise(prettier, args);
}

runPrettier().then(runESLint).catch(process.exit);
