import { mkdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { ManagedContainer, resolveMount, waitForContainerManager } from 'signalk-container-helper'
import { remoteWriteAuthArgs } from './remote-write-auth.js'
import { writeSelfScrapeConfig } from './vmagent-self-scrape.js'
import { vmServiceId, webUiPrefix } from './web-ui-paths.js'

export const VICTORIAMETRICS_VERSION = 'v1.152.0'
const NETWORK_NAME = 'signalk-vm-history'

async function connectManaged(manager, unprefixedName) {
  const containers = await manager.listContainers()
  const found = containers.find(item => item.unprefixedName === unprefixedName || item.name.endsWith(`-${unprefixedName}`))
  if (!found) throw new Error(`Cannot find managed container ${unprefixedName}`)
  await manager.connectToNetwork(unprefixedName, NETWORK_NAME)
  return found.name
}

export async function startManagedServices(app, options, signal, selfContext) {
  const dataDir = app.getDataDirPath()
  if (options.ingest.enabled && options.vmagent.mode === 'managed-container') {
    await mkdir(join(dataDir, 'vmagent-queue'), { recursive: true, mode: 0o700 })
  }
  const { manager } = await waitForContainerManager({ signal })
  if (!manager) throw new Error('signalk-container is unavailable')
  if (!manager.ensureNetwork || !manager.connectToNetwork) {
    throw new Error('signalk-container cannot manage the private VictoriaMetrics network')
  }
  await manager.ensureNetwork(NETWORK_NAME)
  const mount = await resolveMount(manager, { containerPath: '/data', hostPath: dataDir })
  const volumes = { '/data': mount.source }
  const containers = []
  const urls = new Map()
  const writeUrls = new Map()
  const uiTargets = new Map()

  try {
    for (const destination of options.destinations) {
      if (destination.mode !== 'managed-container' || (!destination.write?.enabled && !destination.read?.enabled)) continue
      const directory = `vm-${destination.id}`
      const prefix = webUiPrefix(vmServiceId(destination.id), destination.exposeWebUi)
      await mkdir(join(dataDir, directory), { recursive: true, mode: 0o700 })
      const container = new ManagedContainer({
        app,
        pluginId: 'signalk-victoriametrics-history-provider',
        name: `signalk-history-vm-${destination.id}`,
        image: 'victoriametrics/victoria-metrics',
        defaultTag: VICTORIAMETRICS_VERSION,
        buildConfig: tag => ({
          image: 'victoriametrics/victoria-metrics', tag,
          volumes,
          signalkAccessiblePorts: [8428],
          command: [
            '-httpListenAddr=:8428',
            ...(prefix ? [`-http.pathPrefix=${prefix}`] : []),
            `-storageDataPath=${posix.join(mount.containerPath, directory)}`,
            `-retentionPeriod=${destination.retention ?? '30d'}`
          ],
          restart: 'unless-stopped'
        }),
        readiness: { port: 8428, path: `${prefix}/metrics` }
      })
      containers.push(container)
      const result = await container.start(VICTORIAMETRICS_VERSION, { signal })
      if (!result.address) throw new Error(`No address for VictoriaMetrics ${destination.id}`)
      urls.set(destination.id, `${result.address}${prefix}`)
      if (prefix) uiTargets.set(vmServiceId(destination.id), {
        title: `VictoriaMetrics: ${destination.id}`,
        path: `${prefix}/vmui/`,
        origin: new URL(result.address).origin
      })
      const name = await connectManaged(manager, `signalk-history-vm-${destination.id}`)
      writeUrls.set(destination.id, `http://${name}:8428${prefix}/api/v1/write`)
    }

    let agent = null
    if (options.ingest.enabled && options.vmagent.mode === 'managed-container') {
      const prefix = webUiPrefix('vmagent', options.vmagent.exposeWebUi)
      const outputUrls = options.destinations.filter(destination => destination.write?.enabled).map(destination =>
        destination.mode === 'managed-container'
          ? writeUrls.get(destination.id)
          : destination.write.url
      )
      const authArgs = await remoteWriteAuthArgs(options.destinations, dataDir, mount.containerPath, true)
      const scrapeConfig = await writeSelfScrapeConfig(options, dataDir, mount.containerPath, 8429, selfContext, prefix, true)
      agent = new ManagedContainer({
        app,
        pluginId: 'signalk-victoriametrics-history-provider',
        name: 'signalk-history-vmagent',
        image: 'victoriametrics/vmagent',
        defaultTag: VICTORIAMETRICS_VERSION,
        buildConfig: tag => ({
          image: 'victoriametrics/vmagent', tag,
          volumes,
          signalkAccessiblePorts: [8429],
          command: [
            '-httpListenAddr=:8429',
            ...(prefix ? [`-http.pathPrefix=${prefix}`] : []),
            `-remoteWrite.tmpDataPath=${posix.join(mount.containerPath, 'vmagent-queue')}`,
            '-remoteWrite.keepDanglingQueues',
            `-promscrape.config=${scrapeConfig}`,
            `-remoteWrite.maxDiskUsagePerURL=${options.vmagent.queueLimitBytesPerDestination}`,
            ...outputUrls.map(url => `-remoteWrite.url=${url}`),
            ...authArgs
          ],
          restart: 'unless-stopped'
        }),
        readiness: { port: 8429, path: `${prefix}/metrics` }
      })
      containers.push(agent)
      const result = await agent.start(VICTORIAMETRICS_VERSION, { signal })
      if (!result.address) throw new Error('No address for vmagent')
      await connectManaged(manager, 'signalk-history-vmagent')
      urls.set('vmagent', `${result.address}${prefix}`)
      if (prefix) uiTargets.set('vmagent', {
        title: 'vmagent',
        path: `${prefix}/`,
        origin: new URL(result.address).origin
      })
    }

    return {
      urls,
      writeUrls,
      uiTargets,
      stop: async () => {
        for (const container of [...containers].reverse()) await container.stop()
      }
    }
  } catch (error) {
    for (const container of [...containers].reverse()) await container.stop()
    throw error
  }
}
