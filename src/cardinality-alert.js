import { createHash } from 'node:crypto'

const MAX_TRACKED_PATHS = 500

function excluded(path, paths) {
  return paths.some(root => path === root || path.startsWith(`${root}.`))
}

function fingerprint(labels) {
  const canonical = JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

export class CardinalityAlert {
  constructor({ maxSeriesPerPathPerDay = 100, excludedPaths = [] } = {}) {
    this.limit = maxSeriesPerPathPerDay
    this.excludedPaths = excludedPaths
    this.day = null
    this.paths = new Map()
    this.alerts = new Set()
    this.pathLimitReached = false
  }

  rollover(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10)
    if (day === this.day) return false
    this.day = day
    this.paths.clear()
    this.alerts.clear()
    this.pathLimitReached = false
    return true
  }

  observe(samples, now = Date.now()) {
    let changed = this.rollover(now)
    for (const sample of samples) {
      const path = sample.labels.signalk_path
      if (excluded(path, this.excludedPaths) || this.alerts.has(path)) continue
      let series = this.paths.get(path)
      if (!series) {
        if (this.paths.size >= MAX_TRACKED_PATHS) {
          if (!this.pathLimitReached) changed = true
          this.pathLimitReached = true
          continue
        }
        series = new Set()
        this.paths.set(path, series)
      }
      series.add(fingerprint(sample.labels))
      if (series.size >= this.limit) {
        this.alerts.add(path)
        series.clear()
        changed = true
      }
    }
    return changed
  }

  message() {
    if (!this.alerts.size && !this.pathLimitReached) return ''
    const paths = [...this.alerts].sort()
    const shown = paths.slice(0, 3).join(', ')
    const remainder = paths.length > 3 ? ` (+${paths.length - 3} more)` : ''
    const warning = paths.length
      ? `Cardinality warning: at least ${this.limit} series per path today (UTC): ${shown}${remainder}. Ingestion continues; exclude noisy paths or suppress this alert in advanced settings.`
      : ''
    const limit = this.pathLimitReached ? 'Cardinality monitor reached 500 distinct paths today; some paths are not monitored.' : ''
    return [warning, limit].filter(Boolean).join(' ')
  }
}
