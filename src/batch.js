export class SampleBatcher {
  constructor({ limits, send, onError }) {
    this.limits = limits
    this.send = send
    this.onError = onError
    this.pending = []
    this.dropped = 0
    this.sending = false
    this.timer = setInterval(() => void this.flush(), limits.flushMs)
  }

  add(samples) {
    const room = this.limits.maxPendingSamples - this.pending.length
    this.pending.push(...samples.slice(0, Math.max(0, room)))
    this.dropped += Math.max(0, samples.length - room)
    if (this.pending.length >= this.limits.maxSamples) void this.flush()
  }

  async flush() {
    if (this.sending || this.pending.length === 0) return
    this.sending = true
    const samples = this.pending.splice(0, this.limits.maxSamples)
    try {
      await this.send(samples)
    } catch (error) {
      this.dropped += samples.length
      this.onError(error)
    } finally {
      this.sending = false
      if (this.pending.length >= this.limits.maxSamples) void this.flush()
    }
  }

  stop() {
    clearInterval(this.timer)
    this.dropped += this.pending.length
    this.pending = []
  }
}
