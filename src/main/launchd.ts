import { execFile } from 'node:child_process'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  CreateLaunchdServiceInput,
  LaunchdAction,
  LaunchdPlistDocument,
  LaunchdPlistField,
  LaunchdTerminalMode,
  LaunchdService,
  RepositoryLaunchdDraft,
  RepositoryRunCommandOption,
  ServiceLoadSnapshot,
  ServiceAutomationSettings,
  ServiceLogFile,
  ServiceLogTarget,
  ServiceLogs,
  ServiceSource
} from '../shared/types'
import { getServiceStartBlocker } from './automation'
import { resolveGhosttyApp } from './ghostty'
import { removeAlias } from './store'

const execFileAsync = promisify(execFile)
const uid = process.getuid?.() ?? Number(process.env.UID ?? 0)
const userDomain = `gui/${uid}`
const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents')
const logLineCount = 300
const serviceLabelPattern = /^[A-Za-z0-9._-]+$/
const repositoryLabelPrefix = 'com.launchcontrol.repo'
const shellSafeWordPattern = /^[A-Za-z0-9_./:@+-]+$/
const preferredPackageScripts = ['start', 'serve', 'dev', 'preview']
const preferredMakeTargets = ['start', 'run', 'serve', 'dev']

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

interface PackageJsonMetadata {
  scripts: Record<string, string>
  packageManager: string | null
}

interface RuntimeState {
  loaded: boolean
  running: boolean
  pid: number | null
  lastExitStatus: number | null
}

interface LaunchAgentDefinition {
  label: string
  plistPath: string
  plistName: string
  serviceInfo: string | null
  runAtLoad: boolean
  keepAlive: boolean
  logTargets: ServiceLogTarget[]
}

interface TopProcessSnapshot {
  cpuPercent: number | null
  residentMemoryBytes: number | null
  energyImpact: number | null
  threads: number | null
  cpuTime: string | null
  state: string | null
}

interface PsProcessSnapshot {
  cpuPercent: number | null
  memoryPercent: number | null
  residentMemoryBytes: number | null
  virtualMemoryBytes: number | null
}

interface RuntimeSnapshotBundle {
  runtimeMap: Map<string, RuntimeState>
  disabledMap: Map<string, boolean>
  loadMap: Map<number, ServiceLoadSnapshot>
  sampledAt: string
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function normalizeRepositoryLabelPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/[.-]{2,}/g, '-')

  return normalized || 'service'
}

function createRepositoryServiceLabel(repositoryPath: string): string {
  return `${repositoryLabelPrefix}.${normalizeRepositoryLabelPart(basename(repositoryPath))}`
}

function shellQuote(value: string): string {
  if (shellSafeWordPattern.test(value)) {
    return value
  }

  return `'${value.replace(/'/g, `'\\''`)}'`
}

function createShellCommand(command: string): string {
  return `exec ${command}`
}

function normalizePackageScripts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0
    )
  )
}

async function readPackageJsonMetadata(repositoryPath: string): Promise<PackageJsonMetadata | null> {
  const packageJsonPath = join(repositoryPath, 'package.json')

  if (!(await pathExists(packageJsonPath))) {
    return null
  }

  const parsed = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts?: unknown
    packageManager?: unknown
  }

  return {
    scripts: normalizePackageScripts(parsed.scripts),
    packageManager: typeof parsed.packageManager === 'string' ? parsed.packageManager : null
  }
}

async function detectPackageManager(
  repositoryPath: string,
  metadata: PackageJsonMetadata
): Promise<PackageManager> {
  const declaredManager = metadata.packageManager?.split('@')[0]

  if (
    declaredManager === 'npm' ||
    declaredManager === 'pnpm' ||
    declaredManager === 'yarn' ||
    declaredManager === 'bun'
  ) {
    return declaredManager
  }

  if (await pathExists(join(repositoryPath, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }

  if (await pathExists(join(repositoryPath, 'yarn.lock'))) {
    return 'yarn'
  }

  if (
    (await pathExists(join(repositoryPath, 'bun.lock'))) ||
    (await pathExists(join(repositoryPath, 'bun.lockb')))
  ) {
    return 'bun'
  }

  return 'npm'
}

function formatPackageScriptCommand(packageManager: PackageManager, scriptName: string): string {
  return createShellCommand(
    `/usr/bin/env ${packageManager} run ${shellQuote(scriptName)}`
  )
}

function sortPackageScriptNames(scriptNames: string[]): string[] {
  return [...scriptNames].sort((left, right) => {
    const leftPreferredIndex = preferredPackageScripts.indexOf(left)
    const rightPreferredIndex = preferredPackageScripts.indexOf(right)

    if (leftPreferredIndex !== -1 || rightPreferredIndex !== -1) {
      if (leftPreferredIndex === -1) {
        return 1
      }

      if (rightPreferredIndex === -1) {
        return -1
      }

      return leftPreferredIndex - rightPreferredIndex
    }

    return left.localeCompare(right)
  })
}

async function createPackageRunCommandOptions(
  repositoryPath: string
): Promise<RepositoryRunCommandOption[]> {
  const metadata = await readPackageJsonMetadata(repositoryPath)

  if (!metadata) {
    return []
  }

  const packageManager = await detectPackageManager(repositoryPath, metadata)

  return sortPackageScriptNames(Object.keys(metadata.scripts)).map((scriptName) => ({
    id: `package:${scriptName}`,
    label: `${packageManager} run ${scriptName}`,
    command: formatPackageScriptCommand(packageManager, scriptName),
    detail: `package.json script: ${metadata.scripts[scriptName]}`
  }))
}

function getMakeTargetNames(content: string): string[] {
  const targets = new Set<string>()
  const targetPattern = /^([A-Za-z0-9_.-]+)\s*:(?![=])/gm
  let match: RegExpExecArray | null

  while ((match = targetPattern.exec(content))) {
    const targetName = match[1]

    if (!targetName.startsWith('.')) {
      targets.add(targetName)
    }
  }

  return [...targets]
}

async function createMakeRunCommandOptions(
  repositoryPath: string
): Promise<RepositoryRunCommandOption[]> {
  const makefilePath = join(repositoryPath, 'Makefile')

  if (!(await pathExists(makefilePath))) {
    return []
  }

  const targetNames = getMakeTargetNames(await readFile(makefilePath, 'utf8')).filter((targetName) =>
    preferredMakeTargets.includes(targetName)
  )

  return preferredMakeTargets
    .filter((targetName) => targetNames.includes(targetName))
    .map((targetName) => ({
      id: `make:${targetName}`,
      label: `make ${targetName}`,
      command: createShellCommand(`/usr/bin/env make ${shellQuote(targetName)}`),
      detail: `Makefile target: ${targetName}`
    }))
}

async function createProcfileRunCommandOptions(
  repositoryPath: string
): Promise<RepositoryRunCommandOption[]> {
  const procfilePath = join(repositoryPath, 'Procfile')

  if (!(await pathExists(procfilePath))) {
    return []
  }

  const lines = (await readFile(procfilePath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))

  return lines.flatMap((line) => {
    const separatorIndex = line.indexOf(':')

    if (separatorIndex === -1) {
      return []
    }

    const processName = line.slice(0, separatorIndex).trim()
    const command = line.slice(separatorIndex + 1).trim()

    if (!processName || !command) {
      return []
    }

    return [
      {
        id: `procfile:${processName}`,
        label: `Procfile ${processName}`,
        command: createShellCommand(command),
        detail: `Procfile entry: ${processName}`
      }
    ]
  })
}

async function createLanguageRunCommandOptions(
  repositoryPath: string
): Promise<RepositoryRunCommandOption[]> {
  const options: RepositoryRunCommandOption[] = []

  if (await pathExists(join(repositoryPath, 'Cargo.toml'))) {
    options.push({
      id: 'cargo:run',
      label: 'cargo run',
      command: createShellCommand('/usr/bin/env cargo run'),
      detail: 'Cargo project'
    })
  }

  if (await pathExists(join(repositoryPath, 'go.mod'))) {
    options.push({
      id: 'go:run',
      label: 'go run .',
      command: createShellCommand('/usr/bin/env go run .'),
      detail: 'Go module'
    })
  }

  return options
}

async function createRepositoryRunCommandOptions(
  repositoryPath: string
): Promise<RepositoryRunCommandOption[]> {
  const optionGroups = await Promise.all([
    createPackageRunCommandOptions(repositoryPath),
    createProcfileRunCommandOptions(repositoryPath),
    createMakeRunCommandOptions(repositoryPath),
    createLanguageRunCommandOptions(repositoryPath)
  ])
  const optionsByCommand = new Map<string, RepositoryRunCommandOption>()

  for (const option of optionGroups.flat()) {
    if (!optionsByCommand.has(option.command)) {
      optionsByCommand.set(option.command, option)
    }
  }

  return [...optionsByCommand.values()]
}

function formatLaunchSchedule(plist: Record<string, unknown>): string | null {
  if (typeof plist.StartInterval === 'number' && Number.isFinite(plist.StartInterval)) {
    return `every ${plist.StartInterval}s`
  }

  if (Array.isArray(plist.StartCalendarInterval) || typeof plist.StartCalendarInterval === 'object') {
    return 'calendar schedule'
  }

  if (Array.isArray(plist.WatchPaths) && plist.WatchPaths.length > 0) {
    return `watches ${plist.WatchPaths.length} path${plist.WatchPaths.length === 1 ? '' : 's'}`
  }

  return null
}

function formatLaunchTraits(plist: Record<string, unknown>): string[] {
  const traits: string[] = []

  if (plist.RunAtLoad === true) {
    traits.push('runs at load')
  }

  if (plist.KeepAlive === true) {
    traits.push('keeps alive')
  }

  const schedule = formatLaunchSchedule(plist)

  if (schedule) {
    traits.push(schedule)
  }

  return traits
}

function formatCommandSummary(plist: Record<string, unknown>): string | null {
  const programArguments = toStringArray(plist.ProgramArguments)

  if (programArguments.length > 0) {
    return programArguments.join(' ')
  }

  if (typeof plist.Program === 'string' && plist.Program.trim()) {
    return plist.Program.trim()
  }

  return null
}

function summarizePlist(plist: Record<string, unknown>): string | null {
  const command = formatCommandSummary(plist)
  const traits = formatLaunchTraits(plist)
  const parts = [command, ...traits].filter((part): part is string => Boolean(part))

  if (parts.length === 0) {
    return null
  }

  return parts.join(' · ')
}

function getSourceCommandCandidates(plist: Record<string, unknown>): string[] {
  const programArguments = toStringArray(plist.ProgramArguments)
  const program = typeof plist.Program === 'string' && plist.Program.trim() ? [plist.Program.trim()] : []

  return [...new Set([...programArguments, ...program].filter((entry) => entry.startsWith('/')))]
}

function scoreSourceCandidate(path: string): number {
  const extension = extname(path).toLowerCase()
  const scriptExtensions = new Set([
    '.sh',
    '.bash',
    '.zsh',
    '.command',
    '.py',
    '.rb',
    '.pl',
    '.php',
    '.js',
    '.mjs',
    '.cjs',
    '.ts'
  ])
  let score = 0

  if (scriptExtensions.has(extension)) {
    score += 6
  }

  if (path.includes('/Library/') || path.startsWith(homedir())) {
    score += 3
  }

  if (path.includes('/bin/') || path.includes('/usr/bin/')) {
    score -= 3
  }

  return score
}

function isTextBuffer(buffer: Buffer): boolean {
  return !buffer.subarray(0, 4096).includes(0)
}

async function readTextSource(path: string): Promise<string | null> {
  try {
    await access(path, constants.R_OK)
    const content = await readFile(path)

    if (!isTextBuffer(content)) {
      return null
    }

    return content.toString('utf8')
  } catch {
    return null
  }
}

async function resolveRunnerSource(
  plist: Record<string, unknown>
): Promise<{ path: string; content: string } | null> {
  const candidates = getSourceCommandCandidates(plist).sort(
    (left, right) => scoreSourceCandidate(right) - scoreSourceCandidate(left)
  )

  for (const candidate of candidates) {
    const content = await readTextSource(candidate)

    if (content !== null) {
      return { path: candidate, content }
    }
  }

  return null
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 10 * 1024 * 1024
  })

  if (stderr && stderr.trim()) {
    return `${stdout}${stderr}`
  }

  return stdout
}

async function runLaunchctl(args: string[]): Promise<string> {
  return run('/bin/launchctl', args)
}

function isLaunchctlBootstrapConflict(message: string): boolean {
  return message.includes('already bootstrapped') || message.includes('in progress')
}

function isBootstrapInputOutputError(error: unknown): boolean {
  return /Bootstrap failed:\s*5:\s*(Input\/output error|I\/O error)/i.test(String(error))
}

async function runTop(pids: number[]): Promise<string> {
  const args = [
    '-l',
    '1',
    '-stats',
    'pid,cpu,mem,power,threads,time,state',
    ...pids.flatMap((pid) => ['-pid', String(pid)]),
    '-n',
    String(Math.max(pids.length, 10))
  ]

  return run('/usr/bin/top', args)
}

async function runPs(pids: number[]): Promise<string> {
  return run('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,%cpu=,%mem=,rss=,vsz='])
}

function createEmptyLoadSnapshot(sampledAt: string): ServiceLoadSnapshot {
  return {
    cpuPercent: 0,
    gpuPercent: null,
    residentMemoryBytes: 0,
    virtualMemoryBytes: 0,
    memoryPercent: 0,
    vramBytes: null,
    energyImpact: 0,
    threads: 0,
    cpuTime: null,
    state: 'inactive',
    sampledAt
  }
}

function parseNumber(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseHumanBytes(value: string): number | null {
  const normalized = value.trim().toUpperCase()

  if (!normalized) {
    return null
  }

  const match = normalized.match(/^([\d.]+)\s*([BKMGT])?$/)

  if (!match) {
    return null
  }

  const amount = Number(match[1])

  if (!Number.isFinite(amount)) {
    return null
  }

  const unit = match[2] ?? 'B'
  const multipliers: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4
  }

  return Math.round(amount * multipliers[unit])
}

function parseTopProcessSnapshots(output: string): Map<number, TopProcessSnapshot> {
  const snapshots = new Map<number, TopProcessSnapshot>()
  const lines = output.split('\n')
  const headerIndex = lines.findIndex((line) => line.trim().startsWith('PID'))

  if (headerIndex === -1) {
    return snapshots
  }

  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    const [pidToken, cpuToken, memoryToken, powerToken, threadsToken, timeToken, stateToken] =
      trimmed.split(/\s+/, 7)
    const pid = Number(pidToken)

    if (!Number.isInteger(pid) || pid <= 0) {
      continue
    }

    snapshots.set(pid, {
      cpuPercent: parseNumber(cpuToken),
      residentMemoryBytes: parseHumanBytes(memoryToken),
      energyImpact: parseNumber(powerToken),
      threads: parseNumber(threadsToken),
      cpuTime: timeToken ?? null,
      state: stateToken ?? null
    })
  }

  return snapshots
}

function parsePsProcessSnapshots(output: string): Map<number, PsProcessSnapshot> {
  const snapshots = new Map<number, PsProcessSnapshot>()

  for (const line of output.split('\n')) {
    const trimmed = line.trim()

    if (!trimmed) {
      continue
    }

    const [pidToken, cpuToken, memoryToken, rssToken, vszToken] = trimmed.split(/\s+/, 5)
    const pid = Number(pidToken)

    if (!Number.isInteger(pid) || pid <= 0) {
      continue
    }

    const residentKilobytes = parseNumber(rssToken)
    const virtualBytes = parseNumber(vszToken)

    snapshots.set(pid, {
      cpuPercent: parseNumber(cpuToken),
      memoryPercent: parseNumber(memoryToken),
      residentMemoryBytes: residentKilobytes === null ? null : Math.round(residentKilobytes * 1024),
      virtualMemoryBytes: virtualBytes === null ? null : Math.round(virtualBytes * 1024)
    })
  }

  return snapshots
}

async function collectProcessLoadSnapshots(pids: number[]): Promise<Map<number, ServiceLoadSnapshot>> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))]

  if (uniquePids.length === 0) {
    return new Map()
  }

  const sampledAt = new Date().toISOString()
  const [topOutput, psOutput] = await Promise.all([runTop(uniquePids), runPs(uniquePids)])
  const topSnapshots = parseTopProcessSnapshots(topOutput)
  const psSnapshots = parsePsProcessSnapshots(psOutput)
  const snapshots = new Map<number, ServiceLoadSnapshot>()

  for (const pid of uniquePids) {
    const topSnapshot = topSnapshots.get(pid)
    const psSnapshot = psSnapshots.get(pid)

    snapshots.set(pid, {
      cpuPercent: topSnapshot?.cpuPercent ?? psSnapshot?.cpuPercent ?? null,
      gpuPercent: null,
      residentMemoryBytes:
        psSnapshot?.residentMemoryBytes ?? topSnapshot?.residentMemoryBytes ?? null,
      virtualMemoryBytes: psSnapshot?.virtualMemoryBytes ?? null,
      memoryPercent: psSnapshot?.memoryPercent ?? null,
      vramBytes: null,
      energyImpact: topSnapshot?.energyImpact ?? null,
      threads: topSnapshot?.threads ?? null,
      cpuTime: topSnapshot?.cpuTime ?? null,
      state: topSnapshot?.state ?? null,
      sampledAt
    })
  }

  return snapshots
}

function parseLaunchctlList(output: string): Map<string, RuntimeState> {
  const states = new Map<string, RuntimeState>()
  const lines = output.split('\n').slice(1).filter(Boolean)

  for (const line of lines) {
    const [pidToken, statusToken, label] = line.trim().split(/\s+/, 3)

    if (!label) {
      continue
    }

    const pid =
      pidToken && pidToken !== '-' && Number.isFinite(Number(pidToken))
        ? Number(pidToken)
        : null
    const lastExitStatus =
      statusToken && statusToken !== '-' && Number.isFinite(Number(statusToken))
        ? Number(statusToken)
        : null

    states.set(label, {
      loaded: true,
      running: pid !== null && pid > 0,
      pid,
      lastExitStatus
    })
  }

  return states
}

function parseDisabledMap(output: string): Map<string, boolean> {
  const disabledMap = new Map<string, boolean>()

  for (const line of output.split('\n')) {
    const match = line.match(/"(.+?)"\s*=>\s*(enabled|disabled)/)

    if (!match) {
      continue
    }

    disabledMap.set(match[1], match[2] === 'enabled')
  }

  return disabledMap
}

async function collectRuntimeSnapshotBundle(): Promise<RuntimeSnapshotBundle> {
  const [listOutput, disabledOutput] = await Promise.all([
    runLaunchctl(['list']),
    runLaunchctl(['print-disabled', userDomain])
  ])
  const runtimeMap = parseLaunchctlList(listOutput)
  const disabledMap = parseDisabledMap(disabledOutput)
  const sampledAt = new Date().toISOString()
  const loadMap = await collectProcessLoadSnapshots(
    [...runtimeMap.values()].flatMap((runtime) => (runtime.pid && runtime.pid > 0 ? [runtime.pid] : []))
  ).catch(() => new Map<number, ServiceLoadSnapshot>())

  return {
    runtimeMap,
    disabledMap,
    loadMap,
    sampledAt
  }
}

function buildServiceLoadSnapshot(
  pid: number | null,
  loadMap: Map<number, ServiceLoadSnapshot>,
  sampledAt: string
): ServiceLoadSnapshot {
  if (pid && pid > 0) {
    return loadMap.get(pid) ?? {
      ...createEmptyLoadSnapshot(sampledAt),
      cpuPercent: null,
      residentMemoryBytes: null,
      virtualMemoryBytes: null,
      memoryPercent: null,
      energyImpact: null,
      threads: null,
      state: null
    }
  }

  return createEmptyLoadSnapshot(sampledAt)
}

function applyRuntimeSnapshotToService(
  service: LaunchdService,
  snapshots: RuntimeSnapshotBundle
): LaunchdService {
  const runtime = snapshots.runtimeMap.get(service.label)
  const enabled = snapshots.disabledMap.get(service.label) ?? true
  const pid = runtime?.pid ?? null
  const loaded = runtime?.loaded ?? false
  const running = runtime?.running ?? false
  const lastExitStatus = runtime?.lastExitStatus ?? null
  const completed =
    !running &&
    loaded &&
    lastExitStatus === 0 &&
    service.runAtLoad &&
    !service.keepAlive

  return {
    ...service,
    enabled,
    loaded,
    running,
    completed,
    pid,
    lastExitStatus,
    status: running ? 'running' : completed ? 'completed' : loaded ? 'loaded' : 'stopped',
    load: buildServiceLoadSnapshot(pid, snapshots.loadMap, snapshots.sampledAt)
  }
}

async function parsePlistJson(plistPath: string): Promise<Record<string, unknown>> {
  const json = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath])
  return JSON.parse(json) as Record<string, unknown>
}

function getAbsolutePlistPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized && isAbsolute(normalized) ? normalized : null
}

function normalizeServiceLabelInput(value: string): string {
  return value.trim()
}

function assertValidServiceLabel(value: string): string {
  const label = normalizeServiceLabelInput(value)

  if (!label) {
    throw new Error('Service label is required.')
  }

  if (!serviceLabelPattern.test(label)) {
    throw new Error(
      'Service label may only contain letters, numbers, dots, dashes, and underscores.'
    )
  }

  return label
}

function formatPlistValidationMessage(error: unknown, fallbackMessage: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Command failed:[^\n]*\n?/, '').trim() || fallbackMessage
}

async function ensureDirectoryPath(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not create ${label} at ${path}: ${message}`)
  }
}

async function ensureFilePath(path: string, label: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '', { flag: 'a' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not create ${label} at ${path}: ${message}`)
  }
}

async function ensurePlistFilesystemTargets(plist: Record<string, unknown>): Promise<void> {
  const workingDirectory = getAbsolutePlistPath(plist.WorkingDirectory)

  if (workingDirectory) {
    await ensureDirectoryPath(workingDirectory, 'WorkingDirectory')
  }

  for (const directory of toStringArray(plist.QueueDirectories)) {
    if (isAbsolute(directory)) {
      await ensureDirectoryPath(directory, 'QueueDirectories entry')
    }
  }

  const stdoutPath = getAbsolutePlistPath(plist.StandardOutPath)

  if (stdoutPath) {
    await ensureFilePath(stdoutPath, 'StandardOutPath')
  }

  const stderrPath = getAbsolutePlistPath(plist.StandardErrorPath)

  if (stderrPath) {
    await ensureFilePath(stderrPath, 'StandardErrorPath')
  }

  for (const watchPath of toStringArray(plist.WatchPaths)) {
    if (isAbsolute(watchPath)) {
      await ensureDirectoryPath(dirname(watchPath), 'WatchPaths parent directory')
    }
  }
}

async function parseValidatedPlist(plistPath: string): Promise<Record<string, unknown>> {
  await run('/usr/bin/plutil', ['-lint', plistPath])
  return parsePlistJson(plistPath)
}

function formatBooleanFlag(value: unknown): string | null {
  if (value === true) {
    return 'Yes'
  }

  if (value === false) {
    return 'No'
  }

  return null
}

function formatPathList(value: unknown): string | null {
  const items = toStringArray(value)
  return items.length > 0 ? items.join('\n') : null
}

function formatCalendarEntry(entry: Record<string, unknown>): string {
  const orderedKeys = ['Month', 'Day', 'Weekday', 'Hour', 'Minute']
  const parts = orderedKeys
    .filter((key) => typeof entry[key] === 'number')
    .map((key) => `${key} ${entry[key]}`)

  return parts.join(', ')
}

function formatCalendarSchedule(value: unknown): string | null {
  if (Array.isArray(value)) {
    const entries = value
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map(formatCalendarEntry)
      .filter(Boolean)

    return entries.length > 0 ? entries.join('\n') : null
  }

  if (value && typeof value === 'object') {
    const entry = formatCalendarEntry(value as Record<string, unknown>)
    return entry || null
  }

  return null
}

function formatKeepAlive(value: unknown): string | null {
  if (value === true) {
    return 'Always restart when the job exits'
  }

  if (value === false) {
    return 'Do not auto-restart'
  }

  if (value && typeof value === 'object') {
    return 'Conditional keep-alive rules'
  }

  return null
}

function hasKeepAlive(plist: Record<string, unknown>): boolean {
  const keepAlive = plist.KeepAlive

  return keepAlive === true || Boolean(keepAlive && typeof keepAlive === 'object')
}

function createLaunchdField(
  key: string,
  value: string | null,
  help: string
): LaunchdPlistField | null {
  if (!value) {
    return null
  }

  return { key, value, help }
}

function buildPlistFields(
  plist: Record<string, unknown>,
  runnerPath: string | null
): LaunchdPlistField[] {
  return [
    createLaunchdField('Label', typeof plist.Label === 'string' ? plist.Label : null, 'Unique job identifier used by launchctl.'),
    createLaunchdField('Program', typeof plist.Program === 'string' ? plist.Program : null, 'Direct executable path. launchd prefers ProgramArguments for scripts with parameters.'),
    createLaunchdField('ProgramArguments', formatPathList(plist.ProgramArguments), 'Exact argv passed to the job. The first entry should be the executable or script path.'),
    createLaunchdField('Start script', runnerPath, 'Readable script file resolved from Program or ProgramArguments.'),
    createLaunchdField('RunAtLoad', formatBooleanFlag(plist.RunAtLoad), 'Starts the job as soon as the agent is loaded into launchd.'),
    createLaunchdField('KeepAlive', formatKeepAlive(plist.KeepAlive), 'Controls restart behavior after the job exits.'),
    createLaunchdField('StartInterval', typeof plist.StartInterval === 'number' ? `Every ${plist.StartInterval} seconds` : null, 'Interval-based schedule in seconds.'),
    createLaunchdField('StartCalendarInterval', formatCalendarSchedule(plist.StartCalendarInterval), 'Calendar schedule. Each entry can specify Month, Day, Weekday, Hour, and Minute.'),
    createLaunchdField('WatchPaths', formatPathList(plist.WatchPaths), 'launchd restarts the job when one of these paths changes.'),
    createLaunchdField('QueueDirectories', formatPathList(plist.QueueDirectories), 'launchd starts the job when these directories receive work.'),
    createLaunchdField('WorkingDirectory', typeof plist.WorkingDirectory === 'string' ? plist.WorkingDirectory : null, 'Default working directory before the command runs.'),
    createLaunchdField('StandardOutPath', typeof plist.StandardOutPath === 'string' ? plist.StandardOutPath : null, 'File that receives stdout from the job.'),
    createLaunchdField('StandardErrorPath', typeof plist.StandardErrorPath === 'string' ? plist.StandardErrorPath : null, 'File that receives stderr from the job.')
  ].filter((field): field is LaunchdPlistField => Boolean(field))
}

async function validatePlistFileContent(plistPath: string, content: string): Promise<void> {
  const previousContent = await readFile(plistPath, 'utf8')
  let wroteCandidate = false

  try {
    await writeFile(plistPath, content, 'utf8')
    wroteCandidate = true
    const plist = await parseValidatedPlist(plistPath)
    await ensurePlistFilesystemTargets(plist)
  } catch (error) {
    let restoreFailureMessage = ''

    if (wroteCandidate) {
      try {
        await writeFile(plistPath, previousContent, 'utf8')
      } catch (restoreError) {
        const restoreMessage =
          restoreError instanceof Error ? restoreError.message : String(restoreError)
        restoreFailureMessage = ` The previous plist content could not be restored: ${restoreMessage}`
      }
    }

    const formattedMessage = formatPlistValidationMessage(error, 'Invalid plist content.')

    throw new Error(`${formattedMessage}${restoreFailureMessage}`)
  }
}

export async function createRepositoryServiceDraft(
  repositoryPath: string
): Promise<RepositoryLaunchdDraft> {
  const repositoryStats = await stat(repositoryPath)

  if (!repositoryStats.isDirectory()) {
    throw new Error('Select a repository directory.')
  }

  const runCommandOptions = await createRepositoryRunCommandOptions(repositoryPath)
  const preferredOption = runCommandOptions[0] ?? null

  return {
    repositoryPath,
    repositoryName: basename(repositoryPath),
    label: createRepositoryServiceLabel(repositoryPath),
    runCommand: preferredOption?.command ?? '',
    runCommandSource:
      preferredOption?.detail ??
      'No standard run command was detected. Enter the command LaunchControl should run from this repository.',
    runCommandOptions
  }
}

export async function createService(input: CreateLaunchdServiceInput): Promise<void> {
  const label = assertValidServiceLabel(input.label)
  const plistContent = input.plistContent.trim()

  if (!plistContent) {
    throw new Error('Plist content is required.')
  }

  await mkdir(launchAgentsDir, { recursive: true })

  const plistPath = join(launchAgentsDir, `${label}.plist`)

  try {
    await access(plistPath, constants.F_OK)
    throw new Error(`${basename(plistPath)} already exists in ~/Library/LaunchAgents.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  const tempPlistPath = join(
    launchAgentsDir,
    `.${label}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.plist`
  )

  try {
    await writeFile(tempPlistPath, input.plistContent, 'utf8')
    const plist = await parseValidatedPlist(tempPlistPath)
    const plistLabel = typeof plist.Label === 'string' ? plist.Label.trim() : ''

    if (!plistLabel) {
      throw new Error('Plist must include a Label key.')
    }

    if (plistLabel !== label) {
      throw new Error(`Plist Label must match "${label}".`)
    }

    await ensurePlistFilesystemTargets(plist)
    await rename(tempPlistPath, plistPath)
  } catch (error) {
    throw new Error(formatPlistValidationMessage(error, 'Invalid plist content.'))
  } finally {
    await rm(tempPlistPath, { force: true })
  }
}

function mergeLogTargets(
  left: ServiceLogTarget[],
  right: ServiceLogTarget[]
): ServiceLogTarget[] {
  const merged = new Map<string, ServiceLogTarget>()

  for (const target of [...left, ...right]) {
    merged.set(`${target.kind}:${target.path}`, target)
  }

  return [...merged.values()]
}

function mergeDefinitions(
  current: LaunchAgentDefinition | undefined,
  next: LaunchAgentDefinition
): LaunchAgentDefinition {
  if (!current) {
    return next
  }

  const preferred =
    next.serviceInfo && !current.serviceInfo
      ? next
      : !current.plistPath && next.plistPath
        ? next
        : current
  const secondary = preferred === current ? next : current

  return {
    label: preferred.label,
    plistPath: preferred.plistPath,
    plistName: preferred.plistName,
    serviceInfo: preferred.serviceInfo ?? secondary.serviceInfo,
    logTargets: mergeLogTargets(preferred.logTargets, secondary.logTargets),
    runAtLoad: preferred.runAtLoad || secondary.runAtLoad,
    keepAlive: preferred.keepAlive || secondary.keepAlive
  }
}

async function listLaunchAgentDefinitions(): Promise<LaunchAgentDefinition[]> {
  try {
    const entries = await readdir(launchAgentsDir)
    const plistFiles = entries
      .filter((entry) => entry.endsWith('.plist'))
      .sort((left, right) => left.localeCompare(right))

    const definitions = await Promise.all(
      plistFiles.map(async (fileName) => {
        const plistPath = join(launchAgentsDir, fileName)
        const logTargets: ServiceLogTarget[] = []
        let plistName = fileName
        let label = basename(fileName, '.plist')
        let serviceInfo: string | null = null
        let runAtLoad = false
        let keepAlive = false

        try {
          const plist = await parsePlistJson(plistPath)
          label = String(plist.Label ?? label)
          plistName = basename(plistPath)
          serviceInfo = summarizePlist(plist)
          runAtLoad = plist.RunAtLoad === true
          keepAlive = hasKeepAlive(plist)
          const stdoutPath = plist.StandardOutPath
          const stderrPath = plist.StandardErrorPath

          if (typeof stdoutPath === 'string' && stdoutPath.trim()) {
            logTargets.push({ kind: 'stdout', path: stdoutPath })
          }

          if (typeof stderrPath === 'string' && stderrPath.trim()) {
            logTargets.push({ kind: 'stderr', path: stderrPath })
          }
        } catch {
          // Keep the service visible even if its plist cannot be parsed cleanly.
        }

        return {
          label,
          plistPath,
          plistName,
          serviceInfo,
          runAtLoad,
          keepAlive,
          logTargets
        }
      })
    )

    const uniqueDefinitions = new Map<string, LaunchAgentDefinition>()

    for (const definition of definitions) {
      uniqueDefinitions.set(
        definition.label,
        mergeDefinitions(uniqueDefinitions.get(definition.label), definition)
      )
    }

    return [...uniqueDefinitions.values()].sort((left, right) => left.label.localeCompare(right.label))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

export async function listServices(
  aliases: Record<string, string>,
  folders: Record<string, string>,
  automations: Record<string, ServiceAutomationSettings>
): Promise<LaunchdService[]> {
  const [definitions, runtimeSnapshots] = await Promise.all([
    listLaunchAgentDefinitions(),
    collectRuntimeSnapshotBundle()
  ])

  const services = definitions.map((definition) => {
    const baseService: LaunchdService = {
      label: definition.label,
      plistPath: definition.plistPath,
      plistName: definition.plistName,
      serviceInfo: definition.serviceInfo,
      enabled: true,
      loaded: false,
      running: false,
      completed: false,
      pid: null,
      lastExitStatus: null,
      status: 'stopped',
      runAtLoad: definition.runAtLoad,
      keepAlive: definition.keepAlive,
      logTargets: definition.logTargets,
      load: createEmptyLoadSnapshot(runtimeSnapshots.sampledAt),
      alias: null,
      folder: null,
      name: definition.label,
      automation: {
        startCondition: null,
        automaticStartTimes: [],
        startOnLaunch: false,
        launchDelaySeconds: 0,
        ensureRunning: false
      }
    }

    const alias = aliases[definition.label]?.trim() || null
    const folder = folders[definition.label]?.trim() || null
    const automation = automations[definition.label] ?? {
      startCondition: null,
      automaticStartTimes: [],
      startOnLaunch: false,
      launchDelaySeconds: 0,
      ensureRunning: false
    }

    return applyRuntimeSnapshotToService(
      {
        ...baseService,
        alias,
        folder,
        name: alias ?? definition.label,
        automation
      },
      runtimeSnapshots
    )
  })

  return services
}

export async function refreshServiceRuntimeSnapshots(
  services: LaunchdService[]
): Promise<LaunchdService[]> {
  const runtimeSnapshots = await collectRuntimeSnapshotBundle()

  return services.map((service) =>
    applyRuntimeSnapshotToService(service, runtimeSnapshots)
  )
}

async function bootstrapService(service: LaunchdService): Promise<void> {
  if (!service.plistPath) {
    return
  }

  try {
    await runLaunchctl(['bootstrap', userDomain, service.plistPath])
  } catch (error) {
    const message = String(error)

    if (!isLaunchctlBootstrapConflict(message)) {
      throw error
    }
  }
}

async function kickstartService(label: string): Promise<void> {
  await runLaunchctl(['kickstart', '-k', `${userDomain}/${label}`])
}

async function unloadService(service: LaunchdService): Promise<void> {
  if (service.plistPath) {
    await runLaunchctl(['bootout', userDomain, service.plistPath])
    return
  }

  await runLaunchctl(['bootout', `${userDomain}/${service.label}`])
}

async function unloadServiceIfLoaded(service: LaunchdService): Promise<void> {
  if (!service.loaded) {
    return
  }

  try {
    await unloadService(service)
  } catch {
    // A failed start can leave launchd's reported state stale; continue with a clean bootstrap attempt.
  }
}

async function resetServiceEnablement(service: LaunchdService): Promise<void> {
  await runLaunchctl(['disable', `${userDomain}/${service.label}`])
  await runLaunchctl(['enable', `${userDomain}/${service.label}`])
}

async function startService(service: LaunchdService, retriedAfterBootstrapIoError = false): Promise<void> {
  if (!service.enabled) {
    throw new Error('Enable the service before starting it.')
  }

  try {
    await unloadServiceIfLoaded(service)
    await bootstrapService(service)
    await kickstartService(service.label)
  } catch (error) {
    if (retriedAfterBootstrapIoError || !isBootstrapInputOutputError(error)) {
      throw error
    }

    await resetServiceEnablement(service)
    await startService(service, true)
  }
}

async function stopService(service: LaunchdService): Promise<void> {
  await unloadService(service)
}

async function restartService(service: LaunchdService): Promise<void> {
  await unloadServiceIfLoaded(service)
  await startService({ ...service, loaded: false })
}

async function enableService(service: LaunchdService): Promise<void> {
  await runLaunchctl(['enable', `${userDomain}/${service.label}`])
}

async function disableService(service: LaunchdService): Promise<void> {
  await runLaunchctl(['disable', `${userDomain}/${service.label}`])

  if (service.loaded) {
    try {
      await stopService(service)
    } catch {
      // Best-effort: the disable state is the primary effect.
    }
  }
}

async function deleteService(service: LaunchdService): Promise<void> {
  if (!service.plistPath) {
    throw new Error('This service does not have a managed plist file.')
  }

  if (service.loaded) {
    try {
      await stopService(service)
    } catch {
      // The file deletion below is still safe if the job is already gone.
    }
  }

  await rm(service.plistPath, { force: true })
  await removeAlias(service.label)
}

async function clearServiceLogFiles(service: LaunchdService): Promise<void> {
  await Promise.all(
    service.logTargets.map(async (target) => {
      try {
        await writeFile(target.path, '', 'utf8')
      } catch {
        // Missing or unwritable logs should not block the launchd action itself.
      }
    })
  )
}

export async function performAction(
  services: LaunchdService[],
  label: string,
  action: LaunchdAction
): Promise<void> {
  const service = services.find((candidate) => candidate.label === label)

  if (!service) {
    throw new Error(`Unknown launchd service: ${label}`)
  }

  switch (action) {
    case 'start':
      {
        const blocker = getServiceStartBlocker(service, services)

        if (blocker) {
          throw new Error(blocker)
        }
      }
      await clearServiceLogFiles(service)
      await startService(service)
      break
    case 'stop':
      await stopService(service)
      break
    case 'restart':
      await clearServiceLogFiles(service)
      await restartService(service)
      break
    case 'enable':
      await enableService(service)
      break
    case 'disable':
      await disableService(service)
      break
    case 'delete':
      await deleteService(service)
      break
    default: {
      const exhaustiveAction: never = action
      throw new Error(`Unhandled launchd action: ${exhaustiveAction}`)
    }
  }
}

async function readTail(path: string): Promise<ServiceLogFile> {
  try {
    await access(path, constants.R_OK)
    const content = await run('/usr/bin/tail', ['-n', String(logLineCount), path])

    return {
      kind: path.endsWith('.err.log') ? 'stderr' : 'stdout',
      path,
      exists: true,
      content
    }
  } catch {
    return {
      kind: path.endsWith('.err.log') ? 'stderr' : 'stdout',
      path,
      exists: false,
      content: ''
    }
  }
}

export async function readLogs(service: LaunchdService): Promise<ServiceLogs> {
  const files = await Promise.all(
    service.logTargets.map(async (target) => {
      const file = await readTail(target.path)
      return {
        ...file,
        kind: target.kind
      }
    })
  )

  return {
    label: service.label,
    name: service.name,
    files,
    generatedAt: new Date().toISOString()
  }
}

export async function readPlistDocument(service: LaunchdService): Promise<LaunchdPlistDocument> {
  if (!service.plistPath) {
    throw new Error('This service does not have a managed plist file.')
  }

  const plistContent = await readFile(service.plistPath, 'utf8')
  let runnerPath: string | null = null
  let fields: LaunchdPlistField[] = []

  try {
    const plist = await parsePlistJson(service.plistPath)
    const runnerSource = await resolveRunnerSource(plist)
    runnerPath = runnerSource?.path ?? null
    fields = buildPlistFields(plist, runnerPath)
  } catch {
    fields = runnerPath ? buildPlistFields({}, runnerPath) : []
  }

  return {
    label: service.label,
    plistPath: service.plistPath,
    plistContent,
    runnerPath,
    fields,
    generatedAt: new Date().toISOString()
  }
}

export async function savePlistDocument(service: LaunchdService, content: string): Promise<void> {
  if (!service.plistPath) {
    throw new Error('This service does not have a managed plist file.')
  }

  await validatePlistFileContent(service.plistPath, content)
}

export async function readServiceSource(service: LaunchdService): Promise<ServiceSource> {
  if (!service.plistPath) {
    throw new Error('This service does not have a managed plist file.')
  }

  const plistContent = await readFile(service.plistPath, 'utf8')

  try {
    const plist = await parsePlistJson(service.plistPath)
    const runnerSource = await resolveRunnerSource(plist)

    if (runnerSource) {
      return {
        label: service.label,
        kind: 'runner',
        path: runnerSource.path,
        content: runnerSource.content || '(empty file)',
        generatedAt: new Date().toISOString()
      }
    }
  } catch {
    // Fallback to the raw plist content when the plist cannot be parsed.
  }

  return {
    label: service.label,
    kind: 'plist',
    path: service.plistPath,
    content: plistContent || '(empty file)',
    generatedAt: new Date().toISOString()
  }
}

function quoteTerminalPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

function getTerminalLogTargets(service: LaunchdService, mode: LaunchdTerminalMode): ServiceLogTarget[] {
  if (mode === 'stdout' || mode === 'stderr') {
    return service.logTargets.filter((target) => target.kind === mode)
  }

  return mode === 'logs' ? service.logTargets : []
}

function buildGhosttyCommand(service: LaunchdService, mode: LaunchdTerminalMode): string {
  const commandParts = [
    `printf '\\nLaunchControl\\n'`,
    `printf 'Service: ${service.label}\\n\\n'`
  ]
  const logTargets = getTerminalLogTargets(service, mode)

  if (logTargets.length > 0) {
    const quotedPaths = logTargets.map((target) => quoteTerminalPath(target.path))
    commandParts.push(`printf 'Following ${mode === 'stdout' ? 'stdout' : mode === 'stderr' ? 'stderr' : 'declared logs'} from the end with: tail -n 0 -F ${quotedPaths.join(' ')}\\n\\n'`)
    commandParts.push(`tail -n 0 -F ${quotedPaths.join(' ')}; true`)
  } else {
    if (mode === 'stdout' || mode === 'stderr' || mode === 'logs') {
      commandParts.push(`printf 'No ${mode === 'logs' ? 'declared log targets' : mode} log target is declared for this service.\\n\\n'`)
    }
    commandParts.push(`launchctl print ${userDomain}/${service.label}`)
    commandParts.push(`printf '\\nSuggested commands:\\n'`)
    commandParts.push(`printf '  launchctl kickstart -k ${userDomain}/${service.label}\\n'`)
  }

  commandParts.push(`printf '\\nInteractive shell attached. Press Ctrl+C to stop a running command.\\n\\n'`)
  commandParts.push(`exec zsh -il`)
  return commandParts.join(' && ')
}

export function buildTerminalCommand(
  service: LaunchdService,
  mode: LaunchdTerminalMode
): string {
  return buildGhosttyCommand(service, mode)
}

export function getServiceWorkingDirectory(service: LaunchdService): string {
  return service.plistPath ? dirname(service.plistPath) : homedir()
}

export async function openGhostty(
  service: LaunchdService,
  mode: LaunchdTerminalMode
): Promise<void> {
  const ghosttyApp = await resolveGhosttyApp()
  const command = buildTerminalCommand(service, mode)

  await run('/usr/bin/open', [
    '-na',
    ghosttyApp,
    '--args',
    '-e',
    '/bin/zsh',
    '-lc',
    command
  ])
}
