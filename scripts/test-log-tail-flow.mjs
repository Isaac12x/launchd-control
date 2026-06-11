import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const Module = require('node:module')
const ts = require('typescript')
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = resolve(rootDir, 'src/renderer/src/App.tsx')
const launchdPath = resolve(rootDir, 'src/main/launchd.ts')
const terminalLogsPath = resolve(rootDir, 'src/main/terminalLogs.ts')

assert.ok(existsSync(appPath), 'renderer App.tsx should exist')
assert.ok(existsSync(launchdPath), 'main launchd.ts should exist')
assert.ok(existsSync(terminalLogsPath), 'terminal log preparation helper should exist')

const appSource = readFileSync(appPath, 'utf8')
const launchdSource = readFileSync(launchdPath, 'utf8')
const terminalLogsSource = readFileSync(terminalLogsPath, 'utf8')
const compiled = ts.transpileModule(terminalLogsSource, {
  compilerOptions: {
    esModuleInterop: true,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  },
  fileName: terminalLogsPath
})
const terminalLogsModule = new Module(terminalLogsPath)
terminalLogsModule.filename = terminalLogsPath
terminalLogsModule.paths = Module._nodeModulePaths(dirname(terminalLogsPath))
terminalLogsModule._compile(compiled.outputText, terminalLogsPath)
const { prepareTerminalLogTargets } = terminalLogsModule.exports

assert.match(
  appSource,
  /async function openLogTerminal\([\s\S]*?window\.launchdControl\.openTerminal\(label, kind\)[\s\S]*?mode: 'terminal',[\s\S]*?terminalMode: kind/,
  'log buttons should open an embedded terminal session for the selected stdout/stderr stream'
)

const openLogBody = appSource.match(/async function openLog\([\s\S]*?\n  }\n\n  async function closeEmbeddedTerminal/)?.[0] ?? ''
assert.match(openLogBody, /await openLogTerminal\(label, kind\)/, 'direct log opens should use the live terminal helper')
assert.doesNotMatch(openLogBody, /readLogs|buildLogPanel/, 'direct log opens must not render the static tail snapshot')

assert.doesNotMatch(
  appSource,
  /setContentPanel\(buildLogPanel/,
  'renderer code should not navigate to the legacy static log panel after live-tail fixes'
)

assert.match(
  launchdSource,
  /tail -n 0 -F \$\{quotedPaths\.join\(' '\)\}; true/,
  'terminal log commands should follow declared log files from EOF and keep the shell chain alive after Ctrl+C'
)

assert.equal(typeof prepareTerminalLogTargets, 'function')

const tempDirectory = await mkdtemp(join(tmpdir(), 'launchcontrol-terminal-logs-'))
const stdoutPath = join(tempDirectory, 'existing', 'stdout.log')
const stderrPath = join(tempDirectory, 'missing', 'nested', 'stderr.log')
const service = {
  logTargets: [
    { kind: 'stdout', path: stdoutPath },
    { kind: 'stderr', path: stderrPath }
  ]
}

try {
  await prepareTerminalLogTargets(service, 'stderr')

  assert.equal(
    existsSync(stdoutPath),
    false,
    'preparing stderr should not create an unrelated stdout target'
  )
  assert.equal(existsSync(stderrPath), true, 'preparing stderr should create its missing log file')

  writeFileSync(stderrPath, 'existing log output')
  await prepareTerminalLogTargets(service, 'stderr')
  assert.equal(
    await readFile(stderrPath, 'utf8'),
    'existing log output',
    'preparing a terminal target must preserve existing log content'
  )
} finally {
  await rm(tempDirectory, { recursive: true, force: true })
}

console.log('log tail flow tests passed')
