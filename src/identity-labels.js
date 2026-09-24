export const DEFAULT_JOB = 'signalk-victoriametrics'

export function withIdentityLabels(configuration = {}) {
  const labels = configuration.ingest?.labels ?? {}
  if (labels.job !== undefined && labels.instance !== undefined) {
    return { configuration, changed: false }
  }
  const instance = labels.instance ?? `signalk-victoriametrics-${Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(5)), byte =>
      byte.toString(16).padStart(2, '0')).join('')}`
  return {
    configuration: {
      ...configuration,
      ingest: {
        ...configuration.ingest,
        labels: {
          ...labels,
          job: labels.job ?? DEFAULT_JOB,
          instance
        }
      }
    },
    changed: true
  }
}
