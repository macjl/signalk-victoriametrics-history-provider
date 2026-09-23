import { DEFAULT_IMAGE_TAG } from './managed.js'

const read = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false },
    url: { type: 'string', title: 'VictoriaMetrics read URL' },
    limits: { type: 'object', properties: {
      maxRangeDays: { type: 'integer', minimum: 1, default: 30 },
      maxSeries: { type: 'integer', minimum: 1, default: 500 },
      maxSamples: { type: 'integer', minimum: 1, default: 200000 },
      maxResponseBytes: { type: 'integer', minimum: 1, default: 33554432 },
      timeoutMs: { type: 'integer', minimum: 1, default: 15000 }
    } }
  }
}

export const schema = {
  type: 'object',
  properties: {
    ingest: { type: 'object', properties: {
      enabled: { type: 'boolean', default: false },
      contexts: { type: 'string', enum: ['self', 'all'], default: 'self' },
      filterMode: { type: 'string', enum: ['blacklist', 'whitelist'], default: 'blacklist' },
      paths: { type: 'array', items: { type: 'string' }, default: [] },
      minPeriodMs: { type: 'integer', minimum: 0, default: 0 },
      labels: { type: 'object', additionalProperties: { type: 'string' }, default: {} },
      batch: { type: 'object', properties: {
        maxSamples: { type: 'integer', minimum: 1, default: 500 },
        flushMs: { type: 'integer', minimum: 1, default: 200 },
        maxPendingSamples: { type: 'integer', minimum: 1, default: 10000 }
      } }
    } },
    vmagent: { type: 'object', properties: {
      mode: { type: 'string', enum: ['managed-container', 'host-binary'], default: 'managed-container' },
      imageTag: { type: 'string', default: DEFAULT_IMAGE_TAG },
      binaryPath: { type: 'string' },
      queueLimitBytesPerDestination: { type: 'integer', minimum: 1, default: 1073741824 }
    } },
    destinations: { type: 'array', items: { type: 'object', required: ['id', 'kind', 'mode'], properties: {
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
      kind: { type: 'string', enum: ['victoriametrics', 'prometheus-compatible'] },
      mode: { type: 'string', enum: ['managed-container', 'remote'] },
      imageTag: { type: 'string', default: DEFAULT_IMAGE_TAG },
      retention: { type: 'string', default: '30d' },
      write: { type: 'object', properties: {
        enabled: { type: 'boolean', default: false },
        url: { type: 'string' }
      } },
      read
    } } }
  }
}
