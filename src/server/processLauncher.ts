/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as childProcess from 'child_process';
import { Log, RootLogger } from '../logger';
import * as readline from 'readline';
import * as removeFolder from 'rimraf';
import * as stream from 'stream';
import * as util from 'util';
import { TimeoutError } from '../errors';
import { helper } from '../helper';

const removeFolderAsync = util.promisify(removeFolder);

const browserLog: Log = {
  name: 'browser',
};

const browserStdOutLog: Log = {
  name: 'browser:out',
};

const browserStdErrLog: Log = {
  name: 'browser:err',
  severity: 'warning'
};

export type Env = {[key: string]: string | number | boolean | undefined};

export type LaunchProcessOptions = {
  executablePath: string,
  args: string[],
  env?: Env,

  handleSIGINT?: boolean,
  handleSIGTERM?: boolean,
  handleSIGHUP?: boolean,
  pipe?: boolean,
  tempDirectories: string[],

  cwd?: string,

  // Note: attemptToGracefullyClose should reject if it does not close the browser.
  attemptToGracefullyClose: () => Promise<any>,
  onExit: (exitCode: number | null, signal: string | null) => void,
  logger: RootLogger,
};

type LaunchResult = {
  launchedProcess: childProcess.ChildProcess,
  gracefullyClose: () => Promise<void>,
  kill: () => Promise<void>,
};

export async function launchProcess(options: LaunchProcessOptions): Promise<LaunchResult> {
  const cleanup = async () => {
    await Promise.all(options.tempDirectories.map(dir => {
      return removeFolderAsync(dir).catch((err: Error) => console.error(err));
    }));
  };

  const logger = options.logger;
  const stdio: ('ignore' | 'pipe')[] = options.pipe ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
  logger._log(browserLog, `<launching> ${options.executablePath} ${options.args.join(' ')}`);
  const spawnedProcess = childProcess.spawn(
      options.executablePath,
      options.args,
      {
        // On non-windows platforms, `detached: true` makes child process a leader of a new
        // process group, making it possible to kill child process tree with `.kill(-pid)` command.
        // @see https://nodejs.org/api/child_process.html#child_process_options_detached
        detached: process.platform !== 'win32',
        env: (options.env as {[key: string]: string}),
        cwd: options.cwd,
        stdio,
      }
  );
  if (!spawnedProcess.pid) {
    let failed: (e: Error) => void;
    const failedPromise = new Promise<Error>((f, r) => failed = f);
    spawnedProcess.once('error', error => {
      failed(new Error('Failed to launch browser: ' + error));
    });
    return cleanup().then(() => failedPromise).then(e => Promise.reject(e));
  }
  logger._log(browserLog, `<launched> pid=${spawnedProcess.pid}`);

  const stdout = readline.createInterface({ input: spawnedProcess.stdout });
  stdout.on('line', (data: string) => {
    logger._log(browserStdOutLog, data);
  });

  const stderr = readline.createInterface({ input: spawnedProcess.stderr });
  stderr.on('line', (data: string) => {
    logger._log(browserStdErrLog, data);
  });

  let processClosed = false;
  let fulfillClose = () => {};
  const waitForClose = new Promise<void>(f => fulfillClose = f);
  let fulfillCleanup = () => {};
  const waitForCleanup = new Promise<void>(f => fulfillCleanup = f);
  spawnedProcess.once('exit', (exitCode, signal) => {
    logger._log(browserLog, `<process did exit ${exitCode}, ${signal}>`);
    processClosed = true;
    helper.removeEventListeners(listeners);
    options.onExit(exitCode, signal);
    fulfillClose();
    // Cleanup as process exits.
    cleanup().then(fulfillCleanup);
  });

  const listeners = [ helper.addEventListener(process, 'exit', killProcess) ];
  if (options.handleSIGINT) {
    listeners.push(helper.addEventListener(process, 'SIGINT', () => {
      gracefullyClose().then(() => process.exit(130));
    }));
  }
  if (options.handleSIGTERM)
    listeners.push(helper.addEventListener(process, 'SIGTERM', gracefullyClose));
  if (options.handleSIGHUP)
    listeners.push(helper.addEventListener(process, 'SIGHUP', gracefullyClose));

  let gracefullyClosing = false;
  async function gracefullyClose(): Promise<void> {
    // We keep listeners until we are done, to handle 'exit' and 'SIGINT' while
    // asynchronously closing to prevent zombie processes. This might introduce
    // reentrancy to this function, for example user sends SIGINT second time.
    // In this case, let's forcefully kill the process.
    if (gracefullyClosing) {
      logger._log(browserLog, `<forecefully close>`);
      killProcess();
      await waitForClose;  // Ensure the process is dead and we called options.onkill.
      return;
    }
    gracefullyClosing = true;
    logger._log(browserLog, `<gracefully close start>`);
    await options.attemptToGracefullyClose().catch(() => killProcess());
    await waitForCleanup;  // Ensure the process is dead and we have cleaned up.
    logger._log(browserLog, `<gracefully close end>`);
  }

  // This method has to be sync to be used as 'exit' event handler.
  function killProcess() {
    logger._log(browserLog, `<kill>`);
    helper.removeEventListeners(listeners);
    if (spawnedProcess.pid && !spawnedProcess.killed && !processClosed) {
      // Force kill the browser.
      try {
        if (process.platform === 'win32')
          childProcess.execSync(`taskkill /pid ${spawnedProcess.pid} /T /F`);
        else
          process.kill(-spawnedProcess.pid, 'SIGKILL');
      } catch (e) {
        // the process might have already stopped
      }
    }
    try {
      // Attempt to remove temporary directories to avoid littering.
      for (const dir of options.tempDirectories)
        removeFolder.sync(dir);
    } catch (e) { }
  }

  function killAndWait() {
    killProcess();
    return waitForCleanup;
  }

  return { launchedProcess: spawnedProcess, gracefullyClose, kill: killAndWait };
}

export function waitForLine(process: childProcess.ChildProcess, inputStream: stream.Readable, regex: RegExp, timeout: number, timeoutError: TimeoutError): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: inputStream });
    let stderr = '';
    const listeners = [
      helper.addEventListener(rl, 'line', onLine),
      helper.addEventListener(rl, 'close', () => onClose()),
      helper.addEventListener(process, 'exit', () => onClose()),
      helper.addEventListener(process, 'error', error => onClose(error))
    ];
    const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

    function onClose(error?: Error) {
      cleanup();
      reject(new Error([
        'Failed to launch browser!' + (error ? ' ' + error.message : ''),
        stderr,
        '',
        'TROUBLESHOOTING: https://github.com/Microsoft/playwright/blob/master/docs/troubleshooting.md',
        '',
      ].join('\n')));
    }

    function onTimeout() {
      cleanup();
      reject(timeoutError);
    }

    function onLine(line: string) {
      stderr += line + '\n';
      const match = line.match(regex);
      if (!match)
        return;
      cleanup();
      resolve(match);
    }

    function cleanup() {
      if (timeoutId)
        clearTimeout(timeoutId);
      helper.removeEventListeners(listeners);
    }
  });
}
