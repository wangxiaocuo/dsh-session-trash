/**
 * Cross-platform unit-test entry point.
 *
 * `node --test test/*.test.js` only works where the shell expands globs; on
 * Windows `cmd.exe` passes the pattern through literally, and Node's test
 * runner does not expand it. This script enumerates the test files itself and
 * hands explicit paths to the runner, so `pnpm test` behaves the same on every
 * shell. Extra flags are forwarded before `--test`, e.g.
 * `node test/run-unit.mjs --experimental-test-coverage`.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const fileNames = await fs.readdir(testDir)
const files = fileNames
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name))

if (files.length === 0) {
  console.error(`no *.test.js files found in ${testDir}`)
  process.exit(1)
}

const child = spawn(process.execPath, [...process.argv.slice(2), '--test', ...files], {
  stdio: 'inherit',
})
child.on('error', (error) => {
  console.error(`cannot start the test runner: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`test runner terminated by ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
