import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import type { CSSProperties, DragEvent, KeyboardEvent, MouseEvent } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import {
  ArrowLeft,
  ArrowDownZA,
  ArrowUpAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Check,
  ChevronRight,
  FileText,
  Folder,
  LayoutGrid,
  ListTree,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCcw,
  RotateCw,
  Search,
  Square,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import type {
  CreateLaunchdServiceInput,
  LaunchdAction,
  LaunchdPlistDocument,
  LaunchdService,
  LaunchdTerminalMode,
  RepositoryLaunchdDraft,
  ServiceLoadSnapshot,
  ServiceAutomationSettings,
  ServiceLogs,
  StartConditionState,
  TerminalExitEvent,
  TerminalSessionInfo
} from '@shared/types'
import { getTreeServiceDisplayState, mergeLiveRuntimeServices } from './liveRuntime'
import { buildRepositoryRunShellCommand } from './repositoryTemplate'

type LogKind = 'stdout' | 'stderr'
type CardFeedbackTone = 'neutral' | 'progress' | 'success' | 'error'
type ServiceViewMode = 'grid' | 'tree'
type ServiceSortField = 'name' | 'usage'
type ServiceSortDirection = 'asc' | 'desc'
type ServiceSortOption = `${ServiceSortField}-${ServiceSortDirection}`
type CreateServiceMode = 'plist' | 'repository'
type SidebarSection = 'overview' | 'services'
type RecoverableLaunchdAction = Extract<LaunchdAction, 'start' | 'restart'>
type TreeFolderAction = Extract<LaunchdAction, 'start' | 'stop' | 'restart' | 'enable' | 'disable'>
type ServiceLoadResolver = (service: LaunchdService) => ServiceLoadSnapshot

interface CardFeedback {
  tone: CardFeedbackTone
  message: string
}

interface FailureHint {
  title: string
  detail: string
}

interface ServiceActionFailure {
  action: RecoverableLaunchdAction
  message: string
  occurredAt: string
  hints: FailureHint[]
}

interface ServiceLoadMetricDisplay {
  label: string
  value: string
  title: string
  unavailable?: boolean
}

interface LogPanelState {
  mode: 'log'
  title: string
  subtitle: string
  content: string
  serviceLabel: string
  kind: LogKind
  generatedAt: string
  failure: ServiceActionFailure | null
}

interface TerminalPanelState {
  mode: 'terminal'
  session: TerminalSessionInfo
  serviceLabel: string
  terminalMode: LaunchdTerminalMode
  failure?: ServiceActionFailure | null
}

type ContentPanelState =
  | { mode: 'services' }
  | { mode: 'create' }
  | LogPanelState
  | TerminalPanelState
type ServiceTreeNode = ServiceTreeFolder | ServiceTreeLeaf

interface ServiceTreeFolder {
  type: 'folder'
  name: string
  path: string
  children: ServiceTreeNode[]
  serviceCount: number
  runningCount: number
}

interface ServiceTreeLeaf {
  type: 'service'
  path: string
  leafName: string
  service: LaunchdService
}

interface LaunchdPlistSnippet {
  key: string
  title: string
  description: string
  snippet: string
  insertText?: string
}

interface TreeFolderContextMenuState {
  path: string
  name: string
  labels: string[]
  left: number
  top: number
}

interface RepositoryCreateState {
  draft: RepositoryLaunchdDraft | null
  runCommand: string
  commandOptionId: string
  runAtLoad: boolean
  keepAlive: boolean
  busy: boolean
}

const servicesPanel: ContentPanelState = { mode: 'services' }
const createServicePanel: ContentPanelState = { mode: 'create' }
const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/
const liveRefreshIntervalMs = 1000
const treeServiceLabelsMimeType = 'application/x-launchcontrol-service-labels'
const serviceLabelPattern = /^[A-Za-z0-9._-]+$/
const defaultCreateServiceLabel = 'com.example.agent'
const treeFolderMenuActions: TreeFolderAction[] = [
  'start',
  'stop',
  'restart',
  'enable',
  'disable'
]
const launchdPlistLibrary: LaunchdPlistSnippet[] = [
  {
    key: 'label',
    title: 'Label',
    description: 'Unique reverse-DNS identifier for the job.',
    snippet: '<key>Label</key>\n<string>com.example.agent</string>'
  },
  {
    key: 'program',
    title: 'Program',
    description: 'Absolute executable path when you are not using an argument array.',
    snippet: '<key>Program</key>\n<string>/usr/local/bin/example</string>'
  },
  {
    key: 'programArguments',
    title: 'ProgramArguments',
    description: 'Preferred command definition for scripts and executables with arguments.',
    snippet:
      '<key>ProgramArguments</key>\n<array>\n  <string>/bin/zsh</string>\n  <string>/Users/you/bin/job.sh</string>\n</array>'
  },
  {
    key: 'workingDirectory',
    title: 'WorkingDirectory',
    description: 'Sets the current directory before launchd starts the process.',
    snippet: '<key>WorkingDirectory</key>\n<string>/Users/you/projects/app</string>'
  },
  {
    key: 'environmentVariables',
    title: 'EnvironmentVariables',
    description: 'Adds environment variables for the launched process.',
    snippet:
      '<key>EnvironmentVariables</key>\n<dict>\n  <key>PATH</key>\n  <string>/opt/homebrew/bin:/usr/bin:/bin</string>\n  <key>NODE_ENV</key>\n  <string>production</string>\n</dict>'
  },
  {
    key: 'runAtLoad',
    title: 'RunAtLoad',
    description: 'Starts the job immediately when the agent loads.',
    snippet: '<key>RunAtLoad</key>\n<true />'
  },
  {
    key: 'keepAlive',
    title: 'KeepAlive',
    description: 'Relaunches the job whenever it exits.',
    snippet: '<key>KeepAlive</key>\n<true />'
  },
  {
    key: 'keepAliveConditions',
    title: 'KeepAlive Conditions',
    description: 'Relaunches based on specific launchd conditions instead of every exit.',
    snippet:
      '<key>KeepAlive</key>\n<dict>\n  <key>SuccessfulExit</key>\n  <false />\n  <key>NetworkState</key>\n  <true />\n</dict>'
  },
  {
    key: 'startInterval',
    title: 'StartInterval',
    description: 'Runs the job on a fixed second-based interval.',
    snippet: '<key>StartInterval</key>\n<integer>300</integer>'
  },
  {
    key: 'startCalendarInterval',
    title: 'StartCalendarInterval',
    description: 'Runs on a specific schedule using calendar fields.',
    snippet:
      '<key>StartCalendarInterval</key>\n<array>\n  <dict>\n    <key>Hour</key>\n    <integer>9</integer>\n    <key>Minute</key>\n    <integer>30</integer>\n  </dict>\n</array>'
  },
  {
    key: 'watchPaths',
    title: 'WatchPaths',
    description: 'Triggers a launch when the listed paths change.',
    snippet:
      '<key>WatchPaths</key>\n<array>\n  <string>/Users/you/Library/Application Support/MyApp/config.json</string>\n</array>'
  },
  {
    key: 'queueDirectories',
    title: 'QueueDirectories',
    description: 'Runs when files appear in the listed queue directories.',
    snippet:
      '<key>QueueDirectories</key>\n<array>\n  <string>/Users/you/queue</string>\n</array>'
  },
  {
    key: 'startOnMount',
    title: 'StartOnMount',
    description: 'Starts the job when filesystems are mounted.',
    snippet: '<key>StartOnMount</key>\n<true />'
  },
  {
    key: 'standardOutPath',
    title: 'StandardOutPath',
    description: 'Redirects stdout to a file that is easy to tail.',
    snippet: '<key>StandardOutPath</key>\n<string>/tmp/example-agent.out.log</string>'
  },
  {
    key: 'standardErrorPath',
    title: 'StandardErrorPath',
    description: 'Redirects stderr to a file for crash and startup diagnostics.',
    snippet: '<key>StandardErrorPath</key>\n<string>/tmp/example-agent.err.log</string>'
  },
  {
    key: 'processType',
    title: 'ProcessType',
    description: 'Hints how aggressively the system should treat the job.',
    snippet: '<key>ProcessType</key>\n<string>Background</string>'
  },
  {
    key: 'throttleInterval',
    title: 'ThrottleInterval',
    description: 'Adds a cooldown between relaunch attempts.',
    snippet: '<key>ThrottleInterval</key>\n<integer>10</integer>'
  },
  {
    key: 'nice',
    title: 'Nice',
    description: 'Adjusts process priority for lower-importance work.',
    snippet: '<key>Nice</key>\n<integer>1</integer>'
  },
  {
    key: 'umask',
    title: 'Umask',
    description: 'Controls default file permissions for files the job creates.',
    snippet: '<key>Umask</key>\n<integer>18</integer>'
  },
  {
    key: 'userName',
    title: 'UserName',
    description: 'Runs the job as a specific user when launchd allows it.',
    snippet: '<key>UserName</key>\n<string>your-user</string>'
  },
  {
    key: 'groupName',
    title: 'GroupName',
    description: 'Runs the job with a specific group.',
    snippet: '<key>GroupName</key>\n<string>staff</string>'
  },
  {
    key: 'sessionCreate',
    title: 'SessionCreate',
    description: 'Creates a new login session for the launched process.',
    snippet: '<key>SessionCreate</key>\n<true />'
  },
  {
    key: 'limitLoadToSessionType',
    title: 'LimitLoadToSessionType',
    description: 'Restricts the job to a launchd session class.',
    snippet:
      '<key>LimitLoadToSessionType</key>\n<array>\n  <string>Aqua</string>\n</array>'
  },
  {
    key: 'enableTransactions',
    title: 'EnableTransactions',
    description: 'Lets the process participate in launchd transactions.',
    snippet: '<key>EnableTransactions</key>\n<true />'
  },
  {
    key: 'enablePressuredExit',
    title: 'EnablePressuredExit',
    description: 'Allows launchd to request exit under memory pressure.',
    snippet: '<key>EnablePressuredExit</key>\n<true />'
  },
  {
    key: 'abandonProcessGroup',
    title: 'AbandonProcessGroup',
    description: 'Prevents launchd from terminating the entire child process group on exit.',
    snippet: '<key>AbandonProcessGroup</key>\n<true />'
  },
  {
    key: 'exitTimeOut',
    title: 'ExitTimeOut',
    description: 'How long launchd waits for clean shutdown before escalation.',
    snippet: '<key>ExitTimeOut</key>\n<integer>20</integer>'
  },
  {
    key: 'timeOut',
    title: 'TimeOut',
    description: 'How long launchd waits for a check-in or socket-based service.',
    snippet: '<key>TimeOut</key>\n<integer>30</integer>'
  },
  {
    key: 'initGroups',
    title: 'InitGroups',
    description: 'Initializes supplementary groups for the launched process.',
    snippet: '<key>InitGroups</key>\n<true />'
  },
  {
    key: 'rootDirectory',
    title: 'RootDirectory',
    description: 'Changes the process root before execution.',
    snippet: '<key>RootDirectory</key>\n<string>/private/var/empty</string>'
  },
  {
    key: 'softResourceLimits',
    title: 'SoftResourceLimits',
    description: 'Applies soft resource caps such as max open files.',
    snippet:
      '<key>SoftResourceLimits</key>\n<dict>\n  <key>NumberOfFiles</key>\n  <integer>1024</integer>\n</dict>'
  },
  {
    key: 'hardResourceLimits',
    title: 'HardResourceLimits',
    description: 'Applies hard resource caps that the process cannot exceed.',
    snippet:
      '<key>HardResourceLimits</key>\n<dict>\n  <key>NumberOfFiles</key>\n  <integer>4096</integer>\n</dict>'
  },
  {
    key: 'machServices',
    title: 'MachServices',
    description: 'Registers Mach service names provided by the job.',
    snippet:
      '<key>MachServices</key>\n<dict>\n  <key>com.example.agent</key>\n  <true />\n</dict>'
  },
  {
    key: 'sockets',
    title: 'Sockets',
    description: 'Defines sockets that launchd creates and passes to the job.',
    snippet:
      '<key>Sockets</key>\n<dict>\n  <key>Listeners</key>\n  <dict>\n    <key>SockServiceName</key>\n    <string>8080</string>\n  </dict>\n</dict>'
  }
]
const launchdCommandLibrary: LaunchdPlistSnippet[] = [
  {
    key: 'launchctlPrint',
    title: 'Print job state',
    description: 'Inspect the loaded job state and recent launchd details.',
    snippet: 'launchctl print gui/$(id -u)/com.example.agent',
    insertText: '<!-- launchd: launchctl print gui/$(id -u)/com.example.agent -->'
  },
  {
    key: 'launchctlBootstrap',
    title: 'Load plist',
    description: 'Load a LaunchAgent plist into the current GUI session.',
    snippet: 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.agent.plist',
    insertText:
      '<!-- launchd: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.agent.plist -->'
  },
  {
    key: 'launchctlBootout',
    title: 'Unload plist',
    description: 'Unload a LaunchAgent plist from the current GUI session.',
    snippet: 'launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.agent.plist',
    insertText:
      '<!-- launchd: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.example.agent.plist -->'
  },
  {
    key: 'launchctlKickstart',
    title: 'Kickstart job',
    description: 'Start a loaded job immediately through launchd.',
    snippet: 'launchctl kickstart -k gui/$(id -u)/com.example.agent',
    insertText: '<!-- launchd: launchctl kickstart -k gui/$(id -u)/com.example.agent -->'
  },
  {
    key: 'launchctlEnable',
    title: 'Enable job',
    description: 'Allow launchd to run this label in the GUI session.',
    snippet: 'launchctl enable gui/$(id -u)/com.example.agent',
    insertText: '<!-- launchd: launchctl enable gui/$(id -u)/com.example.agent -->'
  },
  {
    key: 'launchctlDisable',
    title: 'Disable job',
    description: 'Prevent launchd from running this label in the GUI session.',
    snippet: 'launchctl disable gui/$(id -u)/com.example.agent',
    insertText: '<!-- launchd: launchctl disable gui/$(id -u)/com.example.agent -->'
  }
]

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const helper = window.document.createElement('textarea')
  helper.value = value
  helper.setAttribute('readonly', 'true')
  helper.style.position = 'fixed'
  helper.style.opacity = '0'
  window.document.body.append(helper)
  helper.select()
  window.document.execCommand('copy')
  helper.remove()
}

function normalizeServiceLabelInput(value: string): string {
  return value.trim()
}

function buildLaunchAgentPath(label: string): string {
  return `~/Library/LaunchAgents/${label}.plist`
}

function buildNewServiceTemplate(label: string): string {
  const normalizedLabel = normalizeServiceLabelInput(label) || defaultCreateServiceLabel

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${normalizedLabel}</string>

  <!-- Replace this command before starting the service. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>echo "Replace ProgramArguments for ${normalizedLabel} before enabling this service."</string>
  </array>

  <key>StandardOutPath</key>
  <string>/tmp/${normalizedLabel}.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/${normalizedLabel}.err.log</string>
</dict>
</plist>`
}

function escapePlistString(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function buildRepositoryServiceTemplate({
  label,
  repositoryPath,
  runCommand,
  runAtLoad,
  keepAlive
}: {
  label: string
  repositoryPath: string
  runCommand: string
  runAtLoad: boolean
  keepAlive: boolean
}): string {
  const normalizedLabel = normalizeServiceLabelInput(label) || defaultCreateServiceLabel
  const command = buildRepositoryRunShellCommand(repositoryPath, runCommand)
  const runAtLoadBlock = runAtLoad
    ? `
  <key>RunAtLoad</key>
  <true />
`
    : ''
  const keepAliveBlock = keepAlive
    ? `
  <key>KeepAlive</key>
  <true />

  <key>ThrottleInterval</key>
  <integer>10</integer>
`
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlistString(normalizedLabel)}</string>

  <key>WorkingDirectory</key>
  <string>${escapePlistString(repositoryPath)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${escapePlistString(command)}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
${runAtLoadBlock}${keepAliveBlock}
  <key>StandardOutPath</key>
  <string>/tmp/${escapePlistString(normalizedLabel)}.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/${escapePlistString(normalizedLabel)}.err.log</string>
</dict>
</plist>`
}

function getServiceSortField(sortOption: ServiceSortOption): ServiceSortField {
  return sortOption.startsWith('usage-') ? 'usage' : 'name'
}

function getServiceSortDirection(sortOption: ServiceSortOption): ServiceSortDirection {
  return sortOption.endsWith('-desc') ? 'desc' : 'asc'
}

function toggleServiceSort(
  currentSort: ServiceSortOption,
  field: ServiceSortField
): ServiceSortOption {
  if (getServiceSortField(currentSort) !== field) {
    return `${field}-asc`
  }

  return `${field}-${getServiceSortDirection(currentSort) === 'asc' ? 'desc' : 'asc'}`
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: ServiceSortDirection
): number {
  if (left === null && right === null) {
    return 0
  }

  if (left === null) {
    return 1
  }

  if (right === null) {
    return -1
  }

  return direction === 'asc' ? right - left : left - right
}

function compareServiceUsage(
  left: LaunchdService,
  right: LaunchdService,
  direction: ServiceSortDirection,
  resolveLoad: ServiceLoadResolver = (service) => service.load
): number {
  if (left.running !== right.running) {
    return left.running ? -1 : 1
  }

  const leftLoad = resolveLoad(left)
  const rightLoad = resolveLoad(right)
  const comparisons = [
    compareNullableNumbers(leftLoad.cpuPercent, rightLoad.cpuPercent, direction),
    compareNullableNumbers(leftLoad.gpuPercent, rightLoad.gpuPercent, direction),
    compareNullableNumbers(leftLoad.residentMemoryBytes, rightLoad.residentMemoryBytes, direction),
    compareNullableNumbers(leftLoad.vramBytes, rightLoad.vramBytes, direction),
    compareNullableNumbers(leftLoad.memoryPercent, rightLoad.memoryPercent, direction),
    compareNullableNumbers(leftLoad.energyImpact, rightLoad.energyImpact, direction)
  ]

  for (const comparison of comparisons) {
    if (comparison !== 0) {
      return comparison
    }
  }

  return left.name.localeCompare(right.name) || left.label.localeCompare(right.label)
}

function sortServices(
  services: LaunchdService[],
  sortOption: ServiceSortOption,
  resolveLoad?: ServiceLoadResolver
): LaunchdService[] {
  return [...services].sort((left, right) => {
    switch (sortOption) {
      case 'name-desc':
        return right.name.localeCompare(left.name) || right.label.localeCompare(left.label)
      case 'usage-desc':
        return compareServiceUsage(left, right, 'desc', resolveLoad)
      case 'usage-asc':
        return compareServiceUsage(left, right, 'asc', resolveLoad)
      case 'name-asc':
      default:
        return left.name.localeCompare(right.name) || left.label.localeCompare(right.label)
    }
  })
}

function countBy(services: LaunchdService[], predicate: (service: LaunchdService) => boolean): number {
  return services.filter(predicate).length
}

function getSelectedLabel(
  services: LaunchdService[],
  currentLabel: string | null
): string | null {
  if (currentLabel && services.some((service) => service.label === currentLabel)) {
    return currentLabel
  }

  return services[0]?.label ?? null
}

function getActionLabel(action: LaunchdAction): string {
  switch (action) {
    case 'start':
      return 'Start'
    case 'stop':
      return 'Stop'
    case 'restart':
      return 'Restart'
    case 'enable':
      return 'Enable'
    case 'disable':
      return 'Disable'
    case 'delete':
      return 'Delete'
    default: {
      const exhaustiveAction: never = action
      return exhaustiveAction
    }
  }
}

function getActionProgress(action: LaunchdAction): string {
  switch (action) {
    case 'start':
      return 'Starting'
    case 'stop':
      return 'Stopping'
    case 'restart':
      return 'Restarting'
    case 'enable':
      return 'Enabling'
    case 'disable':
      return 'Disabling'
    case 'delete':
      return 'Deleting'
    default: {
      const exhaustiveAction: never = action
      return exhaustiveAction
    }
  }
}

function getActionDone(action: LaunchdAction): string {
  switch (action) {
    case 'start':
      return 'Started'
    case 'stop':
      return 'Stopped'
    case 'restart':
      return 'Restarted'
    case 'enable':
      return 'Enabled'
    case 'disable':
      return 'Disabled'
    case 'delete':
      return 'Deleted'
    default: {
      const exhaustiveAction: never = action
      return exhaustiveAction
    }
  }
}

function getTreeFolderActionLabel(action: TreeFolderAction): string {
  return action === 'start' ? 'Run all' : `${getActionLabel(action)} all`
}

function getLogButtonLabel(kind: LogKind): string {
  return kind === 'stderr' ? 'err' : 'output'
}

function getLogHeading(kind: LogKind): string {
  return kind === 'stderr' ? 'stderr log' : 'stdout log'
}

function hasLogTarget(service: LaunchdService | null, kind: LogKind): boolean {
  return service?.logTargets.some((target) => target.kind === kind) ?? false
}

function getAlternateLogKind(service: LaunchdService | null, currentKind: LogKind): LogKind | null {
  if (!service) {
    return null
  }

  const alternateKind: LogKind = currentKind === 'stderr' ? 'stdout' : 'stderr'
  return hasLogTarget(service, alternateKind) ? alternateKind : null
}

function formatClock(date = new Date()): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function formatGeneratedAt(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return formatClock(date)
}

function getServiceStateSummary(service: LaunchdService): string {
  if (service.running && service.pid) {
    return `Running with PID ${service.pid}.`
  }

  if (service.completed) {
    return 'Completed successfully. launchd keeps the agent loaded.'
  }

  if (service.loaded && service.lastExitStatus !== null) {
    return `Loaded in launchd. Last exit ${service.lastExitStatus}.`
  }

  if (service.loaded) {
    return 'Loaded in launchd.'
  }

  if (!service.enabled) {
    return 'Disabled in launchd.'
  }

  if (service.lastExitStatus !== null) {
    return `Stopped. Last exit ${service.lastExitStatus}.`
  }

  return 'Stopped.'
}

function getDefaultCardFeedback(service: LaunchdService): CardFeedback {
  return {
    tone: 'neutral',
    message: service.serviceInfo ?? getServiceStateSummary(service)
  }
}

function getFeedbackBadgeLabel(tone: CardFeedbackTone): string {
  switch (tone) {
    case 'progress':
      return 'Working'
    case 'success':
      return 'Updated'
    case 'error':
      return 'Issue'
    case 'neutral':
    default:
      return 'State'
  }
}

function getServiceName(label: string, services: LaunchdService[]): string {
  return services.find((service) => service.label === label)?.name ?? label
}

function compareTimes(left: string, right: string): number {
  return left.localeCompare(right)
}

function parseAutomaticStartTimes(value: string): {
  times: string[]
  invalidEntries: string[]
} {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const uniqueTimes = new Set<string>()
  const invalidEntries: string[] = []

  for (const entry of entries) {
    if (!timePattern.test(entry)) {
      invalidEntries.push(entry)
      continue
    }

    uniqueTimes.add(entry)
  }

  return {
    times: [...uniqueTimes].sort(compareTimes),
    invalidEntries
  }
}

function summarizeAutomation(service: LaunchdService, services: LaunchdService[]): string {
  const parts: string[] = []
  const startCondition = service.automation.startCondition

  if (service.automation.startOnLaunch) {
    const delaySuffix =
      service.automation.launchDelaySeconds > 0
        ? ` after ${service.automation.launchDelaySeconds}s`
        : ''

    parts.push(`Starts when LaunchControl opens${delaySuffix}.`)
  }

  if (startCondition) {
    const waitLabel = startCondition.waitFor === 'loaded' ? 'loads' : 'starts running'
    const delaySuffix =
      startCondition.delaySeconds > 0 ? ` + ${startCondition.delaySeconds}s` : ''

    parts.push(
      `Starts after ${getServiceName(startCondition.afterLabel, services)} ${waitLabel}${delaySuffix}.`
    )
  }

  if (service.automation.automaticStartTimes.length > 0) {
    parts.push(`Daily auto-start at ${service.automation.automaticStartTimes.join(', ')}.`)
  }

  if (service.automation.ensureRunning) {
    parts.push('Keeps this service running while LaunchControl is open.')
  }

  return parts.join(' ') || 'No automation rules.'
}

function getServiceSignals(service: LaunchdService, services: LaunchdService[] = []): string[] {
  const signals = [service.enabled ? 'Enabled' : 'Disabled']

  if (service.running && service.pid) {
    signals.unshift(`PID ${service.pid}`)
  }

  if (service.completed) {
    signals.unshift('Completed')
  }

  if (service.automation.startCondition) {
    signals.push(`After ${getServiceName(service.automation.startCondition.afterLabel, services)}`)
  }

  if (service.automation.startOnLaunch) {
    signals.push(
      service.automation.launchDelaySeconds > 0
        ? `Launch +${service.automation.launchDelaySeconds}s`
        : 'On launch'
    )
  }

  if (service.automation.automaticStartTimes.length > 0) {
    signals.push(
      service.automation.automaticStartTimes.length === 1
        ? `Auto ${service.automation.automaticStartTimes[0]}`
        : `${service.automation.automaticStartTimes.length} auto times`
    )
  }

  if (service.automation.ensureRunning) {
    signals.push('Always on')
  }

  return signals
}

function formatPercentage(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }

  const digits = value >= 10 ? 0 : 1
  return `${value.toFixed(digits)}%`
}

function formatEnergyImpact(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }

  const digits = value >= 10 ? 0 : 1
  return value.toFixed(digits)
}

function formatBytes(value: number | null): string {
  if (value === null) {
    return 'n/a'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)} ${units[unitIndex]}`
}

function getServiceLoadMetrics(load: ServiceLoadSnapshot): ServiceLoadMetricDisplay[] {
  const unavailableReason =
    'Reliable per-process GPU and VRAM metrics require privileged macOS samplers that this app cannot access.'

  return [
    {
      label: 'CPU',
      value: formatPercentage(load.cpuPercent),
      title: 'Current process CPU usage.'
    },
    {
      label: 'GPU',
      value: formatPercentage(load.gpuPercent),
      title: unavailableReason,
      unavailable: load.gpuPercent === null
    },
    {
      label: 'RAM',
      value: formatBytes(load.residentMemoryBytes),
      title: 'Resident memory currently used by the process.'
    },
    {
      label: 'VRAM',
      value: formatBytes(load.vramBytes),
      title: unavailableReason,
      unavailable: load.vramBytes === null
    },
    {
      label: 'MEM',
      value: formatPercentage(load.memoryPercent),
      title: 'Share of total system memory currently used by the process.'
    },
    {
      label: 'ENERGY',
      value: formatEnergyImpact(load.energyImpact),
      title: 'macOS energy impact reported by top.'
    }
  ]
}

type ServiceUsageListener = () => void

const serviceUsageListenersByLabel = new Map<string, Set<ServiceUsageListener>>()
let serviceUsageSnapshotsByLabel: Record<string, ServiceLoadSnapshot> = {}

function hasServiceUsageDisplayChanged(
  currentLoad: ServiceLoadSnapshot,
  nextLoad: ServiceLoadSnapshot
): boolean {
  return (
    currentLoad.cpuPercent !== nextLoad.cpuPercent ||
    currentLoad.gpuPercent !== nextLoad.gpuPercent ||
    currentLoad.residentMemoryBytes !== nextLoad.residentMemoryBytes ||
    currentLoad.vramBytes !== nextLoad.vramBytes ||
    currentLoad.memoryPercent !== nextLoad.memoryPercent ||
    currentLoad.energyImpact !== nextLoad.energyImpact
  )
}

function getStoredServiceUsageSnapshot(label: string): ServiceLoadSnapshot | null {
  return serviceUsageSnapshotsByLabel[label] ?? null
}

function getServiceLoadForSort(service: LaunchdService): ServiceLoadSnapshot {
  return getStoredServiceUsageSnapshot(service.label) ?? service.load
}

function subscribeServiceUsageSnapshot(
  label: string,
  listener: ServiceUsageListener
): () => void {
  const listeners = serviceUsageListenersByLabel.get(label) ?? new Set<ServiceUsageListener>()

  listeners.add(listener)
  serviceUsageListenersByLabel.set(label, listeners)

  return () => {
    listeners.delete(listener)

    if (listeners.size === 0) {
      serviceUsageListenersByLabel.delete(label)
    }
  }
}

function notifyServiceUsageSnapshot(label: string): void {
  const listeners = serviceUsageListenersByLabel.get(label)

  if (!listeners) {
    return
  }

  for (const listener of listeners) {
    listener()
  }
}

function updateServiceUsageSnapshots(
  services: LaunchdService[],
  options: { prune?: boolean } = {}
): void {
  const nextSnapshotsByLabel = options.prune ? {} : { ...serviceUsageSnapshotsByLabel }
  const changedLabels = new Set<string>()
  const nextLabels = new Set<string>()

  for (const service of services) {
    nextLabels.add(service.label)

    const currentLoad = serviceUsageSnapshotsByLabel[service.label]

    if (!currentLoad || hasServiceUsageDisplayChanged(currentLoad, service.load)) {
      nextSnapshotsByLabel[service.label] = service.load
      changedLabels.add(service.label)
      continue
    }

    nextSnapshotsByLabel[service.label] = currentLoad
  }

  if (options.prune) {
    for (const label of Object.keys(serviceUsageSnapshotsByLabel)) {
      if (!nextLabels.has(label)) {
        changedLabels.add(label)
      }
    }
  }

  if (changedLabels.size === 0) {
    return
  }

  serviceUsageSnapshotsByLabel = nextSnapshotsByLabel

  for (const label of changedLabels) {
    notifyServiceUsageSnapshot(label)
  }
}

function scheduleBackgroundServiceUsageUpdate(services: LaunchdService[]): void {
  window.setTimeout(() => {
    startTransition(() => {
      updateServiceUsageSnapshots(services)
    })
  }, 0)
}

function useServiceUsageSnapshot(label: string): ServiceLoadSnapshot | null {
  const subscribe = useCallback(
    (listener: ServiceUsageListener) => subscribeServiceUsageSnapshot(label, listener),
    [label]
  )
  const getSnapshot = useCallback(() => getStoredServiceUsageSnapshot(label), [label])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

function getAdaptiveTitleSize(name: string): string {
  if (name.length > 54) {
    return '1rem'
  }

  if (name.length > 42) {
    return '1.15rem'
  }

  if (name.length > 30) {
    return '1.35rem'
  }

  if (name.length > 22) {
    return '1.65rem'
  }

  return '2rem'
}

function matchesServiceQuery(service: LaunchdService, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase()

  if (!normalizedQuery) {
    return true
  }

  return [
    service.name,
    service.alias ?? '',
    service.folder ?? '',
    service.label,
    service.plistName ?? '',
    service.serviceInfo ?? '',
    service.status,
    service.enabled ? 'enabled' : 'disabled',
    service.running ? 'running' : service.completed ? 'completed' : 'stopped'
  ]
    .join('\n')
    .toLowerCase()
    .includes(normalizedQuery)
}

function findLogFile(logs: ServiceLogs, kind: LogKind) {
  return logs.files.find((candidate) => candidate.kind === kind) ?? null
}

function buildLogPanel(
  logs: ServiceLogs,
  kind: LogKind,
  failure: ServiceActionFailure | null = null
): LogPanelState {
  const file = findLogFile(logs, kind)

  if (!file) {
    return {
      mode: 'log',
      title: logs.name,
      subtitle: `No ${getLogButtonLabel(kind)} path declared`,
      content: `This service does not declare a ${getLogHeading(kind)} path in its plist.`,
      serviceLabel: logs.label,
      kind,
      generatedAt: logs.generatedAt,
      failure
    }
  }

  return {
    mode: 'log',
    title: logs.name,
    subtitle: file.path,
    content: file.exists ? file.content || '(empty file)' : 'File not found.',
    serviceLabel: logs.label,
    kind,
    generatedAt: logs.generatedAt,
    failure
  }
}

function getTerminalHeading(mode: LaunchdTerminalMode): string {
  if (mode === 'stdout') {
    return 'Live output terminal'
  }

  if (mode === 'stderr') {
    return 'Live error terminal'
  }

  return mode === 'logs' ? 'Live logs terminal' : 'Interactive terminal'
}

function getTerminalSummary(mode: LaunchdTerminalMode): string {
  if (mode === 'stdout') {
    return 'PTY session running tail -F for stdout.'
  }

  if (mode === 'stderr') {
    return 'PTY session running tail -F for stderr.'
  }

  return mode === 'logs'
    ? 'PTY session running the log tail command inside the app.'
    : 'PTY session attached to an interactive shell inside the app.'
}

function pruneCardFeedbacks(
  feedbacks: Record<string, CardFeedback>,
  services: LaunchdService[]
): Record<string, CardFeedback> {
  const activeLabels = new Set(services.map((service) => service.label))

  return Object.fromEntries(
    Object.entries(feedbacks).filter(([label]) => activeLabels.has(label))
  )
}

function pruneActionFailures(
  failures: Record<string, ServiceActionFailure>,
  services: LaunchdService[]
): Record<string, ServiceActionFailure> {
  const activeLabels = new Set(services.map((service) => service.label))

  return Object.fromEntries(
    Object.entries(failures).filter(([label]) => activeLabels.has(label))
  )
}

function addFailureHint(
  hints: FailureHint[],
  title: string,
  detail: string
): void {
  if (hints.some((hint) => hint.title === title)) {
    return
  }

  hints.push({ title, detail })
}

function buildActionFailure(service: LaunchdService, action: RecoverableLaunchdAction, message: string): ServiceActionFailure {
  const hints: FailureHint[] = []

  if (hasLogTarget(service, 'stderr')) {
    addFailureHint(
      hints,
      'Check stderr first',
      'The stderr tail usually contains the immediate launchd or process-level failure details.'
    )
  } else {
    addFailureHint(
      hints,
      'Add an err log',
      'Set StandardErrorPath in the plist so failed starts leave a readable traceback or shell error.'
    )
  }

  if (hasLogTarget(service, 'stdout')) {
    addFailureHint(
      hints,
      'Compare stdout too',
      'stdout often shows the last successful step before the process exited or hung during startup.'
    )
  } else {
    addFailureHint(
      hints,
      'Add an output log',
      'Set StandardOutPath in the plist so normal startup output is captured beside stderr.'
    )
  }

  if (/No such file|not found|posix_spawn/i.test(message)) {
    addFailureHint(
      hints,
      'Verify executable paths',
      'Check Program or ProgramArguments in the plist. A script, binary, or working directory path is likely missing.'
    )
  }

  if (/Permission denied|Operation not permitted|not permitted/i.test(message)) {
    addFailureHint(
      hints,
      'Check permissions',
      'Make sure the target script is executable and any files or folders it touches are readable in the user session.'
    )
  }

  if (/bootstrap|Input\/output error|I\/O error|invalid/i.test(message)) {
    addFailureHint(
      hints,
      'Validate the plist',
      'Review the plist for malformed XML, unsupported keys, or a bad Label/ProgramArguments configuration before retrying.'
    )
  }

  if (service.lastExitStatus !== null) {
    addFailureHint(
      hints,
      'Last exit status',
      `The previous run ended with exit status ${service.lastExitStatus}. Match that with the current log tail to find the first failing step.`
    )
  }

  addFailureHint(
    hints,
    'Retry in a terminal',
    'Open the terminal view and run the underlying command directly to catch missing environment variables, path issues, or interactive prompts.'
  )

  return {
    action,
    message,
    occurredAt: new Date().toISOString(),
    hints: hints.slice(0, 4)
  }
}

function getPreferredFailureLogKind(service: LaunchdService, logs: ServiceLogs): LogKind {
  if (findLogFile(logs, 'stderr') || hasLogTarget(service, 'stderr')) {
    return 'stderr'
  }

  return 'stdout'
}

function normalizeFolderPathInput(value: string): string {
  return value
    .split('/')
    .flatMap((segment) => {
      const trimmedSegment = segment.trim()
      return trimmedSegment ? [trimmedSegment] : []
    })
    .join('/')
}

function normalizeServiceTitleInput(value: string): string {
  return value.trim()
}

function getServiceLeafName(service: LaunchdService): string {
  return service.name
}

function resolveServiceAliasInput(value: string): string {
  const normalizedValue = normalizeServiceTitleInput(value)

  if (!normalizedValue) {
    return ''
  }

  return normalizedValue
}

function getServiceTreeSegments(service: LaunchdService): string[] {
  const folderPath = normalizeFolderPathInput(service.folder ?? '')

  if (folderPath) {
    return [...folderPath.split('/'), getServiceLeafName(service)]
  }

  return [service.name]
}

function getServiceFolderPath(service: LaunchdService): string {
  return getServiceTreeSegments(service).slice(0, -1).join('/')
}

function handleTreeRowKeyDown(
  event: KeyboardEvent<HTMLElement>,
  callback: () => void
): void {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }

  event.preventDefault()
  callback()
}

function normalizeTreeDragLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return []
  }

  const uniqueLabels = new Set<string>()

  for (const label of labels) {
    if (typeof label === 'string' && label.length > 0) {
      uniqueLabels.add(label)
    }
  }

  return [...uniqueLabels]
}

function getTreeDragTransferLabels(dataTransfer: DataTransfer): string[] {
  const encodedLabels = dataTransfer.getData(treeServiceLabelsMimeType)

  if (encodedLabels) {
    try {
      const labels = normalizeTreeDragLabels(JSON.parse(encodedLabels))

      if (labels.length > 0) {
        return labels
      }
    } catch {
      return []
    }
  }

  return normalizeTreeDragLabels(dataTransfer.getData('text/plain').split('\n'))
}

function buildServiceTree(services: LaunchdService[]): ServiceTreeNode[] {
  interface MutableFolder {
    name: string
    path: string
    folders: Map<string, MutableFolder>
    services: ServiceTreeLeaf[]
  }

  function createFolder(name: string, path: string): MutableFolder {
    return {
      name,
      path,
      folders: new Map(),
      services: []
    }
  }

  function finalizeFolder(folder: MutableFolder): ServiceTreeFolder {
    const childFolders = [...folder.folders.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(finalizeFolder)
    const serviceCount =
      folder.services.length +
      childFolders.reduce((total, childFolder) => total + childFolder.serviceCount, 0)
    const runningCount =
      folder.services.filter((leaf) => leaf.service.running).length +
      childFolders.reduce((total, childFolder) => total + childFolder.runningCount, 0)

    return {
      type: 'folder',
      name: folder.name,
      path: folder.path,
      children: [...childFolders, ...folder.services],
      serviceCount,
      runningCount
    }
  }

  const root = createFolder('', '')

  for (const service of services) {
    const segments = getServiceTreeSegments(service)
    const folderSegments = segments.slice(0, -1)
    const leafName = segments[segments.length - 1] ?? service.name
    let currentFolder = root
    let currentPath = ''

    for (const segment of folderSegments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const existingFolder = currentFolder.folders.get(segment)

      if (existingFolder) {
        currentFolder = existingFolder
        continue
      }

      const nextFolder = createFolder(segment, currentPath)
      currentFolder.folders.set(segment, nextFolder)
      currentFolder = nextFolder
    }

    currentFolder.services.push({
      type: 'service',
      path: service.label,
      leafName,
      service
    })
  }

  const folders = [...root.folders.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(finalizeFolder)

  return [...folders, ...root.services]
}

function collectExpandedFolderPaths(nodes: ServiceTreeNode[]): string[] {
  const folderPaths: string[] = []

  for (const node of nodes) {
    if (node.type !== 'folder') {
      continue
    }

    folderPaths.push(node.path, ...collectExpandedFolderPaths(node.children))
  }

  return folderPaths
}

function collectFolderServiceLabels(folder: ServiceTreeFolder): string[] {
  const labels: string[] = []

  for (const child of folder.children) {
    if (child.type === 'folder') {
      labels.push(...collectFolderServiceLabels(child))
      continue
    }

    labels.push(child.service.label)
  }

  return labels
}

function canRunTreeFolderAction(service: LaunchdService, action: TreeFolderAction): boolean {
  switch (action) {
    case 'start':
      return service.enabled && !service.running
    case 'stop':
      return service.loaded || service.running
    case 'restart':
      return service.enabled && (service.loaded || service.running)
    case 'enable':
      return !service.enabled
    case 'disable':
      return service.enabled
    default: {
      const exhaustiveAction: never = action
      return exhaustiveAction
    }
  }
}

function getTreeFolderActionMessage(action: TreeFolderAction, folderPath: string): string {
  switch (action) {
    case 'start':
      return `Everything in ${folderPath} is already running or disabled.`
    case 'stop':
      return `Nothing in ${folderPath} is loaded right now.`
    case 'restart':
      return `Nothing in ${folderPath} is running right now.`
    case 'enable':
      return `Everything in ${folderPath} is already enabled.`
    case 'disable':
      return `Everything in ${folderPath} is already disabled.`
    default: {
      const exhaustiveAction: never = action
      return exhaustiveAction
    }
  }
}

function formatServiceCount(count: number): string {
  return `${count} service${count === 1 ? '' : 's'}`
}

function getTreeFolderMenuPosition(clientX: number, clientY: number): {
  left: number
  top: number
} {
  const padding = 12
  const menuWidth = 240
  const menuHeight = 320

  return {
    left: Math.max(padding, Math.min(clientX, window.innerWidth - menuWidth - padding)),
    top: Math.max(padding, Math.min(clientY, window.innerHeight - menuHeight - padding))
  }
}

export default function App(): JSX.Element {
  const [services, setServices] = useState<LaunchdService[]>([])
  const [serviceSort, setServiceSort] = useState<ServiceSortOption>('name-asc')
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null)
  const [selectedTreeLabels, setSelectedTreeLabels] = useState<string[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarSection, setSidebarSection] = useState<SidebarSection>('overview')
  const [treeSelectionBusy, setTreeSelectionBusy] = useState(false)
  const [treeFolderActionBusy, setTreeFolderActionBusy] = useState<TreeFolderAction | null>(null)
  const [treeDraggedLabels, setTreeDraggedLabels] = useState<string[]>([])
  const [treeDropTargetPath, setTreeDropTargetPath] = useState<string | null>(null)
  const [treeFolderMenu, setTreeFolderMenu] = useState<TreeFolderContextMenuState | null>(null)
  const [contentPanel, setContentPanel] = useState<ContentPanelState>(servicesPanel)
  const [cardFeedbacks, setCardFeedbacks] = useState<Record<string, CardFeedback>>({})
  const [actionFailures, setActionFailures] = useState<Record<string, ServiceActionFailure>>({})
  const [loading, setLoading] = useState(true)
  const [createServiceBusy, setCreateServiceBusy] = useState(false)
  const [busyLabel, setBusyLabel] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [openAtLogin, setOpenAtLogin] = useState(false)
  const [loginItemBusy, setLoginItemBusy] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({})
  const [serviceViewMode, setServiceViewMode] = useState<ServiceViewMode>('grid')
  const [searchQuery, setSearchQuery] = useState('')
  const [treeFolderDraft, setTreeFolderDraft] = useState('')
  const [treeFolderMessage, setTreeFolderMessage] = useState<string | null>(null)
  const treeFolderInputRef = useRef<HTMLInputElement | null>(null)
  const treeFolderMenuRef = useRef<HTMLDivElement | null>(null)
  const liveRefreshBusyRef = useRef(false)
  const serviceSortRef = useRef<ServiceSortOption>(serviceSort)
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const filteredServices = services.filter((service) =>
    matchesServiceQuery(service, deferredSearchQuery)
  )
  const treeBusy = treeSelectionBusy || treeFolderActionBusy !== null
  const liveRefreshPaused =
    loading || createServiceBusy || busyLabel !== null || treeBusy || loginItemBusy
  const liveRefreshPausedRef = useRef(liveRefreshPaused)
  const serviceSortField = getServiceSortField(serviceSort)
  const serviceSortDirection = getServiceSortDirection(serviceSort)

  const selectedService =
    filteredServices.find((service) => service.label === selectedLabel) ?? filteredServices[0] ?? null
  const logService =
    contentPanel.mode === 'log'
      ? services.find((service) => service.label === contentPanel.serviceLabel) ?? null
      : null
  const terminalService =
    contentPanel.mode === 'log' || contentPanel.mode === 'terminal'
      ? services.find((service) => service.label === contentPanel.serviceLabel) ?? null
      : contentPanel.mode === 'services'
        ? selectedService
        : null
  const terminalMode: LaunchdTerminalMode =
    contentPanel.mode === 'log'
      ? contentPanel.kind
      : contentPanel.mode === 'terminal'
        ? contentPanel.terminalMode
        : 'service'
  const alternateLogKind =
    contentPanel.mode === 'log' ? getAlternateLogKind(logService, contentPanel.kind) : null
  const serviceTree = buildServiceTree(filteredServices)
  const servicesByLabel = Object.fromEntries(services.map((service) => [service.label, service]))
  const searchActive = deferredSearchQuery.trim().length > 0

  const summary = {
    running: countBy(services, (service) => service.running),
    enabled: countBy(services, (service) => service.enabled)
  }

  function sortWithCurrentPreference(nextServices: LaunchdService[]): LaunchdService[] {
    updateServiceUsageSnapshots(nextServices, { prune: true })
    return sortServices(nextServices, serviceSortRef.current, getServiceLoadForSort)
  }

  function handleServiceSortToggle(field: ServiceSortField): void {
    const nextSort = toggleServiceSort(serviceSortRef.current, field)
    serviceSortRef.current = nextSort
    setServiceSort(nextSort)
  }

  function applyServiceSnapshot(
    nextServices: LaunchdService[],
    options: {
      transition?: boolean
    } = {}
  ): void {
    const sortedServices = sortWithCurrentPreference(nextServices)
    const apply = (): void => {
      setServices(sortedServices)
      setCardFeedbacks((current) => pruneCardFeedbacks(current, sortedServices))
      setActionFailures((current) => pruneActionFailures(current, sortedServices))
      setSelectedLabel((currentLabel) => getSelectedLabel(sortedServices, currentLabel))
      setContentPanel((current) => {
        if (sortedServices.length === 0) {
          return servicesPanel
        }

        if (current.mode === 'log' || current.mode === 'terminal') {
          return sortedServices.some((service) => service.label === current.serviceLabel)
            ? current
            : servicesPanel
        }

        return current
      })
    }

    if (options.transition) {
      startTransition(apply)
      return
    }

    apply()
  }

  function setCardFeedback(label: string, feedback: CardFeedback): void {
    setCardFeedbacks((current) => ({ ...current, [label]: feedback }))
  }

  function clearActionFailure(label: string): void {
    setActionFailures((current) => {
      if (!(label in current)) {
        return current
      }

      const { [label]: _removed, ...rest } = current
      return rest
    })
    setContentPanel((current) =>
      current.mode === 'log' && current.serviceLabel === label
        ? { ...current, failure: null }
        : current
    )
  }

  function focusService(label: string): void {
    setSelectedLabel(label)
  }

  function focusServiceFromSidebar(label: string): void {
    setSelectedLabel(label)
    setContentPanel(servicesPanel)
    setServiceViewMode('tree')
  }

  async function loadServices(): Promise<void> {
    setLoading(true)
    setPageError(null)

    try {
      applyServiceSnapshot(await window.launchdControl.listServices())
    } catch (loadError) {
      setPageError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  async function refreshLiveServiceUsage(): Promise<void> {
    if (liveRefreshBusyRef.current || liveRefreshPausedRef.current) {
      return
    }

    liveRefreshBusyRef.current = true

    try {
      const refreshedServices = await window.launchdControl.refreshLiveServices()

      scheduleBackgroundServiceUsageUpdate(refreshedServices)
      startTransition(() => {
        setServices((currentServices) => {
          const merged = mergeLiveRuntimeServices(currentServices, refreshedServices)

          return merged.changed
            ? sortServices(merged.services, serviceSortRef.current, getServiceLoadForSort)
            : currentServices
        })
      })
    } catch {
      // Silent live refresh failures should not replace the current UI state.
    } finally {
      liveRefreshBusyRef.current = false
    }
  }

  async function loadLoginItemSettings(): Promise<void> {
    try {
      const settings = await window.launchdControl.getLoginItemSettings()
      setOpenAtLogin(settings.openAtLogin)
    } catch (settingsError) {
      setPageError(settingsError instanceof Error ? settingsError.message : String(settingsError))
    }
  }

  function openCreateService(): void {
    setPageError(null)
    setContentPanel(createServicePanel)
  }

  async function handleCreateService(input: CreateLaunchdServiceInput): Promise<void> {
    const label = normalizeServiceLabelInput(input.label)

    setCreateServiceBusy(true)
    setPageError(null)

    try {
      const nextServices = sortWithCurrentPreference(await window.launchdControl.createService(input))

      setServices(nextServices)
      setCardFeedbacks((current) =>
        pruneCardFeedbacks(
          {
            ...current,
            [label]: {
              tone: 'success' as const,
              message: 'Service created. Edit the plist or start it when ready.'
            }
          },
          nextServices
        )
      )
      setActionFailures((current) => pruneActionFailures(current, nextServices))
      setSelectedLabel(getSelectedLabel(nextServices, label))
      setSidebarSection('services')
      setContentPanel(servicesPanel)
    } catch (createError) {
      const message = createError instanceof Error ? createError.message : String(createError)
      setPageError(`Create failed: ${message}`)
      throw createError
    } finally {
      setCreateServiceBusy(false)
    }
  }

  useEffect(() => {
    void Promise.all([loadServices(), loadLoginItemSettings()])
  }, [])

  useEffect(() => {
    liveRefreshPausedRef.current = liveRefreshPaused
  }, [liveRefreshPaused])

  useEffect(() => {
    serviceSortRef.current = serviceSort
    startTransition(() => {
      setServices((current) => sortServices(current, serviceSort, getServiceLoadForSort))
    })
  }, [serviceSort])

  useEffect(() => {
    if (loading) {
      return
    }

    void refreshLiveServiceUsage()

    const intervalId = window.setInterval(() => {
      void refreshLiveServiceUsage()
    }, liveRefreshIntervalMs)

    return () => window.clearInterval(intervalId)
  }, [loading, liveRefreshPaused])

  useEffect(() => {
    const folderPaths = collectExpandedFolderPaths(buildServiceTree(filteredServices))

    setExpandedFolders((current) => {
      const nextFolders: Record<string, boolean> = {}

      for (const path of folderPaths) {
        nextFolders[path] = current[path] ?? true
      }

      return nextFolders
    })
  }, [deferredSearchQuery, services])

  useEffect(() => {
    const visibleLabels = new Set(filteredServices.map((service) => service.label))

    setSelectedTreeLabels((current) => {
      const nextSelection = current.filter((label) => visibleLabels.has(label))
      return nextSelection.length === current.length ? current : nextSelection
    })
  }, [deferredSearchQuery, services])

  useEffect(() => {
    if (serviceViewMode === 'tree') {
      return
    }

    setSelectedTreeLabels((current) => (current.length === 0 ? current : []))
    setTreeFolderMenu(null)
  }, [serviceViewMode])

  useEffect(() => {
    if (contentPanel.mode !== 'services') {
      return
    }

    setSelectedLabel((currentLabel) => getSelectedLabel(filteredServices, currentLabel))
  }, [contentPanel.mode, deferredSearchQuery, services])

  useEffect(() => {
    if (contentPanel.mode !== 'terminal') {
      return
    }

    return () => {
      void closeEmbeddedTerminal(contentPanel.session.id)
    }
  }, [contentPanel])

  useEffect(() => {
    if (contentPanel.mode !== 'services' || serviceViewMode !== 'tree') {
      return
    }

    function handleSlashShortcut(event: globalThis.KeyboardEvent): void {
      if (event.key !== '/') {
        return
      }

      const target = event.target instanceof Element ? event.target : null

      if (target?.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }

      event.preventDefault()
      setTreeFolderMessage(null)
      treeFolderInputRef.current?.focus()
    }

    window.addEventListener('keydown', handleSlashShortcut)

    return () => window.removeEventListener('keydown', handleSlashShortcut)
  }, [contentPanel.mode, serviceViewMode])

  useEffect(() => {
    if (!treeFolderMenu) {
      return
    }

    function closeMenuOnOutsidePointer(event: PointerEvent): void {
      const target = event.target

      if (target instanceof Node && treeFolderMenuRef.current?.contains(target)) {
        return
      }

      setTreeFolderMenu(null)
    }

    function closeMenuOnEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        setTreeFolderMenu(null)
      }
    }

    function closeMenu(): void {
      setTreeFolderMenu(null)
    }

    window.addEventListener('pointerdown', closeMenuOnOutsidePointer)
    window.addEventListener('keydown', closeMenuOnEscape)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('blur', closeMenu)

    return () => {
      window.removeEventListener('pointerdown', closeMenuOnOutsidePointer)
      window.removeEventListener('keydown', closeMenuOnEscape)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('blur', closeMenu)
    }
  }, [treeFolderMenu])

  function toggleFolder(path: string): void {
    setExpandedFolders((current) => ({
      ...current,
      [path]: !(current[path] ?? true)
    }))
  }

  function toggleTreeSelection(label: string): void {
    focusService(label)
    setSelectedTreeLabels((current) =>
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label]
    )
  }

  function clearTreeSelection(): void {
    setSelectedTreeLabels([])
  }

  function openTreeFolderMenu(
    folder: ServiceTreeFolder,
    clientX: number,
    clientY: number
  ): void {
    if (treeBusy) {
      return
    }

    const labels = collectFolderServiceLabels(folder)

    if (labels.length === 0) {
      return
    }

    const { left, top } = getTreeFolderMenuPosition(clientX, clientY)
    setTreeFolderMenu({
      path: folder.path,
      name: folder.name,
      labels,
      left,
      top
    })
  }

  async function moveTreeLabelsToFolder(
    labels: string[],
    folderPath: string,
    options: {
      clearSelectionOnSuccess?: boolean
      toggleFolderWhenEmpty?: boolean
    } = {}
  ): Promise<void> {
    if (treeSelectionBusy) {
      return
    }

    const labelsToMove = [...new Set(labels)].filter((label) => {
      const service = servicesByLabel[label]
      return service ? getServiceFolderPath(service) !== folderPath : false
    })

    if (labelsToMove.length === 0) {
      if (options.toggleFolderWhenEmpty) {
        toggleFolder(folderPath)
      }

      return
    }

    const feedbackMessage =
      labelsToMove.length === 1 ? `Moving into ${folderPath}...` : `Moving ${labelsToMove.length} services...`

    setPageError(null)
    setTreeSelectionBusy(true)
    setCardFeedbacks((current) => ({
      ...current,
      ...Object.fromEntries(
        labelsToMove.map((label) => [
          label,
          {
            tone: 'progress' as const,
            message: feedbackMessage
          }
        ])
      )
    }))

    try {
      const nextServices = sortWithCurrentPreference(
        await window.launchdControl.moveServicesToFolder(labelsToMove, folderPath)
      )

      setServices(nextServices)
      setCardFeedbacks((current) =>
        pruneCardFeedbacks(
          {
            ...current,
            ...Object.fromEntries(
              labelsToMove.map((label) => [
                label,
                {
                  tone: 'success' as const,
                  message: `Moved into ${folderPath}.`
                }
              ])
            )
          },
          nextServices
        )
      )
      setSelectedLabel((currentLabel) =>
        getSelectedLabel(nextServices, currentLabel ?? labelsToMove[0] ?? null)
      )
      setSelectedTreeLabels((current) =>
        options.clearSelectionOnSuccess
          ? []
          : current.filter((label) => !labelsToMove.includes(label))
      )
    } catch (moveError) {
      const message = moveError instanceof Error ? moveError.message : String(moveError)

      setPageError(`Move failed: ${message}`)
      setCardFeedbacks((current) => ({
        ...current,
        ...Object.fromEntries(
          labelsToMove.map((label) => [
            label,
            {
              tone: 'error' as const,
              message: `Move failed: ${message}`
            }
          ])
        )
      }))
    } finally {
      setTreeSelectionBusy(false)
    }
  }

  async function moveTreeSelectionToFolder(folderPath: string): Promise<void> {
    await moveTreeLabelsToFolder(selectedTreeLabels, folderPath, {
      clearSelectionOnSuccess: true,
      toggleFolderWhenEmpty: true
    })
  }

  function startTreeServiceDrag(label: string): string[] {
    const labels = selectedTreeLabels.includes(label) ? selectedTreeLabels : [label]
    setTreeDraggedLabels(labels)
    setTreeDropTargetPath(null)
    return labels
  }

  function endTreeServiceDrag(): void {
    setTreeDraggedLabels([])
    setTreeDropTargetPath(null)
  }

  async function moveTreeDraggedLabelsToFolder(labels: string[], folderPath: string): Promise<void> {
    setTreeDropTargetPath(null)
    await moveTreeLabelsToFolder(labels, folderPath)
    setTreeDraggedLabels([])
  }

  async function createTreeFolderFromSelection(): Promise<void> {
    if (treeBusy) {
      return
    }

    const folderPath = normalizeFolderPathInput(treeFolderDraft)

    if (!folderPath) {
      setTreeFolderMessage('Type a folder path first, for example homebrew/db.')
      treeFolderInputRef.current?.focus()
      return
    }

    const labelsToMove = (selectedTreeLabels.length > 0
      ? selectedTreeLabels
      : selectedService
        ? [selectedService.label]
        : []
    ).filter((label) => {
      const service = servicesByLabel[label]
      return service ? getServiceFolderPath(service) !== folderPath : false
    })

    if (labelsToMove.length === 0) {
      setTreeFolderMessage('Pick a service that is not already in that folder.')
      treeFolderInputRef.current?.focus()
      return
    }

    const feedbackMessage =
      labelsToMove.length === 1
        ? `Creating ${folderPath}...`
        : `Creating ${folderPath} for ${labelsToMove.length} services...`

    setPageError(null)
    setTreeFolderMessage(null)
    setTreeSelectionBusy(true)
    setCardFeedbacks((current) => ({
      ...current,
      ...Object.fromEntries(
        labelsToMove.map((label) => [
          label,
          {
            tone: 'progress' as const,
            message: feedbackMessage
          }
        ])
      )
    }))

    try {
      const nextServices = sortWithCurrentPreference(
        await window.launchdControl.moveServicesToFolder(labelsToMove, folderPath)
      )

      setServices(nextServices)
      setCardFeedbacks((current) =>
        pruneCardFeedbacks(
          {
            ...current,
            ...Object.fromEntries(
              labelsToMove.map((label) => [
                label,
                {
                  tone: 'success' as const,
                  message: `Moved into ${folderPath}.`
                }
              ])
            )
          },
          nextServices
        )
      )
      setExpandedFolders((current) => {
        const nextFolders = { ...current }
        let currentPath = ''

        for (const segment of folderPath.split('/')) {
          currentPath = currentPath ? `${currentPath}/${segment}` : segment
          nextFolders[currentPath] = true
        }

        return nextFolders
      })
      setSelectedLabel((currentLabel) =>
        getSelectedLabel(nextServices, currentLabel ?? labelsToMove[0] ?? null)
      )
      setSelectedTreeLabels([])
      setTreeFolderDraft('')
      setTreeFolderMessage(
        labelsToMove.length === 1
          ? `Created ${folderPath}.`
          : `Created ${folderPath} and moved ${labelsToMove.length} services.`
      )
    } catch (folderError) {
      const message = folderError instanceof Error ? folderError.message : String(folderError)

      setPageError(`Folder create failed: ${message}`)
      setTreeFolderMessage(`Folder create failed: ${message}`)
      setCardFeedbacks((current) => ({
        ...current,
        ...Object.fromEntries(
          labelsToMove.map((label) => [
            label,
            {
              tone: 'error' as const,
              message: `Folder create failed: ${message}`
            }
          ])
        )
      }))
    } finally {
      setTreeSelectionBusy(false)
    }
  }

  async function handleTreeFolderAction(
    folderPath: string,
    folderLabels: string[],
    action: TreeFolderAction
  ): Promise<void> {
    if (treeBusy) {
      return
    }

    const actionableLabels = [...new Set(folderLabels)].filter((label) => {
      const service = servicesByLabel[label]
      return service ? canRunTreeFolderAction(service, action) : false
    })

    setTreeFolderMenu(null)

    if (actionableLabels.length === 0) {
      setTreeFolderMessage(getTreeFolderActionMessage(action, folderPath))
      return
    }

    const progressMessage =
      actionableLabels.length === 1
        ? `${getActionProgress(action)} ${servicesByLabel[actionableLabels[0]]?.name ?? 'service'}...`
        : `${getActionProgress(action)} ${actionableLabels.length} services in ${folderPath}...`

    setPageError(null)
    setTreeFolderMessage(progressMessage)
    setTreeFolderActionBusy(action)
    if (action === 'start' || action === 'stop' || action === 'restart') {
      setActionFailures((current) => {
        const nextFailures = { ...current }

        for (const label of actionableLabels) {
          delete nextFailures[label]
        }

        return nextFailures
      })
      setContentPanel((current) =>
        current.mode === 'log' && actionableLabels.includes(current.serviceLabel)
          ? { ...current, failure: null }
          : current
      )
    }
    setCardFeedbacks((current) => ({
      ...current,
      ...Object.fromEntries(
        actionableLabels.map((label) => [
          label,
          {
            tone: 'progress' as const,
            message: progressMessage
          }
        ])
      )
    }))

    let nextServices = services
    const failedLabels = new Set<string>()
    const failures: Array<{
      label: string
      name: string
      message: string
      failure: ServiceActionFailure | null
    }> = []

    try {
      for (const label of actionableLabels) {
        const currentService =
          nextServices.find((service) => service.label === label) ?? servicesByLabel[label] ?? null

        if (!currentService) {
          failedLabels.add(label)
          failures.push({
            label,
            name: label,
            message: 'Service no longer exists.',
            failure: null
          })
          continue
        }

        try {
          nextServices = sortWithCurrentPreference(await window.launchdControl.runAction(label, action))
        } catch (actionError) {
          const message = actionError instanceof Error ? actionError.message : String(actionError)
          failedLabels.add(label)
          failures.push({
            label,
            name: currentService.name,
            message,
            failure:
              action === 'start' || action === 'restart'
                ? buildActionFailure(currentService, action, message)
                : null
          })
        }
      }

      const succeededLabels = actionableLabels.filter((label) => !failedLabels.has(label))

      setServices(nextServices)
      setCardFeedbacks((current) =>
        pruneCardFeedbacks(
          {
            ...current,
            ...Object.fromEntries(
              succeededLabels.map((label) => [
                label,
                {
                  tone: 'success' as const,
                  message: `${getActionDone(action)}.`
                }
              ])
            ),
            ...Object.fromEntries(
              failures.map(({ label, message }) => [
                label,
                {
                  tone: 'error' as const,
                  message: `${getActionLabel(action)} failed: ${message}`
                }
              ])
            )
          },
          nextServices
        )
      )
      setActionFailures((current) => {
        const nextFailures = { ...current }

        for (const label of succeededLabels) {
          delete nextFailures[label]
        }

        for (const failure of failures) {
          if (failure.failure) {
            nextFailures[failure.label] = failure.failure
          }
        }

        return pruneActionFailures(nextFailures, nextServices)
      })
      setSelectedLabel((currentLabel) =>
        getSelectedLabel(nextServices, currentLabel ?? actionableLabels[0] ?? null)
      )

      if (failures.length === 0) {
        setTreeFolderMessage(`${getActionDone(action)} ${formatServiceCount(actionableLabels.length)} in ${folderPath}.`)
        return
      }

      const succeededCount = actionableLabels.length - failures.length
      const failureSummary = failures
        .slice(0, 3)
        .map((failure) => `${failure.name}: ${failure.message}`)
        .join(' ')
      const failureSuffix = failures.length > 3 ? ' More services failed.' : ''

      setTreeFolderMessage(
        succeededCount > 0
          ? `${getActionDone(action)} ${formatServiceCount(succeededCount)} in ${folderPath}. ${failures.length} failed.`
          : `${getActionLabel(action)} failed for every service in ${folderPath}.`
      )
      setPageError(
        `${getActionLabel(action)} finished with ${failures.length} failure${
          failures.length === 1 ? '' : 's'
        } in ${folderPath}. ${failureSummary}${failureSuffix}`
      )
    } finally {
      setTreeFolderActionBusy(null)
    }
  }

  async function handleOpenAtLoginToggle(): Promise<void> {
    setLoginItemBusy(true)
    setPageError(null)

    try {
      const settings = await window.launchdControl.setOpenAtLogin(!openAtLogin)
      setOpenAtLogin(settings.openAtLogin)
    } catch (settingsError) {
      setPageError(settingsError instanceof Error ? settingsError.message : String(settingsError))
    } finally {
      setLoginItemBusy(false)
    }
  }

  async function reopenVisibleLogTerminal(
    label: string,
    kind: LogKind,
    failureOverride: ServiceActionFailure | null = actionFailures[label] ?? null
  ): Promise<void> {
    await openLogTerminal(label, kind, failureOverride)
  }

  async function handleAction(label: string, action: LaunchdAction): Promise<void> {
    if (action === 'delete') {
      const confirmed = window.confirm(
        'Delete this launch agent plist from ~/Library/LaunchAgents?'
      )

      if (!confirmed) {
        setCardFeedback(label, { tone: 'neutral', message: 'Delete cancelled.' })
        return
      }
    }

    const currentService = services.find((service) => service.label === label) ?? null
    const actionLabel = getActionLabel(action)
    const progressLabel = getActionProgress(action)

    focusService(label)
    setBusyLabel(label)
    if (action === 'start' || action === 'stop' || action === 'restart') {
      clearActionFailure(label)
    }
    setCardFeedback(label, { tone: 'progress', message: `${progressLabel}...` })

    try {
      const nextServices = sortWithCurrentPreference(await window.launchdControl.runAction(label, action))
      const nextService = nextServices.find((service) => service.label === label) ?? null

      setServices(nextServices)
      setCardFeedbacks((current) => pruneCardFeedbacks(current, nextServices))
      setActionFailures((current) => {
        if (!(label in current)) {
          return pruneActionFailures(current, nextServices)
        }

        const { [label]: _removed, ...rest } = current
        return pruneActionFailures(rest, nextServices)
      })
      setSelectedLabel(getSelectedLabel(nextServices, label))

      if (nextService) {
        setCardFeedback(label, { tone: 'success', message: `${getActionDone(action)}.` })
      }

      if (
        (contentPanel.mode === 'log' || contentPanel.mode === 'terminal') &&
        contentPanel.serviceLabel === label
      ) {
        if (!nextService) {
          setContentPanel(servicesPanel)
        } else if (contentPanel.mode === 'log') {
          try {
            await openLogTerminal(label, contentPanel.kind, null)
          } catch {
            // Keep the successful action feedback even if the log tail cannot reopen.
          }
        } else if (
          action === 'start' ||
          action === 'restart'
        ) {
          const currentMode = contentPanel.terminalMode

          if (currentMode === 'stdout' || currentMode === 'stderr') {
            try {
              await openLogTerminal(label, currentMode, null)
            } catch {
              // The launch action succeeded; leave any terminal error as card feedback only.
            }
          }
        }
      }
    } catch (actionError) {
      const message = actionError instanceof Error ? actionError.message : String(actionError)

      if ((action === 'start' || action === 'restart') && currentService) {
        const failure = buildActionFailure(currentService, action, message)
        setActionFailures((current) => ({ ...current, [label]: failure }))

        try {
          const nextLogs = await window.launchdControl.readLogs(label)
          const failureKind = getPreferredFailureLogKind(currentService, nextLogs)
          await openLogTerminal(label, failureKind, failure)
          setCardFeedback(label, {
            tone: 'error',
            message: `${actionLabel} failed. Live ${getLogButtonLabel(failureKind)} tail opened.`
          })
        } catch {
          setCardFeedback(label, { tone: 'error', message: `${actionLabel} failed: ${message}` })
        }
      } else {
        setCardFeedback(label, { tone: 'error', message: `${actionLabel} failed: ${message}` })
      }
    } finally {
      setBusyLabel(null)
    }
  }

  async function handleRename(label: string, alias: string): Promise<void> {
    const trimmedAlias = normalizeServiceTitleInput(alias)

    focusService(label)
    setBusyLabel(label)
    setCardFeedback(label, {
      tone: 'progress',
      message: trimmedAlias ? 'Saving name...' : 'Clearing name...'
    })

    try {
      const nextServices = trimmedAlias
        ? await window.launchdControl.renameService(label, trimmedAlias)
        : await window.launchdControl.clearAlias(label)
      const sortedServices = sortWithCurrentPreference(nextServices)

      setServices(sortedServices)
      setCardFeedbacks((current) => pruneCardFeedbacks(current, sortedServices))
      setSelectedLabel(getSelectedLabel(sortedServices, label))
      setCardFeedback(label, {
        tone: 'success',
        message: trimmedAlias ? 'Name updated.' : 'Name cleared.'
      })

      if (contentPanel.mode === 'log' && contentPanel.serviceLabel === label) {
        try {
          await reopenVisibleLogTerminal(label, contentPanel.kind)
        } catch {
          // The rename result is still valid if the log pane refresh fails.
        }
      }
    } catch (renameError) {
      const message = renameError instanceof Error ? renameError.message : String(renameError)
      setCardFeedback(label, { tone: 'error', message: `Rename failed: ${message}` })
    } finally {
      setBusyLabel(null)
    }
  }

  async function handleAutomationSave(
    label: string,
    settings: ServiceAutomationSettings
  ): Promise<void> {
    const hasRules =
      Boolean(settings.startCondition) ||
      settings.automaticStartTimes.length > 0 ||
      settings.startOnLaunch ||
      settings.ensureRunning

    focusService(label)
    setBusyLabel(label)
    setCardFeedback(label, {
      tone: 'progress',
      message: hasRules ? 'Saving automation...' : 'Clearing automation...'
    })

    try {
      const nextServices = sortWithCurrentPreference(await window.launchdControl.saveAutomation(label, settings))

      setServices(nextServices)
      setCardFeedbacks((current) => pruneCardFeedbacks(current, nextServices))
      setSelectedLabel(getSelectedLabel(nextServices, label))
      setCardFeedback(label, {
        tone: 'success',
        message: hasRules ? 'Automation updated.' : 'Automation cleared.'
      })
    } catch (automationError) {
      const message = automationError instanceof Error ? automationError.message : String(automationError)
      setCardFeedback(label, { tone: 'error', message: `Automation failed: ${message}` })
    } finally {
      setBusyLabel(null)
    }
  }

  async function handlePlistSave(label: string, content: string): Promise<void> {
    focusService(label)
    setBusyLabel(label)
    setCardFeedback(label, {
      tone: 'progress',
      message: 'Saving plist...'
    })

    try {
      const nextServices = sortWithCurrentPreference(await window.launchdControl.savePlist(label, content))

      setServices(nextServices)
      setCardFeedbacks((current) => pruneCardFeedbacks(current, nextServices))
      setSelectedLabel(getSelectedLabel(nextServices, label))
      setCardFeedback(label, {
        tone: 'success',
        message: 'Plist saved. Restart the service to apply launchd changes.'
      })
    } catch (plistError) {
      const message = plistError instanceof Error ? plistError.message : String(plistError)
      setCardFeedback(label, { tone: 'error', message: `Plist save failed: ${message}` })
      throw plistError
    } finally {
      setBusyLabel(null)
    }
  }

  async function openLogTerminal(
    label: string,
    kind: LogKind,
    failure: ServiceActionFailure | null = null
  ): Promise<TerminalSessionInfo> {
    if (contentPanel.mode === 'terminal') {
      await closeEmbeddedTerminal(contentPanel.session.id)
    }

    const session = await window.launchdControl.openTerminal(label, kind)
    setContentPanel({
      mode: 'terminal',
      session,
      serviceLabel: label,
      terminalMode: kind,
      failure
    })
    return session
  }

  async function openLog(label: string, kind: LogKind): Promise<void> {
    focusService(label)
    setBusyLabel(label)
    setCardFeedback(label, {
      tone: 'progress',
      message: `Opening live ${getLogButtonLabel(kind)} tail...`
    })

    try {
      await openLogTerminal(label, kind)
      setCardFeedback(label, {
        tone: 'success',
        message: `Live ${getLogButtonLabel(kind)} tail ready.`
      })
    } catch (logsError) {
      const message = logsError instanceof Error ? logsError.message : String(logsError)
      setCardFeedback(label, { tone: 'error', message: `Log tail failed: ${message}` })
    } finally {
      setBusyLabel(null)
    }
  }

  async function closeEmbeddedTerminal(sessionId: string): Promise<void> {
    try {
      await window.launchdControl.closeTerminal(sessionId)
    } catch {
      // Closing a dead PTY should not block the rest of the UI.
    }
  }

  async function handleOpenTerminal(): Promise<void> {
    if (!terminalService) {
      return
    }

    setBusyLabel(terminalService.label)
    setCardFeedback(terminalService.label, {
      tone: 'progress',
      message: 'Opening terminal...'
    })

    try {
      const session = await window.launchdControl.openTerminal(terminalService.label, terminalMode)
      setContentPanel({
        mode: 'terminal',
        session,
        serviceLabel: terminalService.label,
        terminalMode
      })
      setCardFeedback(terminalService.label, {
        tone: 'success',
        message: 'Terminal ready.'
      })
    } catch (terminalError) {
      const message = terminalError instanceof Error ? terminalError.message : String(terminalError)
      setCardFeedback(terminalService.label, {
        tone: 'error',
        message: `Terminal failed: ${message}`
      })
    } finally {
      setBusyLabel(null)
    }
  }

  function handleCloseTerminal(): void {
    if (contentPanel.mode !== 'terminal') {
      return
    }

    setContentPanel(servicesPanel)
  }

  async function handleRefreshLog(): Promise<void> {
    if (contentPanel.mode !== 'log') {
      return
    }

    setBusyLabel(contentPanel.serviceLabel)
    setCardFeedback(contentPanel.serviceLabel, {
      tone: 'progress',
      message: `Refreshing ${getLogButtonLabel(contentPanel.kind)}...`
    })

    try {
      await reopenVisibleLogTerminal(contentPanel.serviceLabel, contentPanel.kind)
      setCardFeedback(contentPanel.serviceLabel, {
        tone: 'success',
        message: `${getLogButtonLabel(contentPanel.kind)} refreshed.`
      })
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : String(refreshError)
      setCardFeedback(contentPanel.serviceLabel, {
        tone: 'error',
        message: `Log refresh failed: ${message}`
      })
    } finally {
      setBusyLabel(null)
    }
  }

  return (
    <div className={`shell ${sidebarCollapsed ? 'shell--sidebar-collapsed' : ''}`}>
      <aside className={`masthead ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
        <div className="masthead__body">
          {sidebarCollapsed ? null : sidebarSection === 'overview' ? (
            <div className="sidebar-view sidebar-view--overview">
              <header className="masthead__header">
                <div className="masthead__intro">
                  <h1>LaunchControl</h1>
                  <p className="lede">
                    Inspect user launch agents, see launchd state at a glance, and jump straight
                    into logs, runtime context, or plist details when something needs attention.
                  </p>
                </div>
              </header>

              <div className="summary-strip">
                <article>
                  <span>Agents</span>
                  <strong>{services.length}</strong>
                </article>
                <article>
                  <span>Running</span>
                  <strong>{summary.running}</strong>
                </article>
                <article>
                  <span>Enabled</span>
                  <strong>{summary.enabled}</strong>
                </article>
              </div>

              <section className="sidebar-panel">
                <div className="sidebar-panel__header">
                  <p className="section-tag">App</p>
                  <h2>Login item</h2>
                </div>
                <div className="sidebar-fields">
                  <div>
                    <span>Status</span>
                    <strong>{openAtLogin ? 'Registered with macOS' : 'Not registered'}</strong>
                  </div>
                </div>
                <button
                  className="ghost-button sidebar-button"
                  disabled={loginItemBusy}
                  onClick={() => void handleOpenAtLoginToggle()}
                >
                  {loginItemBusy
                    ? 'Updating Login Item...'
                    : openAtLogin
                      ? 'Remove from Login Items'
                      : 'Add to Login Items'}
                </button>
              </section>
            </div>
          ) : (
            <div className="sidebar-view sidebar-view--services">
              <header className="masthead__header">
                <div className="sidebar-panel__header">
                  <p className="section-tag">Services</p>
                  <h2>Tree navigation</h2>
                  <p className="sidebar-detail">
                    {searchActive
                      ? `${filteredServices.length} matching service${
                          filteredServices.length === 1 ? '' : 's'
                        }. Select a row to open the detail view in the main panel.`
                      : `${services.length} service${
                          services.length === 1 ? '' : 's'
                        } grouped by folders. Select a row to open the detail view in the main panel.`}
                  </p>
                </div>
              </header>

	              <section className="sidebar-panel sidebar-panel--services">
	                {services.length === 0 ? (
	                  <p className="sidebar-empty">
	                    No launch agents are available yet. Use New service in the toolbar to create one.
	                  </p>
	                ) : filteredServices.length === 0 ? (
	                  <p className="sidebar-empty">
	                    No services matched `{deferredSearchQuery.trim()}`.
                  </p>
                ) : (
                  <div className="sidebar-tree-panel">
                    <div className="sidebar-tree-panel__controls">
                      <div className="tree-folder-command">
                        <label className="tree-folder-command__field">
                          <span>/</span>
                          <input
                            ref={treeFolderInputRef}
                            aria-label="Folder path"
                            disabled={treeBusy}
                            onChange={(event) => {
                              setTreeFolderDraft(event.target.value)
                              setTreeFolderMessage(null)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                void createTreeFolderFromSelection()
                              }
                            }}
                            placeholder="Folder path, for example homebrew/db"
                            value={treeFolderDraft}
                          />
                        </label>
                        <button
                          className="ghost-button"
                          disabled={treeBusy}
                          onClick={() => void createTreeFolderFromSelection()}
                          type="button"
                        >
                          Create folder
                        </button>
                      </div>

                      {treeFolderMessage ? (
                        <p className="tree-folder-command__message">{treeFolderMessage}</p>
                      ) : null}

                      {selectedTreeLabels.length > 0 ? (
                        <div className="tree-panel__selection tree-panel__selection--sidebar">
                          <p>
                            {treeSelectionBusy
                              ? `Moving ${selectedTreeLabels.length} selected service${
                                  selectedTreeLabels.length === 1 ? '' : 's'
                                }...`
                              : `${selectedTreeLabels.length} selected. Click a folder or drag the selection onto a folder to move it inside LaunchControl only.`}
                          </p>
                          <button
                            className="ghost-button"
                            disabled={treeBusy}
                            onClick={() => clearTreeSelection()}
                            type="button"
                          >
                            Clear selection
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="sidebar-tree-panel__list">
                      <ServiceTree
                        activeLabel={selectedService?.label ?? null}
                        draggedLabels={treeDraggedLabels}
                        dropTargetPath={treeDropTargetPath}
                        expandedFolders={expandedFolders}
                        feedbacks={cardFeedbacks}
                        nodes={serviceTree}
                        onDragEnd={endTreeServiceDrag}
                        onDragServiceStart={startTreeServiceDrag}
                        onDropLabels={moveTreeDraggedLabelsToFolder}
                        onDropTargetChange={setTreeDropTargetPath}
                        onOpenFolderMenu={openTreeFolderMenu}
                        onMoveSelection={moveTreeSelectionToFolder}
                        onSelect={focusServiceFromSidebar}
                        onToggleSelection={toggleTreeSelection}
                        onToggleFolder={toggleFolder}
                        selectedLabels={selectedTreeLabels}
                        selectionBusy={treeBusy}
                        servicesByLabel={servicesByLabel}
                      />
                    </div>
                  </div>
                )}

                {treeFolderMenu ? (
                  <div
                    className="tree-folder-menu"
                    ref={treeFolderMenuRef}
                    role="menu"
                    style={{
                      left: `${treeFolderMenu.left}px`,
                      top: `${treeFolderMenu.top}px`
                    }}
                  >
                    <div className="tree-folder-menu__header">
                      <p className="eyebrow">Folder actions</p>
                      <h4>{treeFolderMenu.name}</h4>
                      <p className="tree-folder-menu__path">{treeFolderMenu.path}</p>
                      <p className="tree-folder-menu__meta">
                        {formatServiceCount(treeFolderMenu.labels.length)}
                      </p>
                    </div>

                    <div className="tree-folder-menu__actions">
                      {treeFolderMenuActions.map((action) => {
                        const actionableCount = treeFolderMenu.labels.filter((label) => {
                          const service = servicesByLabel[label]
                          return service ? canRunTreeFolderAction(service, action) : false
                        }).length

                        return (
                          <button
                            key={action}
                            className="tree-folder-menu__action"
                            disabled={treeBusy || actionableCount === 0}
                            onClick={() =>
                              void handleTreeFolderAction(
                                treeFolderMenu.path,
                                treeFolderMenu.labels,
                                action
                              )
                            }
                            role="menuitem"
                            type="button"
                          >
                            <span className="tree-folder-menu__action-label">
                              {getTreeFolderActionLabel(action)}
                            </span>
                            <span className="tree-folder-menu__action-count">
                              {actionableCount}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </div>

        <div className="sidebar-dock">
          <nav className="sidebar-dock__sections" aria-label="Sidebar sections">
            <button
              aria-label="App sidebar"
              aria-pressed={sidebarSection === 'overview'}
              className={`icon-button sidebar-dock__button ${
                sidebarSection === 'overview' ? 'is-active' : ''
              }`}
              onClick={() => {
                setSidebarSection('overview')
                setSidebarCollapsed(false)
              }}
              title="App"
              type="button"
            >
              <Power />
            </button>
            <button
              aria-label="Services sidebar"
              aria-pressed={sidebarSection === 'services'}
              className={`icon-button sidebar-dock__button ${
                sidebarSection === 'services' ? 'is-active' : ''
              }`}
              onClick={() => {
                setSidebarSection('services')
                setServiceViewMode('tree')
                setSidebarCollapsed(false)
              }}
              title="Services"
              type="button"
            >
              <ListTree />
            </button>
          </nav>

          <button
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="icon-button sidebar-dock__button sidebar-dock__button--toggle"
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            type="button"
          >
            <span
              className={`button-icon sidebar-toggle__icon ${
                sidebarCollapsed ? '' : 'is-expanded'
              }`}
            >
              <ChevronRight />
            </span>
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className={`topbar ${contentPanel.mode === 'services' ? 'topbar--services' : ''}`}>
          <div
            className={`topbar__meta ${
              contentPanel.mode === 'services' ? 'topbar__meta--search' : ''
            }`}
	          >
	            {contentPanel.mode === 'services' ? (
	              <label className="search-field topbar__search">
	                <span className="search-field__icon">
	                  <Search />
                </span>
                <input
                  aria-label="Search services"
                  className="search-field__input"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search by name, label, plist, or state"
                  value={searchQuery}
                />
                {searchQuery ? (
                  <button
                    aria-label="Clear search"
                    className="icon-button icon-button--small search-field__clear"
                    onClick={() => setSearchQuery('')}
                    type="button"
                  >
                    <X />
                  </button>
                ) : null}
              </label>
	            ) : contentPanel.mode === 'create' ? (
	              <>
	                <p className="section-tag">New launch agent</p>
	                <h2>Create service</h2>
	                <p className="topbar__detail">
	                  Write a new plist into `~/Library/LaunchAgents` and then manage it from the
	                  normal roster.
	                </p>
	              </>
	            ) : (
	              <>
	                <p className="section-tag">
	                  {contentPanel.mode === 'log'
                    ? `${getLogButtonLabel(contentPanel.kind)} tail`
                    : contentPanel.terminalMode === 'logs' ||
                        contentPanel.terminalMode === 'stdout' ||
                        contentPanel.terminalMode === 'stderr'
                      ? 'Embedded terminal'
                      : 'Embedded shell'}
                </p>
                <h2>{contentPanel.mode === 'log' ? 'Log window' : getTerminalHeading(contentPanel.terminalMode)}</h2>
                <p className="topbar__detail">
                  {contentPanel.mode === 'log' ? contentPanel.title : contentPanel.session.title}
                </p>
              </>
            )}
          </div>

          <div
            className={`topbar__controls ${
              contentPanel.mode === 'services' ? 'topbar__controls--services' : ''
            }`}
          >
            <div className="topbar__controls-row">
	              {contentPanel.mode === 'services' ? (
	                <div className="topbar__sort-toggle" role="group" aria-label="Service order">
                  <button
                    aria-label={
                      serviceSortField === 'name'
                        ? serviceSortDirection === 'asc'
                          ? 'Name order A-Z. Click to switch to Z-A.'
                          : 'Name order Z-A. Click to switch to A-Z.'
                        : 'Order services by name A-Z.'
                    }
                    aria-pressed={serviceSortField === 'name'}
                    className={`ghost-button topbar-button ${
                      serviceSortField === 'name' ? 'is-active' : ''
                    }`}
                    onClick={() => handleServiceSortToggle('name')}
                    title={
                      serviceSortField === 'name'
                        ? serviceSortDirection === 'asc'
                          ? 'Name A-Z'
                          : 'Name Z-A'
                        : 'Order by name'
                    }
                    type="button"
                  >
                    <span className="button-icon">
                      {serviceSortField === 'name' && serviceSortDirection === 'desc' ? (
                        <ArrowDownZA />
                      ) : (
                        <ArrowUpAZ />
                      )}
                    </span>
                  </button>
                  <button
                    aria-label={
                      serviceSortField === 'usage'
                        ? serviceSortDirection === 'asc'
                          ? 'Usage order high to low. Click to switch to low to high.'
                          : 'Usage order low to high. Click to switch to high to low.'
                        : 'Order services by usage, highest first.'
                    }
                    aria-pressed={serviceSortField === 'usage'}
                    className={`ghost-button topbar-button ${
                      serviceSortField === 'usage' ? 'is-active' : ''
                    }`}
                    onClick={() => handleServiceSortToggle('usage')}
                    title={
                      serviceSortField === 'usage'
                        ? serviceSortDirection === 'asc'
                          ? 'Usage high to low'
                          : 'Usage low to high'
                        : 'Order by usage'
                    }
                    type="button"
                  >
                    <span className="button-icon">
                      {serviceSortField === 'usage' && serviceSortDirection === 'desc' ? (
                        <ArrowDownWideNarrow />
                      ) : (
                        <ArrowUpWideNarrow />
                      )}
                    </span>
                  </button>
                </div>
              ) : null}

              <div className="topbar__action-stack">
                <div className="topbar__actions">
	              {contentPanel.mode === 'services' ? (
	                <div className="topbar__view-toggle" role="group" aria-label="Service view">
                  <button
                    aria-label="Grid view"
                    className={`ghost-button topbar-button ${serviceViewMode === 'grid' ? 'is-active' : ''}`}
                    onClick={() => setServiceViewMode('grid')}
                    title="Grid view"
                    type="button"
                  >
                    <span className="button-icon">
                      <LayoutGrid />
                    </span>
                    <span className="button-label">Grid</span>
                  </button>
                  <button
                    aria-label="Tree view"
                    className={`ghost-button topbar-button ${serviceViewMode === 'tree' ? 'is-active' : ''}`}
                    onClick={() => {
                      setServiceViewMode('tree')
                      setSidebarSection('services')
                    }}
                    title="Tree view"
                    type="button"
                  >
                    <span className="button-icon">
                      <ListTree />
                    </span>
                    <span className="button-label">Tree</span>
                  </button>
                </div>
              ) : null}
	              {contentPanel.mode === 'services' ? (
	                <button
	                  aria-label="Create service"
	                  className="ghost-button toolbar-button"
	                  disabled={createServiceBusy}
	                  onClick={() => openCreateService()}
	                  title="Create service"
	                  type="button"
	                >
	                  <span className="button-icon">
	                    <Plus />
	                  </span>
	                  <span className="button-label">
	                    {createServiceBusy ? 'Creating service...' : 'New service'}
	                  </span>
	                </button>
	              ) : null}
	              {contentPanel.mode === 'create' ||
	              contentPanel.mode === 'log' ||
	              contentPanel.mode === 'terminal' ? (
	                <button
	                  aria-label="Back to services"
	                  className="ghost-button toolbar-button topbar-button"
	                  onClick={() => {
	                    if (contentPanel.mode === 'terminal') {
                      void handleCloseTerminal()
	                      return
	                    }

	                    setContentPanel(servicesPanel)
	                  }}
                  title="Back to services"
                >
                  <span className="button-icon">
                    <ArrowLeft />
                  </span>
                  <span className="button-label">Back to services</span>
                </button>
              ) : null}
              {contentPanel.mode === 'log' ? (
                alternateLogKind ? (
                  <button
                    aria-label={`Show ${getLogButtonLabel(alternateLogKind)}`}
                    className="ghost-button toolbar-button topbar-button"
                    disabled={busyLabel === contentPanel.serviceLabel}
                    onClick={() => void openLog(contentPanel.serviceLabel, alternateLogKind)}
                    title={`Show ${getLogButtonLabel(alternateLogKind)}`}
                    type="button"
                  >
                    <span className="button-icon">
                      <FileText />
                    </span>
                    <span className="button-label">{getLogButtonLabel(alternateLogKind)}</span>
                  </button>
                ) : null
              ) : null}
              {contentPanel.mode === 'log' ? (
                <button
                  aria-label="Refresh log"
                  className="ghost-button toolbar-button topbar-button"
                  disabled={busyLabel === contentPanel.serviceLabel}
                  onClick={() => void handleRefreshLog()}
                  title="Refresh log"
                  type="button"
                >
                  <span className="button-icon">
                    <RefreshCcw />
                  </span>
                  <span className="button-label">Refresh log</span>
                </button>
              ) : null}
	              {contentPanel.mode === 'services' ? (
	                <button
	                  aria-label="Refresh roster"
	                  className="ghost-button toolbar-button topbar-button"
	                  disabled={loading || createServiceBusy}
	                  onClick={() => void loadServices()}
	                  title="Refresh roster"
	                  type="button"
                >
                  <span className="button-icon">
                    <RefreshCcw />
                  </span>
                  <span className="button-label">Refresh roster</span>
                </button>
              ) : null}
              {terminalService ? (
                <button
                  aria-label="Open terminal"
                  className="ghost-button toolbar-button topbar-button"
                  disabled={busyLabel === terminalService.label}
                  onClick={() => void handleOpenTerminal()}
                  title="Open terminal"
                  type="button"
                >
                  <span className="button-icon">
                    <Terminal />
                  </span>
                  <span className="button-label">Open terminal</span>
                </button>
              ) : null}
                </div>
                {contentPanel.mode === 'services' && services.length > 0 ? (
                  <div
                    className={`live-indicator ${liveRefreshPaused ? 'is-paused' : ''}`}
                    title={
                      liveRefreshPaused
                        ? 'Background usage polling pauses while LaunchControl is busy applying another change.'
                        : `Usage metrics refresh in the background every ${liveRefreshIntervalMs / 1000}s. Use Refresh roster to detect added or removed plists.`
                    }
                  >
                    <span aria-hidden="true" className="live-indicator__dot" />
                    <span>{liveRefreshPaused ? 'Usage paused' : 'Usage live'}</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        {pageError ? <div className="error-banner">{pageError}</div> : null}

        <section
          className={`service-region ${contentPanel.mode === 'terminal' ? 'service-region--terminal' : ''}`}
        >
          {loading ? (
            <div className="empty-state">Loading launch agents...</div>
	          ) : contentPanel.mode === 'create' ? (
	            <CreateServicePanel
	              busy={createServiceBusy}
	              onCancel={() => setContentPanel(servicesPanel)}
	              onCreate={handleCreateService}
	            />
	          ) : contentPanel.mode === 'log' ? (
	            <LogPanel
	              busy={busyLabel === contentPanel.serviceLabel}
	              onAction={handleAction}
              onLog={openLog}
              onOpenTerminal={() => void handleOpenTerminal()}
              panel={contentPanel}
              service={logService}
            />
          ) : contentPanel.mode === 'terminal' ? (
            <TerminalPanel
              busy={busyLabel === contentPanel.serviceLabel}
              panel={contentPanel}
	              service={terminalService}
              onAction={handleAction}
	              onBack={() => void handleCloseTerminal()}
	            />
	          ) : services.length === 0 ? (
	            <div className="empty-state">
	              No `~/Library/LaunchAgents` plists were found for this user yet. Use New service
	              to create one.
	            </div>
          ) : filteredServices.length === 0 ? (
            <div className="empty-state">
              No services matched `{deferredSearchQuery.trim()}`.
            </div>
          ) : serviceViewMode === 'tree' ? (
            <TreeServiceDetail
              busyLabel={busyLabel}
              feedbacks={cardFeedbacks}
              onAction={handleAction}
              onLog={openLog}
              onRename={handleRename}
              onSaveAutomation={handleAutomationSave}
              onSavePlist={handlePlistSave}
              onSelect={focusService}
              service={selectedService}
              services={services}
              treeBusy={treeBusy}
            />
          ) : (
            <div className="service-grid">
              {filteredServices.map((service, index) => (
                <ServiceCard
                  key={service.label}
                  active={service.label === selectedService?.label}
                  allServices={services}
                  busy={busyLabel === service.label}
                  delayIndex={index}
                  feedback={cardFeedbacks[service.label] ?? getDefaultCardFeedback(service)}
                  onAction={handleAction}
                  onLog={openLog}
                  onRename={handleRename}
                  onSelect={focusService}
                  service={service}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function CreateServicePanel({
  busy,
  onCreate,
  onCancel
}: {
  busy: boolean
  onCreate: (input: CreateLaunchdServiceInput) => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [mode, setMode] = useState<CreateServiceMode>('plist')
  const [label, setLabel] = useState(defaultCreateServiceLabel)
  const [draftContent, setDraftContent] = useState(() =>
    buildNewServiceTemplate(defaultCreateServiceLabel)
  )
  const [repositoryState, setRepositoryState] = useState<RepositoryCreateState>({
    draft: null,
    runCommand: '',
    commandOptionId: 'custom',
    runAtLoad: true,
    keepAlive: true,
    busy: false
  })
  const [localError, setLocalError] = useState<string | null>(null)
  const [localMessage, setLocalMessage] = useState<string | null>(null)
  const [copiedSnippetKey, setCopiedSnippetKey] = useState<string | null>(null)
  const labelInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const selectionRef = useRef({ start: 0, end: 0 })
  const templateRef = useRef(buildNewServiceTemplate(defaultCreateServiceLabel))
  const {
    draft: repositoryDraft,
    runCommand: repositoryRunCommand,
    commandOptionId: repositoryCommandOptionId,
    runAtLoad: repositoryRunAtLoad,
    keepAlive: repositoryKeepAlive,
    busy: repositoryBusy
  } = repositoryState
  const normalizedLabel = normalizeServiceLabelInput(label)
  const previewLabel = normalizedLabel || defaultCreateServiceLabel
  const destinationPath = buildLaunchAgentPath(previewLabel)
  const repositoryCommandOptions = repositoryDraft?.runCommandOptions ?? []
  const selectedRepositoryCommand = repositoryCommandOptions.find(
    (option) => option.id === repositoryCommandOptionId
  )
  const repositoryPlistContent = repositoryDraft
    ? buildRepositoryServiceTemplate({
        label: previewLabel,
        repositoryPath: repositoryDraft.repositoryPath,
        runCommand: repositoryRunCommand,
        runAtLoad: repositoryRunAtLoad,
        keepAlive: repositoryKeepAlive
      })
    : ''

  useEffect(() => {
    window.requestAnimationFrame(() => {
      labelInputRef.current?.focus()
      labelInputRef.current?.select()
    })
  }, [])

  useEffect(() => {
    if (!copiedSnippetKey) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedSnippetKey(null)
    }, 1800)

    return () => window.clearTimeout(timeoutId)
  }, [copiedSnippetKey])

  function syncSelection(target: HTMLTextAreaElement): void {
    selectionRef.current = {
      start: target.selectionStart,
      end: target.selectionEnd
    }
  }

  function handleLabelChange(nextValue: string): void {
    const nextLabel = normalizeServiceLabelInput(nextValue) || defaultCreateServiceLabel
    const nextTemplate = buildNewServiceTemplate(nextLabel)
    const shouldSyncTemplate = draftContent === templateRef.current

    templateRef.current = nextTemplate
    setLabel(nextValue)
    setLocalError(null)
    setLocalMessage(null)

    if (shouldSyncTemplate) {
      setDraftContent(nextTemplate)
      selectionRef.current = { start: 0, end: 0 }
    }
  }

  function selectMode(nextMode: CreateServiceMode): void {
    setMode(nextMode)
    setLocalError(null)
    setLocalMessage(null)
  }

  function resetTemplate(): void {
    const nextTemplate = buildNewServiceTemplate(previewLabel)

    templateRef.current = nextTemplate
    setDraftContent(nextTemplate)
    setLocalError(null)
    setLocalMessage('Reset the template to match the current label.')
    selectionRef.current = {
      start: nextTemplate.length,
      end: nextTemplate.length
    }

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current

      if (!textarea) {
        return
      }

      textarea.focus()
      textarea.setSelectionRange(nextTemplate.length, nextTemplate.length)
    })
  }

  function applyRepositoryDraft(draft: RepositoryLaunchdDraft): void {
    const firstMatchingOption = draft.runCommandOptions.find(
      (option) => option.command === draft.runCommand
    )

    setRepositoryState((current) => ({
      ...current,
      draft,
      runCommand: draft.runCommand,
      commandOptionId: firstMatchingOption?.id ?? 'custom'
    }))
    handleLabelChange(draft.label)
  }

  async function selectRepository(): Promise<void> {
    setRepositoryState((current) => ({ ...current, busy: true }))
    setLocalError(null)
    setLocalMessage(null)

    try {
      const draft = await window.launchdControl.selectRepositoryForService()

      if (!draft) {
        setLocalMessage('Repository selection canceled.')
        return
      }

      setMode('repository')
      applyRepositoryDraft(draft)
      setLocalMessage(
        draft.runCommand
          ? `Selected ${draft.repositoryName}. Review the detected command before creating the service.`
          : `Selected ${draft.repositoryName}. Enter the command LaunchControl should run from that repository.`
      )
    } catch (selectError) {
      setLocalError(selectError instanceof Error ? selectError.message : String(selectError))
    } finally {
      setRepositoryState((current) => ({ ...current, busy: false }))
    }
  }

  function selectRepositoryCommand(optionId: string): void {
    setRepositoryState((current) => ({ ...current, commandOptionId: optionId }))
    setLocalError(null)
    setLocalMessage(null)

    if (optionId === 'custom') {
      return
    }

    const option = repositoryCommandOptions.find((candidate) => candidate.id === optionId)

    if (option) {
      setRepositoryState((current) => ({ ...current, runCommand: option.command }))
      setLocalMessage(`Using ${option.label}.`)
    }
  }

  async function handleSnippetCopy(snippet: LaunchdPlistSnippet): Promise<void> {
    try {
      await copyTextToClipboard(snippet.snippet)
      setCopiedSnippetKey(snippet.key)
      setLocalError(null)
      setLocalMessage(`Copied ${snippet.title}.`)
    } catch (copyError) {
      setLocalError(copyError instanceof Error ? copyError.message : String(copyError))
    }
  }

  function insertSnippet(snippet: LaunchdPlistSnippet): void {
    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? selectionRef.current.start
    const selectionEnd = textarea?.selectionEnd ?? selectionRef.current.end
    const textToInsert = snippet.insertText ?? snippet.snippet
    const head = draftContent.slice(0, selectionStart)
    const tail = draftContent.slice(selectionEnd)
    const prefix = head.length > 0 && !head.endsWith('\n') ? '\n' : ''
    const suffix = tail.length > 0 && !tail.startsWith('\n') ? '\n' : ''
    const inserted = `${prefix}${textToInsert}${suffix}`
    const nextContent = `${head}${inserted}${tail}`
    const cursor = head.length + inserted.length

    setDraftContent(nextContent)
    setLocalError(null)
    setLocalMessage(`Inserted ${snippet.title} at the cursor.`)
    selectionRef.current = { start: cursor, end: cursor }

    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current

      if (!nextTextarea) {
        return
      }

      nextTextarea.focus()
      nextTextarea.setSelectionRange(cursor, cursor)
    })
  }

  function handleSnippetKeyDown(
    event: KeyboardEvent<HTMLElement>,
    snippet: LaunchdPlistSnippet
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    void handleSnippetCopy(snippet)
  }

  async function submit(): Promise<void> {
    if (!normalizedLabel) {
      setLocalError('Service label is required.')
      labelInputRef.current?.focus()
      return
    }

    if (!serviceLabelPattern.test(normalizedLabel)) {
      setLocalError('Use letters, numbers, dots, dashes, and underscores only.')
      labelInputRef.current?.focus()
      return
    }

    if (mode === 'repository') {
      if (!repositoryDraft) {
        setLocalError('Choose a repository first.')
        return
      }

      if (!repositoryRunCommand.trim()) {
        setLocalError('Run command is required.')
        return
      }
    } else if (!draftContent.trim()) {
      setLocalError('Plist content is required.')
      textareaRef.current?.focus()
      return
    }

    setLocalError(null)
    setLocalMessage(null)

    try {
      await onCreate({
        label: normalizedLabel,
        plistContent:
          mode === 'repository' && repositoryDraft ? repositoryPlistContent : draftContent
      })
    } catch (createError) {
      setLocalError(createError instanceof Error ? createError.message : String(createError))
    }
  }

  return (
    <section className="detail-panel source-panel create-service-panel">
      <header className="detail-panel__header detail-panel__header--split">
        <div>
          <p className="eyebrow">New launch agent</p>
          <h3>Create service</h3>
          <p className="detail-panel__summary">
            The plist Label and the destination filename stay aligned. LaunchControl validates the
            XML before it writes the new service into your LaunchAgents folder.
          </p>
        </div>
        <div className="create-service-panel__destination">
          <span>Destination</span>
          <strong>{destinationPath}</strong>
        </div>
      </header>

      {localError ? <div className="error-banner">{localError}</div> : null}

      <div className="plist-editor is-editing">
        <div className="create-mode-switch" aria-label="Service creation method">
          <button
            aria-pressed={mode === 'plist'}
            className={`create-mode-switch__button ${mode === 'plist' ? 'is-active' : ''}`}
            onClick={() => selectMode('plist')}
            type="button"
          >
            Raw plist
          </button>
          <button
            aria-pressed={mode === 'repository'}
            className={`create-mode-switch__button ${mode === 'repository' ? 'is-active' : ''}`}
            onClick={() => selectMode('repository')}
            type="button"
          >
            Repository
          </button>
        </div>

        {mode === 'plist' ? (
          <>
            <div className="create-service-panel__fields">
              <label className="field-group">
                <span>Service label</span>
                <input
                  ref={labelInputRef}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => handleLabelChange(event.target.value)}
                  placeholder="com.example.agent"
                  spellCheck={false}
                  value={label}
                />
              </label>
              <p className="sidebar-detail">
                Use a reverse-DNS style label like `com.acme.worker`. The plist `Label` key must
                match this value exactly.
              </p>
            </div>

            <div className="plist-editor__workspace">
              <label className="field-group">
                <span>Raw plist XML</span>
                <textarea
                  ref={textareaRef}
                  className="plist-editor__textarea"
                  onChange={(event) => {
                    setDraftContent(event.target.value)
                    syncSelection(event.target)
                    setLocalError(null)
                    setLocalMessage(null)
                  }}
                  onClick={(event) => syncSelection(event.currentTarget)}
                  onKeyUp={(event) => syncSelection(event.currentTarget)}
                  onSelect={(event) => syncSelection(event.currentTarget)}
                  spellCheck={false}
                  value={draftContent}
                />
              </label>

              <aside className="plist-library" aria-label="launchd plist snippets">
                <header className="plist-library__header">
                  <h4>Insert library</h4>
                  <p>Copy a snippet or insert it at the cursor.</p>
                </header>

                <div className="plist-library__list">
                  {[
                    { key: 'plist', title: '.plist keys', snippets: launchdPlistLibrary },
                    { key: 'launchd', title: 'launchd commands', snippets: launchdCommandLibrary }
                  ].map((section) => (
                    <section key={section.key} className="plist-library__section">
                      <h5>{section.title}</h5>
                      {section.snippets.map((snippet) => {
                        const copied = copiedSnippetKey === snippet.key

                        return (
                          <article
                            key={snippet.key}
                            aria-label={`${snippet.title} snippet`}
                            className={`plist-snippet-card ${copied ? 'is-copied' : ''}`}
                            onClick={() => void handleSnippetCopy(snippet)}
                            onKeyDown={(event) => handleSnippetKeyDown(event, snippet)}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="plist-snippet-card__header">
                              <div>
                                <strong>{snippet.title}</strong>
                                <p>{snippet.description}</p>
                              </div>
                              <span className="plist-snippet-card__badge">
                                {copied ? 'Copied' : 'Copy'}
                              </span>
                            </div>
                            <pre className="plist-snippet-card__preview">{snippet.snippet}</pre>
                            <button
                              className="ghost-button sidebar-button"
                              onClick={(event) => {
                                event.stopPropagation()
                                insertSnippet(snippet)
                              }}
                              type="button"
                            >
                              Insert
                            </button>
                          </article>
                        )
                      })}
                    </section>
                  ))}
                </div>
              </aside>
            </div>
          </>
        ) : (
          <>
            <div className="create-service-panel__fields create-service-panel__fields--repository">
              <label className="field-group">
                <span>Service label</span>
                <input
                  ref={labelInputRef}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => handleLabelChange(event.target.value)}
                  placeholder="com.launchcontrol.repo.app"
                  spellCheck={false}
                  value={label}
                />
              </label>
              <div className="repository-picker">
                <span>Repository</span>
                <button
                  className="ghost-button sidebar-button"
                  disabled={busy || repositoryBusy}
                  onClick={() => void selectRepository()}
                  type="button"
                >
                  <span className="button-icon">
                    <Folder />
                  </span>
                  <span className="button-label">
                    {repositoryBusy
                      ? 'Selecting...'
                      : repositoryDraft
                        ? 'Change repository'
                        : 'Choose repository'}
                  </span>
                </button>
                {repositoryDraft ? (
                  <strong>{repositoryDraft.repositoryPath}</strong>
                ) : (
                  <p>Choose a repository to detect its run command.</p>
                )}
              </div>
            </div>

            {repositoryDraft ? (
              <div className="repository-registration">
                <div className="repository-registration__grid">
                  {repositoryCommandOptions.length > 0 ? (
                    <label className="field-group">
                      <span>Detected command</span>
                      <select
                        onChange={(event) => selectRepositoryCommand(event.target.value)}
                        value={repositoryCommandOptionId}
                      >
                        {repositoryCommandOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                        <option value="custom">Custom command</option>
                      </select>
                    </label>
                  ) : null}

                  <label className="field-group">
                    <span>Run command</span>
                    <input
                      autoCapitalize="off"
                      autoCorrect="off"
                      onChange={(event) => {
                        setRepositoryState((current) => ({
                          ...current,
                          runCommand: event.target.value,
                          commandOptionId: 'custom'
                        }))
                        setLocalError(null)
                        setLocalMessage(null)
                      }}
                      placeholder="exec /usr/bin/env npm run start"
                      spellCheck={false}
                      value={repositoryRunCommand}
                    />
                  </label>
                </div>

                <p className="sidebar-detail">
                  {selectedRepositoryCommand?.detail ?? repositoryDraft.runCommandSource}
                </p>

                <div className="repository-registration__toggles">
                  <label aria-label="Run when loaded" className="toggle-field">
                    <input
                      checked={repositoryRunAtLoad}
                      onChange={(event) =>
                        setRepositoryState((current) => ({
                          ...current,
                          runAtLoad: event.target.checked
                        }))
                      }
                      type="checkbox"
                    />
                    <span>
                      <strong>Run when loaded</strong>
                      <em>Writes RunAtLoad so launchd starts it after the agent loads.</em>
                    </span>
                  </label>
                  <label aria-label="Keep repository command running" className="toggle-field">
                    <input
                      checked={repositoryKeepAlive}
                      onChange={(event) =>
                        setRepositoryState((current) => ({
                          ...current,
                          keepAlive: event.target.checked
                        }))
                      }
                      type="checkbox"
                    />
                    <span>
                      <strong>Keep running</strong>
                      <em>Writes KeepAlive and a restart throttle for long-running services.</em>
                    </span>
                  </label>
                </div>

                <label className="field-group">
                  <span>Generated plist XML</span>
                  <textarea
                    className="plist-editor__textarea repository-plist-preview"
                    readOnly
                    spellCheck={false}
                    value={repositoryPlistContent}
                  />
                </label>
              </div>
            ) : (
              <div className="repository-empty">
                <p>Select a repository to generate a launch agent with WorkingDirectory, command,
                  logs, and automatic launch keys.</p>
              </div>
            )}
          </>
        )}

        {localMessage ? <p className="sidebar-detail">{localMessage}</p> : null}

        <div className="panel-actions plist-editor__actions">
          <button
            className="ghost-button sidebar-button"
            disabled={busy || repositoryBusy || (mode === 'repository' && !repositoryDraft)}
            onClick={() => void submit()}
            type="button"
          >
            {busy
              ? mode === 'repository'
                ? 'Registering repository...'
                : 'Creating service...'
              : mode === 'repository'
                ? 'Register repository'
                : 'Create service'}
          </button>
          {mode === 'repository' ? (
            <button
              className="ghost-button sidebar-button"
              disabled={busy || repositoryBusy}
              onClick={() => void selectRepository()}
              type="button"
            >
              {repositoryDraft ? 'Change repository' : 'Choose repository'}
            </button>
          ) : (
            <button
              className="ghost-button sidebar-button"
              disabled={busy}
              onClick={() => resetTemplate()}
              type="button"
            >
              Reset template
            </button>
          )}
          <button
            className="ghost-button sidebar-button"
            disabled={busy || repositoryBusy}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  )
}

function TreeServiceDetail({
  service,
  services,
  busyLabel,
  treeBusy,
  feedbacks,
  onSelect,
  onAction,
  onRename,
  onLog,
  onSaveAutomation,
  onSavePlist
}: {
  service: LaunchdService | null
  services: LaunchdService[]
  busyLabel: string | null
  treeBusy: boolean
  feedbacks: Record<string, CardFeedback>
  onSelect: (label: string) => void
  onAction: (label: string, action: LaunchdAction) => Promise<void>
  onRename: (label: string, alias: string) => Promise<void>
  onLog: (label: string, kind: LogKind) => Promise<void>
  onSaveAutomation: (label: string, settings: ServiceAutomationSettings) => Promise<void>
  onSavePlist: (label: string, content: string) => Promise<void>
}): JSX.Element {
  if (!service) {
    return (
      <div className="service-detail service-detail--tree">
        <div className="empty-state">Select a service in the tree to view its details.</div>
      </div>
    )
  }

  return (
    <div className="service-detail service-detail--tree">
      <section className="detail-panel">
        <header className="detail-panel__header">
          <p className="eyebrow">Selection</p>
          <h3>{service.name}</h3>
          <p className="detail-panel__summary">{getServiceStateSummary(service)}</p>
        </header>

        <div className="detail-fields">
          <div>
            <span>Label</span>
            <strong>{service.label}</strong>
          </div>
          <div>
            <span>Launchd</span>
            <strong>{service.enabled ? 'Enabled' : 'Disabled'}</strong>
          </div>
          <div>
            <span>Plist</span>
            <strong>{service.plistName ?? 'Not managed by this app'}</strong>
            {service.serviceInfo ? <em className="detail-panel__copy">{service.serviceInfo}</em> : null}
          </div>
          <div>
            <span>Output</span>
            <strong>
              {service.logTargets.find((target) => target.kind === 'stdout')?.path ?? 'Not declared'}
            </strong>
          </div>
          <div>
            <span>Err</span>
            <strong>
              {service.logTargets.find((target) => target.kind === 'stderr')?.path ?? 'Not declared'}
            </strong>
          </div>
        </div>
      </section>

      <ServiceCard
        active
        allServices={services}
        busy={treeBusy || busyLabel === service.label}
        delayIndex={0}
        feedback={feedbacks[service.label] ?? getDefaultCardFeedback(service)}
        onAction={onAction}
        onLog={onLog}
        onRename={onRename}
        onSelect={onSelect}
        service={service}
      />

      <section className="detail-panel">
        <header className="detail-panel__header">
          <p className="eyebrow">Automation</p>
          <h3>Rules</h3>
          <p className="detail-panel__summary">{summarizeAutomation(service, services)}</p>
        </header>

        <AutomationPanel
          busy={treeBusy || busyLabel === service.label}
          onSave={onSaveAutomation}
          service={service}
          services={services}
        />
      </section>

      <LaunchdPlistEditorPanel
        busy={treeBusy || busyLabel === service.label}
        onSave={onSavePlist}
        service={service}
      />
    </div>
  )
}

function LaunchdPlistEditorPanel({
  service,
  busy,
  onSave
}: {
  service: LaunchdService
  busy: boolean
  onSave: (label: string, content: string) => Promise<void>
}): JSX.Element {
  const [document, setDocument] = useState<LaunchdPlistDocument | null>(null)
  const [draftContent, setDraftContent] = useState('')
  const [editing, setEditing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localMessage, setLocalMessage] = useState<string | null>(null)
  const [copiedSnippetKey, setCopiedSnippetKey] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const selectionRef = useRef({ start: 0, end: 0 })
  const dirty = document !== null && draftContent !== document.plistContent

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setEditing(false)
    setError(null)
    setDocument(null)
    setDraftContent('')
    setLocalMessage(null)
    setCopiedSnippetKey(null)
    selectionRef.current = { start: 0, end: 0 }

    void window.launchdControl
      .readPlist(service.label)
      .then((nextDocument) => {
        if (cancelled) {
          return
        }

        setDocument(nextDocument)
        setDraftContent(nextDocument.plistContent)
      })
      .catch((documentError) => {
        if (cancelled) {
          return
        }

        setError(documentError instanceof Error ? documentError.message : String(documentError))
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [service])

  useEffect(() => {
    if (!copiedSnippetKey) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedSnippetKey(null)
    }, 1800)

    return () => window.clearTimeout(timeoutId)
  }, [copiedSnippetKey])

  useEffect(() => {
    if (!editing) {
      return
    }

    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current

      if (!textarea) {
        return
      }

      textarea.focus()
      const { start, end } = selectionRef.current
      const cursor = Number.isFinite(start) ? start : draftContent.length
      textarea.setSelectionRange(cursor, Number.isFinite(end) ? end : cursor)
    })
  }, [editing])

  function syncSelection(target: HTMLTextAreaElement): void {
    selectionRef.current = {
      start: target.selectionStart,
      end: target.selectionEnd
    }
  }

  function beginEdit(): void {
    if (!document) {
      return
    }

    setDraftContent(document.plistContent)
    selectionRef.current = {
      start: document.plistContent.length,
      end: document.plistContent.length
    }
    setError(null)
    setLocalMessage(null)
    setEditing(true)
  }

  function cancelEdit(): void {
    setDraftContent(document?.plistContent ?? '')
    setError(null)
    setLocalMessage(null)
    setCopiedSnippetKey(null)
    setEditing(false)
  }

  async function handleSnippetCopy(snippet: LaunchdPlistSnippet): Promise<void> {
    try {
      await copyTextToClipboard(snippet.snippet)
      setCopiedSnippetKey(snippet.key)
      setError(null)
      setLocalMessage(`Copied ${snippet.title}.`)
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : String(copyError))
    }
  }

  function insertSnippet(snippet: LaunchdPlistSnippet): void {
    const textarea = textareaRef.current
    const selectionStart = textarea?.selectionStart ?? selectionRef.current.start
    const selectionEnd = textarea?.selectionEnd ?? selectionRef.current.end
    const textToInsert = snippet.insertText ?? snippet.snippet
    const head = draftContent.slice(0, selectionStart)
    const tail = draftContent.slice(selectionEnd)
    const prefix = head.length > 0 && !head.endsWith('\n') ? '\n' : ''
    const suffix = tail.length > 0 && !tail.startsWith('\n') ? '\n' : ''
    const inserted = `${prefix}${textToInsert}${suffix}`
    const nextContent = `${head}${inserted}${tail}`
    const cursor = head.length + inserted.length

    setDraftContent(nextContent)
    setError(null)
    setLocalMessage(`Inserted ${snippet.title} at the cursor.`)
    selectionRef.current = { start: cursor, end: cursor }

    window.requestAnimationFrame(() => {
      const nextTextarea = textareaRef.current

      if (!nextTextarea) {
        return
      }

      nextTextarea.focus()
      nextTextarea.setSelectionRange(cursor, cursor)
    })
  }

  function handleSnippetKeyDown(
    event: KeyboardEvent<HTMLElement>,
    snippet: LaunchdPlistSnippet
  ): void {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }

    event.preventDefault()
    void handleSnippetCopy(snippet)
  }

  async function submit(): Promise<void> {
    if (!document) {
      return
    }

    setError(null)
    setLocalMessage(null)

    try {
      await onSave(service.label, draftContent)
      setDocument((current) =>
        current
          ? {
              ...current,
              plistContent: draftContent,
              generatedAt: new Date().toISOString()
            }
          : current
      )
      setLocalMessage('Saved to disk. launchd reads changes after the agent is reloaded or restarted.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    }
  }

  return (
    <section className="detail-panel source-panel">
      <header className="detail-panel__header detail-panel__header--split">
        <div>
          <p className="eyebrow">{editing ? 'Plist editor' : 'Plist overview'}</p>
          <h3>Launchd plist</h3>
          <p className="detail-panel__summary">
            {loading ? 'Loading plist...' : (document?.plistPath ?? 'Plist unavailable.')}
          </p>
        </div>
        {!loading && document ? (
          editing ? (
            <button className="ghost-button" onClick={() => cancelEdit()} type="button">
              Close editor
            </button>
          ) : (
            <button className="ghost-button" onClick={() => beginEdit()} type="button">
              Edit plist
            </button>
          )
        ) : null}
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {loading ? <div className="empty-state">Loading plist...</div> : null}
      {!loading && document ? (
        <div className={`plist-editor ${editing ? 'is-editing' : 'is-reading'}`}>
          {editing ? (
            <div className="plist-editor__workspace">
              <label className="field-group">
                <span>Raw plist XML</span>
                <textarea
                  ref={textareaRef}
                  className="plist-editor__textarea"
                  onChange={(event) => {
                    setDraftContent(event.target.value)
                    syncSelection(event.target)
                    setError(null)
                    setLocalMessage(null)
                  }}
                  onClick={(event) => syncSelection(event.currentTarget)}
                  onKeyUp={(event) => syncSelection(event.currentTarget)}
                  onSelect={(event) => syncSelection(event.currentTarget)}
                  spellCheck={false}
                  value={draftContent}
                />
              </label>

              <aside className="plist-library" aria-label="launchd plist snippets">
                <header className="plist-library__header">
                  <h4>Insert library</h4>
                  <p>Copy a snippet or insert it at the cursor.</p>
                </header>

                <div className="plist-library__list">
                  {[
                    { key: 'plist', title: '.plist keys', snippets: launchdPlistLibrary },
                    { key: 'launchd', title: 'launchd commands', snippets: launchdCommandLibrary }
                  ].map((section) => (
                    <section key={section.key} className="plist-library__section">
                      <h5>{section.title}</h5>
                      {section.snippets.map((snippet) => {
                        const copied = copiedSnippetKey === snippet.key

                        return (
                          <article
                            key={snippet.key}
                            aria-label={`${snippet.title} snippet`}
                            className={`plist-snippet-card ${copied ? 'is-copied' : ''}`}
                            onClick={() => void handleSnippetCopy(snippet)}
                            onKeyDown={(event) => handleSnippetKeyDown(event, snippet)}
                            role="button"
                            tabIndex={0}
                          >
                            <div className="plist-snippet-card__header">
                              <div>
                                <strong>{snippet.title}</strong>
                                <p>{snippet.description}</p>
                              </div>
                              <span className="plist-snippet-card__badge">
                                {copied ? 'Copied' : 'Copy'}
                              </span>
                            </div>
                            <pre className="plist-snippet-card__preview">{snippet.snippet}</pre>
                            <button
                              className="ghost-button sidebar-button"
                              onClick={(event) => {
                                event.stopPropagation()
                                insertSnippet(snippet)
                              }}
                              type="button"
                            >
                              Insert
                            </button>
                          </article>
                        )
                      })}
                    </section>
                  ))}
                </div>
              </aside>
            </div>
          ) : (
            <div className="plist-read">
              <pre className="source-panel__content plist-read__preview">{document.plistContent}</pre>
            </div>
          )}

          {localMessage ? <p className="sidebar-detail">{localMessage}</p> : null}

          {editing ? (
            <div className="panel-actions plist-editor__actions">
              <button
                className="ghost-button sidebar-button"
                disabled={busy || !dirty}
                onClick={() => void submit()}
                type="button"
              >
                {busy ? 'Saving plist...' : 'Save plist'}
              </button>
              <button
                className="ghost-button sidebar-button"
                disabled={busy || !dirty || !document}
                onClick={() => {
                  setDraftContent(document?.plistContent ?? '')
                  setError(null)
                  setLocalMessage('Reverted to the on-disk plist.')
                  selectionRef.current = {
                    start: document?.plistContent.length ?? 0,
                    end: document?.plistContent.length ?? 0
                  }
                }}
                type="button"
              >
                Revert changes
              </button>
              <button
                className="ghost-button sidebar-button"
                disabled={busy}
                onClick={() => cancelEdit()}
                type="button"
              >
                Cancel edit
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function ServiceTree({
  nodes,
  activeLabel,
  draggedLabels,
  dropTargetPath,
  expandedFolders,
  feedbacks,
  selectedLabels,
  selectionBusy,
  servicesByLabel,
  onDragEnd,
  onDragServiceStart,
  onDropLabels,
  onDropTargetChange,
  onOpenFolderMenu,
  onMoveSelection,
  onSelect,
  onToggleSelection,
  onToggleFolder,
  level = 0
}: {
  nodes: ServiceTreeNode[]
  activeLabel: string | null
  draggedLabels: string[]
  dropTargetPath: string | null
  expandedFolders: Record<string, boolean>
  feedbacks: Record<string, CardFeedback>
  selectedLabels: string[]
  selectionBusy: boolean
  servicesByLabel: Record<string, LaunchdService>
  onDragEnd: () => void
  onDragServiceStart: (label: string) => string[]
  onDropLabels: (labels: string[], folderPath: string) => Promise<void>
  onDropTargetChange: (folderPath: string | null) => void
  onOpenFolderMenu: (folder: ServiceTreeFolder, clientX: number, clientY: number) => void
  onMoveSelection: (folderPath: string) => Promise<void>
  onSelect: (label: string) => void
  onToggleSelection: (label: string) => void
  onToggleFolder: (path: string) => void
  level?: number
}): JSX.Element {
  const selectedSet = new Set(selectedLabels)
  const draggedSet = new Set(draggedLabels)

  return (
    <ul className="service-tree">
      {nodes.map((node) => {
        const rowStyle = { '--tree-level': level } as CSSProperties

        if (node.type === 'folder') {
          const expanded = expandedFolders[node.path] ?? true
          const canMoveSelection =
            !selectionBusy &&
            selectedLabels.length > 0 &&
            selectedLabels.some((label) => {
              const service = servicesByLabel[label]
              return service ? getServiceFolderPath(service) !== node.path : false
            })
          const canReceiveDrop =
            !selectionBusy &&
            draggedLabels.some((label) => {
              const service = servicesByLabel[label]
              return service ? getServiceFolderPath(service) !== node.path : false
            })
          const isDropTarget = canMoveSelection || canReceiveDrop
          const isDragOver = canReceiveDrop && dropTargetPath === node.path
          const folderMeta = canReceiveDrop
            ? `Drop ${draggedLabels.length} here`
            : canMoveSelection
              ? `Move ${selectedLabels.length} here`
              : node.runningCount > 0
                ? `${node.runningCount}/${node.serviceCount} running`
                : `${node.serviceCount} item${node.serviceCount === 1 ? '' : 's'}`

          const handleFolderClick = (): void => {
            if (canMoveSelection) {
              void onMoveSelection(node.path)
              return
            }

            onToggleFolder(node.path)
          }

          const handleFolderDragEnter = (event: DragEvent<HTMLDivElement>): void => {
            if (!canReceiveDrop) {
              return
            }

            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            onDropTargetChange(node.path)
          }

          const handleFolderDragLeave = (event: DragEvent<HTMLDivElement>): void => {
            const nextTarget = event.relatedTarget

            if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
              return
            }

            if (dropTargetPath === node.path) {
              onDropTargetChange(null)
            }
          }

          const handleFolderDragOver = (event: DragEvent<HTMLDivElement>): void => {
            if (!canReceiveDrop) {
              return
            }

            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            onDropTargetChange(node.path)
          }

          const handleFolderDrop = (event: DragEvent<HTMLDivElement>): void => {
            if (!canReceiveDrop) {
              return
            }

            event.preventDefault()
            event.stopPropagation()

            const transferredLabels = getTreeDragTransferLabels(event.dataTransfer)
            void onDropLabels(
              transferredLabels.length > 0 ? transferredLabels : draggedLabels,
              node.path
            )
          }

          const handleFolderContextMenu = (event: MouseEvent<HTMLDivElement>): void => {
            event.preventDefault()
            event.stopPropagation()
            onOpenFolderMenu(node, event.clientX, event.clientY)
          }

          const handleFolderKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault()
              const bounds = event.currentTarget.getBoundingClientRect()
              onOpenFolderMenu(node, bounds.left + 24, bounds.bottom - 8)
              return
            }

            handleTreeRowKeyDown(event, handleFolderClick)
          }

          return (
            <li key={node.path}>
              <div
                aria-expanded={expanded}
                className={`tree-row tree-row--folder ${isDropTarget ? 'is-drop-target' : ''} ${
                  isDragOver ? 'is-drag-over' : ''
                }`}
                onClick={handleFolderClick}
                onDragEnter={handleFolderDragEnter}
                onDragLeave={handleFolderDragLeave}
                onDragOver={handleFolderDragOver}
                onDrop={handleFolderDrop}
                onContextMenu={handleFolderContextMenu}
                onKeyDown={handleFolderKeyDown}
                role="button"
                style={rowStyle}
                tabIndex={0}
              >
                <button
                  aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                  className="tree-row__slot-button"
                  onClick={(event) => {
                    event.stopPropagation()
                    onToggleFolder(node.path)
                  }}
                  type="button"
                >
                  <span className={`tree-row__caret ${expanded ? 'is-expanded' : ''}`}>
                    <ChevronRight />
                  </span>
                </button>
                <span aria-hidden="true" className="tree-row__status tree-row__status--placeholder" />
                <span className="tree-row__icon">
                  <Folder />
                </span>
                <span className="tree-row__label">{node.name}</span>
                <span className="tree-row__meta">{folderMeta}</span>
              </div>
              {expanded ? (
                <ServiceTree
                  activeLabel={activeLabel}
                  draggedLabels={draggedLabels}
                  dropTargetPath={dropTargetPath}
                  expandedFolders={expandedFolders}
                  feedbacks={feedbacks}
                  level={level + 1}
                  nodes={node.children}
                  onDragEnd={onDragEnd}
                  onDragServiceStart={onDragServiceStart}
                  onDropLabels={onDropLabels}
                  onDropTargetChange={onDropTargetChange}
                  onOpenFolderMenu={onOpenFolderMenu}
                  onMoveSelection={onMoveSelection}
                  onSelect={onSelect}
                  onToggleSelection={onToggleSelection}
                  onToggleFolder={onToggleFolder}
                  selectedLabels={selectedLabels}
                  selectionBusy={selectionBusy}
                  servicesByLabel={servicesByLabel}
                />
              ) : null}
            </li>
          )
        }

        const isSelected = selectedSet.has(node.service.label)
        const isDragging = draggedSet.has(node.service.label)
        const displayState = getTreeServiceDisplayState(
          node.service,
          feedbacks[node.service.label] ?? null
        )
        const serviceMeta = isDragging
          ? 'dragging'
          : displayState.statusClass === 'progress'
            ? displayState.label
            : isSelected
              ? 'selected'
              : displayState.label
        const handleServiceClick = (): void => onSelect(node.service.label)
        const handleServiceDragStart = (event: DragEvent<HTMLDivElement>): void => {
          if (selectionBusy) {
            event.preventDefault()
            return
          }

          const labels = onDragServiceStart(node.service.label)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(treeServiceLabelsMimeType, JSON.stringify(labels))
          event.dataTransfer.setData('text/plain', labels.join('\n'))
        }

        return (
          <li key={node.path}>
            <div
              className={`tree-row tree-row--service ${
                node.service.label === activeLabel ? 'is-active' : ''
              } ${isSelected ? 'is-selected' : ''} ${isDragging ? 'is-dragging' : ''}`}
              draggable={!selectionBusy}
              onClick={handleServiceClick}
              onDragEnd={onDragEnd}
              onDragStart={handleServiceDragStart}
              onKeyDown={(event) => handleTreeRowKeyDown(event, handleServiceClick)}
              role="button"
              style={rowStyle}
              tabIndex={0}
            >
              <button
                aria-label={isSelected ? `Deselect ${node.leafName}` : `Select ${node.leafName}`}
                aria-pressed={isSelected}
                className={`tree-row__slot-button tree-row__slot-button--checkbox ${
                  isSelected ? 'is-selected' : ''
                }`}
                disabled={selectionBusy}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggleSelection(node.service.label)
                }}
                type="button"
              >
                {isSelected ? <Check /> : <Square />}
              </button>
              <span className={`tree-row__status is-${displayState.statusClass}`} />
              <span className="tree-row__icon">
                <FileText />
              </span>
              <span className="tree-row__label">{node.leafName}</span>
              <span className="tree-row__meta">{serviceMeta}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function AutomationPanel({
  service,
  services,
  busy,
  onSave
}: {
  service: LaunchdService | null
  services: LaunchdService[]
  busy: boolean
  onSave: (label: string, settings: ServiceAutomationSettings) => Promise<void>
}): JSX.Element {
  const [afterLabel, setAfterLabel] = useState('')
  const [waitFor, setWaitFor] = useState<StartConditionState>('running')
  const [delaySeconds, setDelaySeconds] = useState('0')
  const [automaticStartTimes, setAutomaticStartTimes] = useState('')
  const [startOnLaunch, setStartOnLaunch] = useState(false)
  const [launchDelaySeconds, setLaunchDelaySeconds] = useState('0')
  const [ensureRunning, setEnsureRunning] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (!service) {
      setAfterLabel('')
      setWaitFor('running')
      setDelaySeconds('0')
      setAutomaticStartTimes('')
      setStartOnLaunch(false)
      setLaunchDelaySeconds('0')
      setEnsureRunning(false)
      setLocalError(null)
      return
    }

    setAfterLabel(service.automation.startCondition?.afterLabel ?? '')
    setWaitFor(service.automation.startCondition?.waitFor ?? 'running')
    setDelaySeconds(String(service.automation.startCondition?.delaySeconds ?? 0))
    setAutomaticStartTimes(service.automation.automaticStartTimes.join(', '))
    setStartOnLaunch(service.automation.startOnLaunch)
    setLaunchDelaySeconds(String(service.automation.launchDelaySeconds))
    setEnsureRunning(service.automation.ensureRunning)
    setLocalError(null)
  }, [service])

  if (!service) {
    return <p className="sidebar-empty">Select a service to configure automation.</p>
  }

  const currentService = service
  const availableServices = services.filter((candidate) => candidate.label !== service.label)

  async function submit(): Promise<void> {
    const parsedDelay = Number(delaySeconds)
    const parsedLaunchDelay = Number(launchDelaySeconds)

    if (!Number.isFinite(parsedDelay) || parsedDelay < 0) {
      setLocalError('Delay must be a non-negative number of seconds.')
      return
    }

    if (!Number.isFinite(parsedLaunchDelay) || parsedLaunchDelay < 0) {
      setLocalError('Launch delay must be a non-negative number of seconds.')
      return
    }

    const parsedTimes = parseAutomaticStartTimes(automaticStartTimes)

    if (parsedTimes.invalidEntries.length > 0) {
      setLocalError(`Invalid time values: ${parsedTimes.invalidEntries.join(', ')}`)
      return
    }

    setLocalError(null)
    await onSave(currentService.label, {
      startCondition: afterLabel
        ? {
            afterLabel,
            waitFor,
            delaySeconds: Math.round(parsedDelay)
          }
        : null,
      automaticStartTimes: parsedTimes.times,
      startOnLaunch,
      launchDelaySeconds: startOnLaunch ? Math.round(parsedLaunchDelay) : 0,
      ensureRunning
    })
  }

  return (
    <div className="automation-panel">
      <p className="sidebar-detail">
        Rules run while LaunchControl is open. They apply to any launch agent this app manages,
        including agents whose plist launches a `.sh` script. Add LaunchControl to Login Items if
        you want these starts to act like a system-load scheduler.
      </p>

      <div className="automation-fields">
        <label aria-label="Start when LaunchControl opens" className="toggle-field">
          <input
            checked={startOnLaunch}
            onChange={(event) => setStartOnLaunch(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Start when LaunchControl opens</strong>
            <em>Useful for post-login staging when this app is registered as a Login Item.</em>
          </span>
        </label>

        <label className="field-group">
          <span>Launch delay (sec)</span>
          <input
            disabled={!startOnLaunch}
            inputMode="numeric"
            min="0"
            onChange={(event) => setLaunchDelaySeconds(event.target.value)}
            type="number"
            value={launchDelaySeconds}
          />
        </label>

        <label className="field-group">
          <span>Start after</span>
          <select value={afterLabel} onChange={(event) => setAfterLabel(event.target.value)}>
            <option value="">No dependency</option>
            {availableServices.map((candidate) => (
              <option key={candidate.label} value={candidate.label}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        <div className="field-grid">
          <label className="field-group">
            <span>Wait for</span>
            <select
              disabled={!afterLabel}
              value={waitFor}
              onChange={(event) =>
                setWaitFor(event.target.value === 'loaded' ? 'loaded' : 'running')
              }
            >
              <option value="running">Running</option>
              <option value="loaded">Loaded</option>
            </select>
          </label>

          <label className="field-group">
            <span>Delay (sec)</span>
            <input
              disabled={!afterLabel}
              inputMode="numeric"
              min="0"
              onChange={(event) => setDelaySeconds(event.target.value)}
              type="number"
              value={delaySeconds}
            />
          </label>
        </div>

        <label className="field-group">
          <span>Daily auto-start times</span>
          <input
            onChange={(event) => setAutomaticStartTimes(event.target.value)}
            placeholder="09:00, 17:30"
            value={automaticStartTimes}
          />
        </label>

        <label aria-label="Keep this service running" className="toggle-field">
          <input
            checked={ensureRunning}
            onChange={(event) => setEnsureRunning(event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>Keep this service running</strong>
            <em>LaunchControl will try to restart it whenever it is enabled but not running.</em>
          </span>
        </label>
      </div>

      <p className="sidebar-detail">{summarizeAutomation(currentService, services)}</p>
      {localError ? <p className="form-error">{localError}</p> : null}

      <div className="panel-actions">
        <button className="ghost-button sidebar-button" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving automation...' : 'Save automation'}
        </button>
        <button
          className="ghost-button sidebar-button"
          disabled={busy}
          onClick={() => {
            setAfterLabel('')
            setWaitFor('running')
            setDelaySeconds('0')
            setAutomaticStartTimes('')
            setStartOnLaunch(false)
            setLaunchDelaySeconds('0')
            setEnsureRunning(false)
            setLocalError(null)
            void onSave(currentService.label, {
              startCondition: null,
              automaticStartTimes: [],
              startOnLaunch: false,
              launchDelaySeconds: 0,
              ensureRunning: false
            })
          }}
        >
          Clear automation
        </button>
      </div>
    </div>
  )
}

const ServiceUsageGrid = memo(function ServiceUsageGrid({
  serviceLabel,
  fallbackLoad
}: {
  serviceLabel: string
  fallbackLoad: ServiceLoadSnapshot
}): JSX.Element {
  const usageLoad = useServiceUsageSnapshot(serviceLabel)
  const load = usageLoad ?? fallbackLoad

  return (
    <div className="service-card__load-grid">
      {getServiceLoadMetrics(load).map((metric) => (
        <div
          key={metric.label}
          className={`load-metric ${metric.unavailable ? 'is-unavailable' : ''}`}
          title={metric.title}
        >
          <span className="load-metric__label">{metric.label}</span>
          <strong className="load-metric__value">{metric.value}</strong>
        </div>
      ))}
    </div>
  )
})

function ServiceCard({
  service,
  allServices,
  active,
  busy,
  feedback,
  delayIndex,
  onSelect,
  onAction,
  onRename,
  onLog
}: {
  service: LaunchdService
  allServices: LaunchdService[]
  active: boolean
  busy: boolean
  feedback: CardFeedback
  delayIndex: number
  onSelect: (label: string) => void
  onAction: (label: string, action: LaunchdAction) => Promise<void>
  onRename: (label: string, alias: string) => Promise<void>
  onLog: (label: string, kind: LogKind) => Promise<void>
}): JSX.Element {
  const [draftName, setDraftName] = useState(service.name)
  const [editing, setEditing] = useState(false)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const cardStyle = {
    '--delay': `${delayIndex * 55}ms`,
    '--service-title-size': getAdaptiveTitleSize(service.name)
  } as CSSProperties

  useEffect(() => {
    if (!editing) {
      setDraftName(service.name)
    }
  }, [editing, service.name])

  useEffect(() => {
    if (!editing) {
      return
    }

    window.requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
  }, [editing])

  function submitRename(): void {
    setEditing(false)
    const nextAlias = resolveServiceAliasInput(draftName)
    void onRename(service.label, nextAlias === service.label ? '' : nextAlias)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      submitRename()
      return
    }

    if (event.key === 'Escape') {
      setDraftName(service.name)
      setEditing(false)
    }
  }

  return (
    <article
      className={`service-card status-${service.status} feedback-${feedback.tone} ${
        active ? 'is-active' : ''
      }`}
      onClick={() => onSelect(service.label)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }

        handleTreeRowKeyDown(event, () => onSelect(service.label))
      }}
      role="button"
      style={cardStyle}
      tabIndex={0}
    >
      <div className="service-card__body">
        <div className="service-card__title-row">
          <div className="service-card__headline">
            <span className={`status-pill is-${service.status}`}>{service.status}</span>

            {editing ? (
              <div className="title-editor">
                <input
                  ref={titleInputRef}
                  className="title-editor__input"
                  onChange={(event) => setDraftName(event.target.value)}
                  placeholder="Custom title"
                  onKeyDown={handleKeyDown}
                  value={draftName}
                />
                <button
                  aria-label="Save name"
                  className="icon-button icon-button--small"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    submitRename()
                  }}
                >
                  <Check />
                </button>
                <button
                  aria-label="Cancel rename"
                  className="icon-button icon-button--small"
                  onClick={(event) => {
                    event.stopPropagation()
                    setDraftName(service.name)
                    setEditing(false)
                  }}
                >
                  <X />
                </button>
              </div>
            ) : (
              <div className="title-display">
                <h3>{service.name}</h3>
                <button
                  aria-label="Edit name"
                  className="icon-button icon-button--small"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    setDraftName(service.name)
                    setEditing(true)
                  }}
                  title="Edit name"
                >
                  <Pencil />
                </button>
              </div>
            )}
          </div>
        </div>

        <p className="service-card__label">{service.plistName ?? service.label}</p>
        {service.serviceInfo ? <p className="service-card__info">{service.serviceInfo}</p> : null}
        <ServiceUsageGrid fallbackLoad={service.load} serviceLabel={service.label} />

        <div className="service-card__meta">
          <div className="service-card__signals">
            {getServiceSignals(service, allServices).map((signal) => (
              <span key={signal} className="signal-chip">
                {signal}
              </span>
            ))}
          </div>

          <div className="service-card__log-links">
            <button
              className="inline-link"
              disabled={!service.logTargets.some((target) => target.kind === 'stderr') || busy}
              onClick={(event) => {
                event.stopPropagation()
                void onLog(service.label, 'stderr')
              }}
            >
              err
            </button>
            <button
              className="inline-link"
              disabled={!service.logTargets.some((target) => target.kind === 'stdout') || busy}
              onClick={(event) => {
                event.stopPropagation()
                void onLog(service.label, 'stdout')
              }}
            >
              output
            </button>
          </div>
        </div>
      </div>

      <div className="service-card__actions">
        <button
          aria-label={service.running ? 'Stop service' : 'Start service'}
          className="action-button primary"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            void onAction(service.label, service.running ? 'stop' : 'start')
          }}
          title={service.running ? 'Stop service' : 'Start service'}
        >
          <span className="button-icon">
            {service.running ? <Square /> : <Play />}
          </span>
          <span className="button-label">{service.running ? 'Stop' : 'Start'}</span>
        </button>
        <button
          aria-label="Restart service"
          className="action-button"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            void onAction(service.label, 'restart')
          }}
          title="Restart service"
        >
          <span className="button-icon">
            <RotateCw />
          </span>
          <span className="button-label">Restart</span>
        </button>
        <button
          aria-label={service.enabled ? 'Disable service' : 'Enable service'}
          className="action-button"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            void onAction(service.label, service.enabled ? 'disable' : 'enable')
          }}
          title={service.enabled ? 'Disable service' : 'Enable service'}
        >
          <span className="button-icon">
            <Power />
          </span>
          <span className="button-label">{service.enabled ? 'Disable' : 'Enable'}</span>
        </button>
        <button
          aria-label="Delete service"
          className="action-button danger"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation()
            void onAction(service.label, 'delete')
          }}
          title="Delete service"
        >
          <span className="button-icon">
            <Trash2 />
          </span>
          <span className="button-label">Delete</span>
        </button>
      </div>

      <footer className="service-card__footer">
        <div aria-live="polite" className={`service-card__feedback is-${feedback.tone}`}>
          {feedback.message}
        </div>
        <span className={`service-card__feedback-badge is-${feedback.tone}`}>
          {getFeedbackBadgeLabel(feedback.tone)}
        </span>
      </footer>
    </article>
  )
}

function LogPanel({
  busy,
  onAction,
  onLog,
  onOpenTerminal,
  panel,
  service
}: {
  busy: boolean
  onAction: (label: string, action: LaunchdAction) => Promise<void>
  onLog: (label: string, kind: LogKind) => Promise<void>
  onOpenTerminal: () => void
  panel: LogPanelState
  service: LaunchdService | null
}): JSX.Element {
  const alternateLogKind = getAlternateLogKind(service, panel.kind)
  const failure = panel.failure

  return (
    <article className="log-panel">
      <header className="log-panel__header">
        <div>
          <p className="eyebrow">Tail view</p>
          <h3>{getLogButtonLabel(panel.kind)}</h3>
          <p className="log-panel__subtitle">{panel.title}</p>
        </div>

        <div className="log-panel__meta">
          <span>{panel.subtitle}</span>
          <span>{`tail -n 300`}</span>
          <span>{`Refreshed ${formatGeneratedAt(panel.generatedAt)}`}</span>
          {service ? <span>{service.label}</span> : null}
        </div>
      </header>

      {failure && service ? (
        <section className="log-triage">
          <div className="log-triage__intro">
            <div>
              <p className="eyebrow">Launch failed</p>
              <h4>
                {getActionLabel(failure.action)} needs follow-up
              </h4>
              <p className="log-triage__message">{failure.message}</p>
            </div>
            <div className="log-triage__actions">
              {alternateLogKind ? (
                <button
                  className="ghost-button toolbar-button"
                  disabled={busy}
                  onClick={() => void onLog(service.label, alternateLogKind)}
                  type="button"
                >
                  <span className="button-icon">
                    <FileText />
                  </span>
                  <span className="button-label">{`Show ${getLogButtonLabel(alternateLogKind)}`}</span>
                </button>
              ) : null}
              <button
                className="ghost-button toolbar-button"
                disabled={busy}
                onClick={onOpenTerminal}
                type="button"
              >
                <span className="button-icon">
                  <Terminal />
                </span>
                <span className="button-label">Open terminal</span>
              </button>
              <button
                className="ghost-button toolbar-button"
                disabled={busy}
                onClick={() => void onAction(service.label, failure.action)}
                type="button"
              >
                <span className="button-icon">
                  <RotateCw />
                </span>
                <span className="button-label">{`Retry ${getActionLabel(failure.action).toLowerCase()}`}</span>
              </button>
            </div>
          </div>

          <p className="log-triage__summary">{getServiceStateSummary(service)}</p>

          <div className="log-triage__hints">
            {failure.hints.map((hint) => (
              <article key={hint.title} className="log-triage__hint">
                <strong>{hint.title}</strong>
                <p>{hint.detail}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <pre className="log-panel__output">{panel.content}</pre>
    </article>
  )
}

function TerminalPanel({
  busy,
  panel,
  service,
  onAction,
  onBack
}: {
  busy: boolean
  panel: TerminalPanelState
  service: LaunchdService | null
  onAction: (label: string, action: LaunchdAction) => Promise<void>
  onBack: () => void
}): JSX.Element {
  const terminalHostRef = useRef<HTMLDivElement | null>(null)
  const [exitState, setExitState] = useState<TerminalExitEvent | null>(null)
  const isLogTerminal =
    panel.terminalMode === 'logs' || panel.terminalMode === 'stdout' || panel.terminalMode === 'stderr'
  const failure = panel.failure ?? null

  useEffect(() => {
    const host = terminalHostRef.current

    if (!host) {
      return
    }

    setExitState(null)
    let sessionActive = true
    const term = new XTerm({
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorInactiveStyle: 'none',
      fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 4000,
      theme: {
        background: '#1f1814',
        foreground: '#f6eedf',
        black: '#1f1814',
        red: '#cb6b62',
        green: '#7ebc81',
        yellow: '#d8b869',
        blue: '#7ea7d8',
        magenta: '#b38ed6',
        cyan: '#75bdb7',
        white: '#f6eedf',
        brightBlack: '#7f7068',
        brightRed: '#ef8b82',
        brightGreen: '#9cd79f',
        brightYellow: '#f0d286',
        brightBlue: '#9fc2ee',
        brightMagenta: '#cfacf3',
        brightCyan: '#96d9d3',
        brightWhite: '#fff9ed',
        cursor: '#e68252',
        selectionBackground: 'rgba(230, 130, 82, 0.28)'
      }
    })
    const fitAddon = new FitAddon()
    const scrollLogTerminalToBottom = (): void => {
      if (!isLogTerminal) {
        return
      }

      term.scrollToBottom()
      host.scrollTop = host.scrollHeight
      window.requestAnimationFrame(() => {
        term.scrollToBottom()
        host.scrollTop = host.scrollHeight
      })
    }

    const terminalInput = term.onData((data) => {
      if (!sessionActive) {
        return
      }

      window.launchdControl.writeTerminal(panel.session.id, data)
    })
    const unsubscribeData = window.launchdControl.onTerminalData((event) => {
      if (event.id !== panel.session.id) {
        return
      }

      term.write(event.data, () => {
        scrollLogTerminalToBottom()
      })
    })
    const unsubscribeExit = window.launchdControl.onTerminalExit((event) => {
      if (event.id !== panel.session.id) {
        return
      }

      sessionActive = false
      setExitState(event)
      term.write(
        `\r\n\x1b[33m[terminal exited with code ${event.exitCode}${
          typeof event.signal === 'number' ? `, signal ${event.signal}` : ''
        }]\x1b[0m\r\n`
      )
    })
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()

      if (!sessionActive) {
        return
      }

      window.launchdControl.resizeTerminal(panel.session.id, term.cols, term.rows)
    })

    term.loadAddon(fitAddon)
    host.replaceChildren()
    term.open(host)
    fitAddon.fit()
    term.focus()
    scrollLogTerminalToBottom()
    window.requestAnimationFrame(() => {
      fitAddon.fit()
      scrollLogTerminalToBottom()
      if (sessionActive) {
        window.launchdControl.resizeTerminal(panel.session.id, term.cols, term.rows)
      }
    })
    window.launchdControl.resizeTerminal(panel.session.id, term.cols, term.rows)
    resizeObserver.observe(host)

    return () => {
      sessionActive = false
      resizeObserver.disconnect()
      unsubscribeExit()
      unsubscribeData()
      terminalInput.dispose()
      term.dispose()
    }
  }, [panel.session.id])

  return (
    <article className={`terminal-panel ${isLogTerminal ? 'terminal-panel--log' : ''}`}>
      {!isLogTerminal ? (
        <header className="terminal-panel__header">
          <div>
            <p className="eyebrow">Embedded PTY</p>
            <h3>{getTerminalHeading(panel.terminalMode)}</h3>
            <p className="terminal-panel__subtitle">
              {service ? service.name : panel.session.title}
            </p>
          </div>

          <div className="terminal-panel__meta">
            <span>{panel.session.cwd}</span>
            <span>{panel.session.shell}</span>
            <span>{getTerminalSummary(panel.terminalMode)}</span>
            {service ? <span>{service.label}</span> : null}
          </div>
        </header>
      ) : null}

      {!isLogTerminal ? (
        <div className="terminal-panel__toolbar">
          <p>
            This starts in an interactive shell after printing launchctl context for the selected service.
          </p>
          <div className="terminal-panel__toolbar-actions">
            {exitState ? (
              <span className="terminal-panel__status">
                Exit {exitState.exitCode}
                {typeof exitState.signal === 'number' ? ` · signal ${exitState.signal}` : ''}
              </span>
            ) : (
              <span className="terminal-panel__status is-live">Live session</span>
            )}
            <button className="ghost-button toolbar-button topbar-button" onClick={onBack} type="button">
              <span className="button-icon">
                <ArrowLeft />
              </span>
              <span className="button-label">Back to services</span>
            </button>
          </div>
        </div>
      ) : null}

      <div className="terminal-panel__viewport">
        {isLogTerminal ? (
          <div className="terminal-panel__log-actions">
            {failure && service ? (
              <button
                className="ghost-button toolbar-button topbar-button"
                disabled={busy}
                onClick={() => void onAction(service.label, failure.action)}
                type="button"
              >
                <span className="button-icon">
                  <RotateCw />
                </span>
                <span className="button-label">{`Retry ${getActionLabel(failure.action).toLowerCase()}`}</span>
              </button>
            ) : null}
            {exitState ? (
              <span className="terminal-panel__status">
                Exit {exitState.exitCode}
                {typeof exitState.signal === 'number' ? ` · signal ${exitState.signal}` : ''}
              </span>
            ) : (
              <span className="terminal-panel__status is-live">Live tail</span>
            )}
          </div>
        ) : null}
        <div className="terminal-panel__host" ref={terminalHostRef} />
      </div>
    </article>
  )
}
