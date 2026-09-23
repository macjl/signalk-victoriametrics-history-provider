import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedContainer, resolveMount, waitForContainerManager } from 'signalk-container-helper'

export const DEFAULT_IMAGE_TAG = 'v1.152.0'
const NETWORK_NAME = 'signalk-vm-history'

async function connectManaged(manager, unprefixedName) {
  const containers = await manager.listContainers()
  const found = containers.find(item => item.unprefixedName === unprefixedName || item.name.endsWith(`-${unprefixedName}`))
  if (!found) throw new Error(`Cannot find managed container ${unprefixedName}`)
  await manager.connectToNetwork(unprefixedName, NETWORK_NAME)
  return found.name
}

export async function startManagedServices(app, options, signal) {
  const dataDir = app.getDataDirPath()
  await mkdir(join(dataDir, 'vmagent-queue'), { recursive: true, mode: 0o700 })
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

  try {
    for (const destination of options.destinations) {
      if (destination.mode !== 'managed-container') continue
      const directory = `vm-${destination.id}`
      await mkdir(join(dataDir, directory), { recursive: true, mode: 0o700 })
      const container = new ManagedContainer({
        app,
        pluginId: 'signalk-victoriametrics-history-provider',
        name: `signalk-history-vm-${destination.id}`,
        image: 'victoriametrics/victoria-metrics',
        defaultTag: DEFAULT_IMAGE_TAG,
        buildConfig: tag => ({
          image: 'victoriametrics/victoria-metrics', tag,
          volumes,
          signalkAccessiblePorts: [8428],
          command: [
            '-httpListenAddr=:8428',
            `-storageDataPath=${join(mount.containerPath, directory)}`,
            `-retentionPeriod=${destination.retention ?? '30d'}`
          ],
          restart: 'unless-stopped'
        }),
        readiness: { port: 8428, path: '/metrics' }
      })
      containers.push(container)
      const result = await container.start(destination.imageTag ?? DEFAULT_IMAGE_TAG, { signal })
      if (!result.address) throw new Error(`No address for VictoriaMetrics ${destination.id}`)
      urls.set(destination.id, result.address)
      const name = await connectManaged(manager, `signalk-history-vm-${destination.id}`)
      writeUrls.set(destination.id, `http://${name}:8428/api/v1/write`)
    }

    let agent = null
    if (options.ingest.enabled && options.vmagent.mode === 'managed-container') {
      const outputUrls = options.destinations.filter(destination => destination.write?.enabled).map(destination =>
        destination.mode === 'managed-container'
          ? writeUrls.get(destination.id)
          : destination.write.url
      )
      agent = new ManagedContainer({
        app,
        pluginId: 'signalk-victoriametrics-history-provider',
        name: 'signalk-history-vmagent',
        image: 'victoriametrics/vmagent',
        defaultTag: DEFAULT_IMAGE_TAG,
        buildConfig: tag => ({
          image: 'victoriametrics/vmagent', tag,
          volumes,
          signalkAccessiblePorts: [8429],
          command: [
            '-httpListenAddr=:8429',
            `-remoteWrite.tmpDataPath=${join(mount.containerPath, 'vmagent-queue')}`,
            '-remoteWrite.keepDanglingQueues',
            `-remoteWrite.maxDiskUsagePerURL=${options.vmagent.queueLimitBytesPerDestination}`,
            ...outputUrls.map(url => `-remoteWrite.url=${url}`)
          ],
          restart: 'unless-stopped'
        }),
        readiness: { port: 8429, path: '/metrics' }
      })
      containers.push(agent)
      const result = await agent.start(options.vmagent.imageTag ?? DEFAULT_IMAGE_TAG, { signal })
      if (!result.address) throw new Error('No address for vmagent')
      await connectManaged(manager, 'signalk-history-vmagent')
      urls.set('vmagent', result.address)
    }

    return {
      urls,
      writeUrls,
      stop: async () => {
        for (const container of [...containers].reverse()) await container.stop()
      }
    }
  } catch (error) {
    for (const container of [...containers].reverse()) await container.stop()
    throw error
  }
}
