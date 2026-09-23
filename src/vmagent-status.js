export function parseVmagentStatus(metrics) {
  const status = { pendingBytes: 0, droppedSamples: 0, pushFailures: 0, blockedQueues: 0 }
  const names = {
    pending_data_bytes: 'pendingBytes',
    samples_dropped_total: 'droppedSamples',
    push_failures_total: 'pushFailures',
    queue_blocked: 'blockedQueues'
  }
  for (const line of metrics.split('\n')) {
    const match = /^vmagent_remotewrite_(pending_data_bytes|samples_dropped_total|push_failures_total|queue_blocked)(?:\{[^}]*\})?\s+(\S+)/.exec(line)
    if (!match) continue
    const value = Number(match[2])
    if (Number.isFinite(value)) status[names[match[1]]] += value
  }
  return status
}
