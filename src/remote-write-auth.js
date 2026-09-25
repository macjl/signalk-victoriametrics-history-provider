import { chmod, chown, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

export async function remoteWriteAuthArgs(destinations, dataDir, agentDataDir, containerPaths = false) {
  const writers = destinations.filter(destination => destination.write?.enabled)
  const hasBasic = writers.some(destination => destination.auth?.type === 'basic')
  const hasBearer = writers.some(destination => destination.auth?.type === 'bearer')
  if (!hasBasic && !hasBearer) return []

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
  const tokenFiles = []
  for (const destination of writers) {
    const auth = destination.auth
    const paths = { username: '', password: '', token: '' }
    const fields = auth?.type === 'basic' ? ['username', 'password'] : auth?.type === 'bearer' ? ['token'] : []
    for (const field of fields) {
      const name = `${destination.id}-${field}`
      const path = join(directory, name)
      await writeFile(path, auth[field], { mode: 0o600 })
      await chown(path, owner.uid, owner.gid)
      await chmod(path, 0o600)
      const fileStat = await stat(path)
      if (fileStat.uid !== owner.uid || fileStat.gid !== owner.gid) {
        throw new Error(`vmagent credentials owner could not be set for ${destination.id}`)
      }
      const agentJoin = containerPaths ? posix.join : join
      paths[field] = agentJoin(agentDataDir, 'vmagent-credentials', name)
    }
    usernameFiles.push(paths.username)
    passwordFiles.push(paths.password)
    tokenFiles.push(paths.token)
  }
  return [
    ...(hasBasic ? usernameFiles.map(path => `-remoteWrite.basicAuth.usernameFile=${path}`) : []),
    ...(hasBasic ? passwordFiles.map(path => `-remoteWrite.basicAuth.passwordFile=${path}`) : []),
    ...(hasBearer ? tokenFiles.map(path => `-remoteWrite.bearerTokenFile=${path}`) : [])
  ]
}
