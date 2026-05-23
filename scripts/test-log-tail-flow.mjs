import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const rootDir = resolve(import.meta.dirname, '..')
const appPath = resolve(rootDir, 'src/renderer/src/App.tsx')
const launchdPath = resolve(rootDir, 'src/main/launchd.ts')

assert.ok(existsSync(appPath), 'renderer App.tsx should exist')
assert.ok(existsSync(launchdPath), 'main launchd.ts should exist')

const appSource = readFileSync(appPath, 'utf8')
const launchdSource = readFileSync(launchdPath, 'utf8')

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

console.log('log tail flow tests passed')
