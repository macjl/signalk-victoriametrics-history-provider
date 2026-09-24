import { chmod, chown, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

const CONFIG_FILE = 'vmagent-self-scrape.json'

export async function writeSelfScrapeConfig(options, dataDir, agentDataDir, port, selfContext, pathPrefix = '', containerPaths = false) {
  const labels = Object.fromEntries(Object.entries(options.ingest.labels).filter(([name]) => name !== 'job'))
  labels.instance ??= selfContext
  labels.signalk_context = selfContext
  const scrape = {
    job_name: 'signalk-vmagent',
    scrape_interval: '15s',
    static_configs: [{ targets: [`127.0.0.1:${port}`], labels }]
  }
  if (pathPrefix) scrape.metrics_path = `${pathPrefix}/metrics`
  const config = { scrape_configs: [scrape] }
  const path = join(dataDir, CONFIG_FILE)
  const owner = await stat(dataDir)
  await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600 })
  await chown(path, owner.uid, owner.gid)
  await chmod(path, 0o600)
  const written = await stat(path)
  if (written.uid !== owner.uid || written.gid !== owner.gid) {
    throw new Error('vmagent self-scrape configuration owner could not be set')
  }
  return (containerPaths ? posix.join : join)(agentDataDir, CONFIG_FILE)
}
