export const SESSION_METRIC_NAME = 'signalk_metrics_session_start_time_seconds'
export const SESSION_METRIC_INTERVAL_MS = 15000

export function sessionMetricSample(labels, startedAtMs, timestamp = Date.now()) {
  return {
    labels: {
      __name__: SESSION_METRIC_NAME,
      ...labels,
      source: 'signalk-victoriametrics-history-provider'
    },
    value: startedAtMs / 1000,
    timestamp
  }
}

export function startSessionMetric(batcher, labels, startedAtMs, timers = {
  now: Date.now,
  setInterval,
  clearInterval
}) {
  const publish = () => {
    batcher.add([sessionMetricSample(labels, startedAtMs, timers.now())])
    void batcher.flush()
  }
  publish()
  const timer = timers.setInterval(publish, SESSION_METRIC_INTERVAL_MS)
  return () => timers.clearInterval(timer)
}
