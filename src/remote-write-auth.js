import { chmod, chown, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function remoteWriteAuthArgs(destinations, dataDir, agentDataDir) {
  const writers = destinations.filter(destination => destination.write?.enabled)
  if (!writers.some(destination => destination.auth?.type === 'basic')) return []

  const directory = join(dataDir, 'vmagent-credentials')
  const owner = await stat(dataDir)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chown(directory, owner.uid, owner.gid)
  await chmod(directory, 0o700)
  const directoryStat = await stat(directory)
  if (directoryStat.uid !== owner.uid || directoryStat.gid !== owner.gid) {
    throw new Error('vmagent credentials directory owner could not be set')
  }

  const usernameFiles = []
  const passwordFiles = []
  for (const destination of writers) {
    const auth = destination.auth
    if (auth?.type !== 'basic') {
      usernameFiles.push('')
      passwordFiles.push('')
      continue
    }
    const paths = ['username', 'password'].map(field => `${destination.id}-${field}`)
    for (const [index, field] of ['username', 'password'].entries()) {
      const path = join(directory, paths[index])
      await writeFile(path, auth[field], { mode: 0o600 })
      await chown(path, owner.uid, owner.gid)
      await chmod(path, 0o600)
      const fileStat = await stat(path)
      if (fileStat.uid !== owner.uid || fileStat.gid !== owner.gid) {
        throw new Error(`vmagent credentials owner could not be set for ${destination.id}`)
      }
    }
    usernameFiles.push(join(agentDataDir, 'vmagent-credentials', paths[0]))
    passwordFiles.push(join(agentDataDir, 'vmagent-credentials', paths[1]))
  }
  return [
    ...usernameFiles.map(path => `-remoteWrite.basicAuth.usernameFile=${path}`),
    ...passwordFiles.map(path => `-remoteWrite.basicAuth.passwordFile=${path}`)
  ]
}
