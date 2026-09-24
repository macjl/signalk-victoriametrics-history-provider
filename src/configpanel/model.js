import { validateConfig } from '../config.js'
import { withIdentityLabels } from '../identity-labels.js'

const clone = value => JSON.parse(JSON.stringify(value))
const BYTES_PER_GIB = 1024 ** 3

export const bytesToGiB = bytes => Number((bytes / BYTES_PER_GIB).toFixed(6))
export const giBToBytes = gib => Math.round(gib * BYTES_PER_GIB)

export function initialConfig(configuration = {}) {
  configuration ??= {}
  configuration = withIdentityLabels(configuration).configuration
  const configuredIngest = clone(configuration.ingest ?? {})
  return {
    ...clone(configuration),
    ingest: {
      contexts: 'self',
      filterMode: 'blacklist',
      paths: [],
      minPeriodMs: 5000,
      labels: configuration.ingest.labels,
      ...configuredIngest,
      batch: {
        maxSamples: 500,
        flushMs: 1000,
        maxPendingSamples: 10000,
        ...clone(configuration.ingest?.batch ?? {})
      },
      cardinalityAlert: {
        maxSeriesPerPathPerDay: 100,
        excludedPaths: [],
        ...clone(configuration.ingest?.cardinalityAlert ?? {})
      }
    },
    vmagent: {
      mode: 'managed-container',
      exposeWebUi: false,
      queueLimitBytesPerDestination: 1073741824,
      ...clone(configuration.vmagent ?? {})
    },
    destinations: clone(configuration.destinations ?? [])
  }
}

export function nextDestinationId(destinations) {
  const used = new Set(destinations.map(destination => destination.id))
  let number = 1
  while (used.has(`destination-${number}`)) number++
  return `destination-${number}`
}

export function destinationUsage(destination) {
  if (destination.write?.enabled && destination.read?.enabled) return 'both'
  if (destination.write?.enabled) return 'write'
  if (destination.read?.enabled) return 'read'
  return 'none'
}

export function setDestinationUsage(destinations, index, usage) {
  if (!['write', 'read', 'both'].includes(usage)) throw new Error('Invalid destination usage')
  if (usage !== 'write' && destinations.some((destination, current) => current !== index && destination.read?.enabled)) {
    throw new Error('Only one destination may serve History')
  }
  return destinations.map((destination, current) => current === index ? {
    ...destination,
    write: { ...destination.write, enabled: usage !== 'read' },
    read: { ...destination.read, enabled: usage !== 'write' }
  } : destination)
}

export function selectMode(destination, mode) {
  if (mode === 'remote') return { ...destination, mode, exposeWebUi: false }
  return { ...destination, mode, auth: undefined, exposeWebUi: mode === 'managed-container' ? destination.exposeWebUi : false }
}

export function selectKind(destination, kind) {
  if (kind === 'prometheus-compatible') {
    return {
      ...destination, kind, mode: 'remote', exposeWebUi: false,
      write: { ...destination.write, enabled: true },
      read: { ...destination.read, enabled: false }
    }
  }
  return { ...destination, kind }
}

export function prepareSave(configuration, labelRows) {
  const labels = {
    job: configuration.ingest.labels.job,
    instance: configuration.ingest.labels.instance
  }
  for (const row of labelRows) {
    const name = row.name.trim()
    if (!name && !row.value.trim()) continue
    if (!name || Object.hasOwn(labels, name)) throw new Error('Label names must be present and unique')
    labels[name] = row.value
  }
  const candidate = clone(configuration)
  candidate.ingest.labels = labels
  if (!candidate.destinations.some(destination => destination.write?.enabled)) candidate.vmagent.exposeWebUi = false
  delete candidate.ingest.enabled
  delete candidate.vmagent.imageTag
  for (const destination of candidate.destinations) {
    delete destination.imageTag
    if (destination.kind === 'victoriametrics' && destination.mode === 'remote') {
      if (destination.write) delete destination.write.url
      if (destination.read) delete destination.read.url
    } else {
      delete destination.url
      if (destination.read) delete destination.read.url
    }
  }
  validateConfig(clone(candidate))
  return candidate
}
