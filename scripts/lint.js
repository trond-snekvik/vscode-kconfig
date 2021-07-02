/* Copyright (c) 2020 - 2021, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Use in source and binary forms, redistribution in binary form only, with
 * or without modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions in binary form, except as embedded into a Nordic
 *    Semiconductor ASA integrated circuit in a product or a software update for
 *    such product, must reproduce the above copyright notice, this list of
 *    conditions and the following disclaimer in the documentation and/or other
 *    materials provided with the distribution.
 *
 * 2. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * 3. This software, with or without modification, must only be used with a Nordic
 *    Semiconductor ASA integrated circuit.
 *
 * 4. Any software provided in binary form under this license must not be reverse
 *    engineered, decompiled, modified and/or disassembled.
 *
 * THIS SOFTWARE IS PROVIDED BY NORDIC SEMICONDUCTOR ASA "AS IS" AND ANY EXPRESS OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
 * TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
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
        }).on('exit', (code) => (code !== 0) ? reject(code) : resolve());
    });
}

function runESLint() {
    const eslint = path.join('node_modules', '.bin', 'eslint');
    const configFile = `"${require.resolve('../.eslintrc.js')}"`;
    const args = ['src', '--ext', '.ts', '--config', configFile];

    if (shouldFix) {
        args.push('--fix');
    }

    return spawnInPromise(eslint, args);
}

function runPrettier() {
    const prettier = path.join('node_modules', '.bin', 'prettier');
    const configFile = `"${require.resolve('../.prettierrc.js')}"`;
    const patterns = ['src/**/*.ts'];
    const args = [shouldFix ? '--write' : '--check', ...patterns.map(p => `"${p}"`), '--config', configFile];
    return spawnInPromise(prettier, args);
}

function checkTypeScriptTypes() {
    const tsc = path.join('node_modules', '.bin', 'tsc');
    return spawnInPromise(tsc, ['--noEmit']);
}

runPrettier().then(runESLint).then(checkTypeScriptTypes).catch(process.exit);
