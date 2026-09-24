const ROOT = '/plugins/signalk-victoriametrics-history-provider/ui'

export function webUiPrefix(serviceId, exposed) {
  return exposed ? `${ROOT}/${serviceId}` : ''
}

export function vmServiceId(destinationId) {
  return `vm-${destinationId}`
}
