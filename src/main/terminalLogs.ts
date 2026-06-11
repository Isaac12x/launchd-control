import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  LaunchdService,
  LaunchdTerminalMode,
  ServiceLogTarget
} from '../shared/types'

export function getTerminalLogTargets(
  service: Pick<LaunchdService, 'logTargets'>,
  mode: LaunchdTerminalMode
): ServiceLogTarget[] {
  if (mode === 'stdout' || mode === 'stderr') {
    return service.logTargets.filter((target) => target.kind === mode)
  }

  return mode === 'logs' ? service.logTargets : []
}

export async function prepareTerminalLogTargets(
  service: Pick<LaunchdService, 'logTargets'>,
  mode: LaunchdTerminalMode
): Promise<void> {
  const paths = new Set(getTerminalLogTargets(service, mode).map((target) => target.path))

  await Promise.all(
    [...paths].map(async (path) => {
      try {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, '', { flag: 'a' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Could not prepare terminal log at ${path}: ${message}`)
      }
    })
  )
}
