import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import type {
  LaunchdService,
  LaunchdTerminalMode,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo
} from '../shared/types'
import { buildTerminalCommand, getServiceWorkingDirectory } from './launchd'

interface TerminalSession {
  window: BrowserWindow
  pty: IPty
  info: TerminalSessionInfo
}

const sessions = new Map<string, TerminalSession>()

function getShell(): string {
  return process.env.SHELL?.trim() || '/bin/zsh'
}

export function openTerminalSession(
  window: BrowserWindow,
  service: LaunchdService,
  mode: LaunchdTerminalMode
): TerminalSessionInfo {
  const shell = getShell()
  const cwd = getServiceWorkingDirectory(service) || homedir()
  const info: TerminalSessionInfo = {
    id: randomUUID(),
    label: service.label,
    mode,
    title: service.name,
    subtitle:
      mode === 'logs' || mode === 'stdout' || mode === 'stderr'
        ? 'Streaming declared log targets'
        : `Interactive shell for ${service.label}`,
    cwd,
    shell
  }
  const ptyProcess = pty.spawn(shell, ['-lc', buildTerminalCommand(service, mode)], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env: {
      ...process.env,
      COLORTERM: 'truecolor',
      LC_TERMINAL: 'LaunchControl',
      TERM: 'xterm-256color'
    }
  })
  const session: TerminalSession = {
    window,
    pty: ptyProcess,
    info
  }

  sessions.set(info.id, session)

  ptyProcess.onData((data) => {
    if (window.isDestroyed()) {
      closeTerminalSession(info.id)
      return
    }

    window.webContents.send('terminal:data', {
      id: info.id,
      data
    } satisfies TerminalDataEvent)
  })

  ptyProcess.onExit(({ exitCode, signal }) => {
    sessions.delete(info.id)

    if (window.isDestroyed()) {
      return
    }

    window.webContents.send('terminal:exit', {
      id: info.id,
      exitCode,
      signal
    } satisfies TerminalExitEvent)
  })

  return info
}

export function writeTerminalInput(id: string, data: string): void {
  const session = sessions.get(id)

  if (!session) {
    return
  }

  session.pty.write(data)
}

export function resizeTerminalSession(id: string, cols: number, rows: number): void {
  const nextCols = Math.max(2, Math.floor(cols))
  const nextRows = Math.max(1, Math.floor(rows))
  const session = sessions.get(id)

  if (!session) {
    return
  }

  // Renderer cleanup can race with PTY shutdown during panel transitions.
  session.pty.resize(nextCols, nextRows)
}

export function closeTerminalSession(id: string): void {
  const session = sessions.get(id)

  if (!session) {
    return
  }

  sessions.delete(id)
  session.pty.kill()
}

export function closeWindowTerminals(window: BrowserWindow): void {
  for (const [id, session] of sessions.entries()) {
    if (session.window === window) {
      closeTerminalSession(id)
    }
  }
}

export function disposeAllTerminals(): void {
  for (const id of sessions.keys()) {
    closeTerminalSession(id)
  }
}
