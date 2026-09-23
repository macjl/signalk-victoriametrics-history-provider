export function metricName(path) {
  const name = path.replace(/[^a-zA-Z0-9_:]/g, '_')
  return /^[a-zA-Z_:]/.test(name) ? name : `_${name}`
}

function pathMatches(path, selected) {
  return selected.some(root => path === root || path.startsWith(`${root}.`))
}

function allowed(path, config) {
  const matches = pathMatches(path, config.paths)
  return config.filterMode === 'whitelist' ? matches : !matches
}

function leafSamples(path, value, config, isLeaf = false) {
  if (value === null || value === undefined) return []
  if (typeof value === 'number') return Number.isFinite(value) ? [{ path, value, isLeaf }] : []
  if (typeof value === 'boolean') return [{ path, value: value ? 1 : 0, isLeaf }]
  if (typeof value === 'string') {
    if (!value) return []
    const date = /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN
    return [{ path, value: Number.isFinite(date) ? date : 1, valueStr: Number.isFinite(date) ? undefined : value, isLeaf }]
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leafSamples(`${path}.${key}`, child, config, true))
}

export function deltaToSamples(delta, config, selfContext, now = Date.now()) {
  const context = delta?.context === 'vessels.self' ? selfContext : delta?.context
  if (!context || (config.contexts === 'self' && context !== selfContext)) return []
  const output = []
  for (const update of delta.updates ?? []) {
    if (typeof update.$source !== 'string' || !update.$source) continue
    const parsed = update.timestamp ? Date.parse(update.timestamp) : NaN
    const timestamp = Number.isFinite(parsed) ? parsed : now
    for (const entry of update.values ?? []) {
      const root = entry.path
      if (typeof root !== 'string' || !root) continue
      const position = root === 'navigation.position'
      if (position && (!entry.value || !Number.isFinite(entry.value.longitude) || !Number.isFinite(entry.value.latitude))) continue
      const leaves = position
        ? leafSamples(root, {
            longitude: entry.value.longitude,
            latitude: entry.value.latitude
          }, config)
        : leafSamples(root, entry.value, config)
      if (position && leaves.filter(leaf => allowed(leaf.path, config)).length !== 2) continue
      for (const leaf of leaves) {
        if (!allowed(leaf.path, config)) continue
        const labels = {
          __name__: metricName(leaf.path),
          context,
          source: update.$source,
          signalk_path: root,
          preferred: 'true',
          ...config.labels
        }
        if (leaf.isLeaf) labels.signalk_leaf = leaf.path
        if (leaf.valueStr !== undefined) labels.value_str = leaf.valueStr
        output.push({ labels, value: leaf.value, timestamp })
      }
    }
  }
  return output
}
