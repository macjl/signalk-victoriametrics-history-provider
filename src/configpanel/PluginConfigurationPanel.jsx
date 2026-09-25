import React, { useState } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { ActionStatus, Button, panelStyles } from 'signalk-container-helper/ui'
import { bytesToGiB, destinationUsage, giBToBytes, initialConfig, nextDestinationId, prepareSave, selectKind, selectMode, setDestinationUsage } from './model.js'

const styles = {
  root: { ...panelStyles.root, maxWidth: 980, padding: '8px 0 28px', color: '#263238' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: '1px solid #d8e0e3', marginBottom: 22 },
  tab: { border: 0, background: 'transparent', padding: '10px 16px', fontSize: 14, cursor: 'pointer', color: '#52646b' },
  activeTab: { borderBottom: '3px solid #167d70', color: '#125c53', fontWeight: 600 },
  heading: { fontSize: 17, fontWeight: 600, margin: '0 0 16px' },
  section: { padding: '0 0 22px', marginBottom: 22, borderBottom: '1px solid #e1e6e8' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 245px), 1fr))', gap: '16px 20px' },
  field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
  label: { fontSize: 13, fontWeight: 600, color: '#34464d' },
  hint: { fontSize: 12, color: '#687b82', lineHeight: 1.4 },
  input: { ...panelStyles.input, boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0, borderRadius: 4 },
  textarea: { ...panelStyles.input, boxSizing: 'border-box', width: '100%', maxWidth: '100%', minHeight: 92, resize: 'vertical', borderRadius: 4 },
  details: { marginTop: 18 },
  summary: { cursor: 'pointer', color: '#176b62', fontSize: 13, fontWeight: 600, marginBottom: 14 },
  destination: { border: '1px solid #d7e0e2', borderRadius: 6, padding: 16, marginBottom: 12, background: '#fff' },
  destinationHeader: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 15 },
  destinationTitle: { fontSize: 15, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
  iconButton: { border: '1px solid #d7e0e2', background: '#fff', borderRadius: 4, width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#9e3737' },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  footer: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 22 }
}

function Field({ label, hint, children }) {
  return <label style={styles.field}>
    <span style={styles.label}>{label}</span>
    {children}
    {hint && <span style={styles.hint}>{hint}</span>}
  </label>
}

function NumberField({ label, value, onChange, min = 0, max, step = 1, hint }) {
  return <Field label={label} hint={hint}>
    <input style={styles.input} type="number" min={min} max={max} step={step} value={value ?? ''} onChange={event => onChange(Number(event.target.value))} />
  </Field>
}

function AuthenticationFields({ auth, onChange }) {
  return <>
    <Field label="Authentication" hint="Shared by Remote Write and History. Use HTTPS for remote servers.">
      <select style={styles.input} value={auth?.type ?? 'none'} onChange={event => onChange(event.target.value === 'basic'
        ? { type: 'basic', username: '', password: '' }
        : event.target.value === 'bearer' ? { type: 'bearer', token: '' } : undefined)}>
        <option value="none">None</option>
        <option value="basic">Basic Auth</option>
        <option value="bearer">Bearer token</option>
      </select>
    </Field>
    {auth?.type === 'basic' && <>
      <Field label="Username"><input style={styles.input} value={auth.username ?? ''}
        autoComplete="off" onChange={event => onChange({ ...auth, username: event.target.value })} /></Field>
      <Field label="Password"><input style={styles.input} type="password" value={auth.password ?? ''}
        autoComplete="new-password" onChange={event => onChange({ ...auth, password: event.target.value })} /></Field>
    </>}
    {auth?.type === 'bearer' && <Field label="Token" hint="Enter the token only, without the Bearer prefix.">
      <input style={styles.input} type="password" value={auth.token ?? ''}
        autoComplete="new-password" onChange={event => onChange({ ...auth, token: event.target.value })} />
    </Field>}
  </>
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const [config, setConfig] = useState(() => initialConfig(configuration))
  const [tab, setTab] = useState('ingest')
  const [pathsText, setPathsText] = useState(() => (configuration?.ingest?.paths ?? []).join('\n'))
  const [alertPathsText, setAlertPathsText] = useState(() => (configuration?.ingest?.cardinalityAlert?.excludedPaths ?? []).join('\n'))
  const [labelRows, setLabelRows] = useState(() => Object.entries(configuration?.ingest?.labels ?? {})
    .filter(([name]) => name !== 'job' && name !== 'instance')
    .map(([name, value]) => ({ name, value })))
  const [feedback, setFeedback] = useState({ message: '', error: false })
  const [saving, setSaving] = useState(false)

  const ingest = config.ingest
  const vmagent = config.vmagent
  const destinations = config.destinations
  const readerIndex = destinations.findIndex(destination => destination.read?.enabled)
  const writing = destinations.some(destination => destination.write?.enabled)

  function updateIngest(patch) {
    setConfig(current => ({ ...current, ingest: { ...current.ingest, ...patch } }))
  }

  function updateVmagent(patch) {
    setConfig(current => ({ ...current, vmagent: { ...current.vmagent, ...patch } }))
  }

  function updateDestination(index, patch) {
    setConfig(current => ({ ...current, destinations: current.destinations.map((destination, currentIndex) =>
      currentIndex === index ? { ...destination, ...patch } : destination) }))
  }

  function updateDestinationPart(index, part, patch) {
    setConfig(current => ({ ...current, destinations: current.destinations.map((destination, currentIndex) =>
      currentIndex === index ? { ...destination, [part]: { ...destination[part], ...patch } } : destination) }))
  }

  function setLabelRow(index, patch) {
    setLabelRows(rows => rows.map((row, current) => current === index ? { ...row, ...patch } : row))
  }

  async function handleSave() {
    try {
      const result = prepareSave(config, labelRows)
      setSaving(true)
      setFeedback({ message: '', error: false })
      await Promise.resolve(save(result))
      setConfig(result)
      setFeedback({ message: 'Configuration saved.', error: false })
    } catch (error) {
      setFeedback({ message: error.message, error: true })
    } finally {
      setSaving(false)
    }
  }

  return <div style={styles.root}>
    <div style={styles.tabs} role="tablist" aria-label="Configuration sections">
      {[
        ['ingest', 'Ingestion'],
        ...(writing ? [['vmagent', 'vmagent']] : []),
        ['destinations', `Destinations (${destinations.length})`]
      ].map(([key, title]) => <button key={key} type="button" role="tab" aria-selected={tab === key}
        style={{ ...styles.tab, ...(tab === key ? styles.activeTab : {}) }} onClick={() => setTab(key)}>{title}</button>)}
    </div>

    {tab === 'ingest' && <div role="tabpanel">
        <section style={styles.section}>
          <h2 style={styles.heading}>Selection</h2>
          <div style={styles.grid}>
            <Field label="Contexts">
              <select style={styles.input} value={ingest.contexts} onChange={event => updateIngest({ contexts: event.target.value })}>
                <option value="self">Own vessel</option><option value="all">All contexts</option>
              </select>
            </Field>
            {writing && <Field label="Sources" hint="Preferred follows Signal K priorities. All records each source separately.">
              <select style={styles.input} value={ingest.sourcePolicy} onChange={event => updateIngest({ sourcePolicy: event.target.value })}>
                <option value="preferred">Preferred</option><option value="all">All sources</option>
              </select>
            </Field>}
          </div>
          {writing && <details style={styles.details} defaultOpen={ingest.filterMode !== 'none' && ingest.paths.length > 0}>
            <summary style={styles.summary}>Advanced path filtering: {ingest.filterMode === 'none' ? 'None' :
              `${ingest.filterMode === 'blacklist' ? 'Exclude' : 'Include'} ${ingest.paths.length} path${ingest.paths.length === 1 ? '' : 's'}`}</summary>
            <div style={styles.grid}>
              <Field label="Path filter">
                <select style={styles.input} value={ingest.filterMode} onChange={event => updateIngest({ filterMode: event.target.value })}>
                  <option value="none">None</option>
                  <option value="blacklist">Exclude listed paths</option>
                  <option value="whitelist">Include listed paths only</option>
                </select>
              </Field>
            </div>
            {ingest.filterMode !== 'none' && <div style={{ marginTop: 16 }}>
              <Field label="Signal K paths" hint="One path per line. An empty exclude list includes all paths.">
                <textarea style={styles.textarea} value={pathsText} onChange={event => {
                  setPathsText(event.target.value)
                  updateIngest({ paths: event.target.value.split('\n').map(path => path.trim()).filter(Boolean) })
                }} />
              </Field>
            </div>}
          </details>}
          <details style={styles.details}>
            <summary style={styles.summary}>Advanced frequency and batching</summary>
            <div style={styles.grid}>
              <NumberField label="Sampling period (ms)" min={1} value={ingest.periodMs} onChange={periodMs => updateIngest({ periodMs })} hint="Last update per context, source and path in each period." />
              <NumberField label="Samples per batch" min={1} value={ingest.batch.maxSamples} onChange={maxSamples => updateIngest({ batch: { ...ingest.batch, maxSamples } })} />
              <NumberField label="Flush interval (ms)" min={1} value={ingest.batch.flushMs} onChange={flushMs => updateIngest({ batch: { ...ingest.batch, flushMs } })} />
              <NumberField label="Maximum pending samples" min={1} value={ingest.batch.maxPendingSamples} onChange={maxPendingSamples => updateIngest({ batch: { ...ingest.batch, maxPendingSamples } })} />
            </div>
          </details>
          {writing && <details style={styles.details}>
            <summary style={styles.summary}>Advanced cardinality alert</summary>
            <div style={styles.grid}>
              <NumberField label="Series per path per UTC day" min={2} max={250}
                value={ingest.cardinalityAlert.maxSeriesPerPathPerDay}
                onChange={maxSeriesPerPathPerDay => updateIngest({ cardinalityAlert: { ...ingest.cardinalityAlert, maxSeriesPerPathPerDay } })}
                hint="Warning only. Ingestion continues." />
            </div>
            <div style={{ marginTop: 16 }}>
              <Field label="Paths exempt from cardinality alerts" hint="One Signal K path per line. This does not exclude any data from ingestion.">
                <textarea style={styles.textarea} value={alertPathsText} onChange={event => {
                  setAlertPathsText(event.target.value)
                  updateIngest({ cardinalityAlert: { ...ingest.cardinalityAlert,
                    excludedPaths: event.target.value.split('\n').map(path => path.trim()).filter(Boolean) } })
                }} />
              </Field>
            </div>
          </details>}
        </section>
        <section style={styles.section}>
          <h2 style={styles.heading}>Metric identity</h2>
          <div style={styles.grid}>
            <Field label="Job"><input style={styles.input} value={ingest.labels.job ?? ''}
              onChange={event => updateIngest({ labels: { ...ingest.labels, job: event.target.value } })} /></Field>
            <Field label="Instance"><input style={styles.input} value={ingest.labels.instance ?? ''}
              onChange={event => updateIngest({ labels: { ...ingest.labels, instance: event.target.value } })} /></Field>
          </div>
          <h3 style={{ ...styles.label, margin: '20px 0 10px' }}>Additional labels</h3>
          {labelRows.map((row, index) => <div key={index} style={styles.row}>
            <input style={{ ...styles.input, flex: 1 }} aria-label={`Label ${index + 1} name`} placeholder="Name" value={row.name} onChange={event => setLabelRow(index, { name: event.target.value })} />
            <input style={{ ...styles.input, flex: 2 }} aria-label={`Label ${index + 1} value`} placeholder="Value" value={row.value} onChange={event => setLabelRow(index, { value: event.target.value })} />
            <button type="button" style={styles.iconButton} title="Remove label" aria-label={`Remove label ${index + 1}`} onClick={() => setLabelRows(rows => rows.filter((_, current) => current !== index))}><Trash2 size={16} /></button>
          </div>)}
          <Button variant="secondary" small onClick={() => setLabelRows(rows => [...rows, { name: '', value: '' }])}><Plus size={16} /> Add label</Button>
        </section>
    </div>}

    {tab === 'vmagent' && writing && <div role="tabpanel">
        <section style={styles.section}>
          <h2 style={styles.heading}>vmagent runtime</h2>
          <div style={styles.grid}>
            <Field label="Mode">
              <select style={styles.input} value={vmagent.mode} onChange={event => updateVmagent({ mode: event.target.value })}>
                <option value="managed-container">Managed container</option>
                <option value="host-binary">Host binary</option>
              </select>
            </Field>
            {vmagent.mode === 'host-binary' && <Field label="Binary path"><input style={styles.input} value={vmagent.binaryPath ?? ''} onChange={event => updateVmagent({ binaryPath: event.target.value })} placeholder="/usr/local/bin/vmagent" /></Field>}
            <NumberField label="Disk queue limit per destination (GiB)" step="any"
              value={bytesToGiB(vmagent.queueLimitBytesPerDestination)}
              onChange={gib => updateVmagent({ queueLimitBytesPerDestination: giBToBytes(gib) })} />
          </div>
          <label style={{ ...styles.row, marginTop: 18 }}>
            <input type="checkbox" checked={vmagent.exposeWebUi ?? false}
              onChange={event => updateVmagent({ exposeWebUi: event.target.checked })} />
            Expose vmagent web interface to Signal K administrators
          </label>
        </section>
    </div>}

    {tab === 'destinations' && <div role="tabpanel">
      <section style={styles.section}>
        <h2 style={styles.heading}>Destinations</h2>
        {destinations.map((destination, index) => <div key={index} style={styles.destination}>
          <div style={styles.destinationHeader}>
            <strong style={styles.destinationTitle}>{destination.id || `Destination ${index + 1}`}</strong>
            <button type="button" style={styles.iconButton} title="Remove destination" aria-label={`Remove destination ${destination.id || index + 1}`}
              onClick={() => setConfig(current => ({ ...current, destinations: current.destinations.filter((_, currentIndex) => currentIndex !== index) }))}><Trash2 size={16} /></button>
          </div>
          <div style={styles.grid}>
            <Field label="ID"><input style={styles.input} value={destination.id ?? ''} onChange={event => updateDestination(index, { id: event.target.value })} /></Field>
            <Field label="Type">
              <select style={styles.input} value={destination.kind} onChange={event => updateDestination(index, selectKind(destination, event.target.value))}>
                <option value="victoriametrics">VictoriaMetrics</option>
                <option value="prometheus-compatible">Prometheus-compatible</option>
              </select>
            </Field>
            {destination.kind === 'victoriametrics' && <Field label="Mode">
              <select style={styles.input} value={destination.mode} onChange={event => updateDestination(index, selectMode(destination, event.target.value))}>
                <option value="managed-container">Managed container</option>
                <option value="remote">Remote instance</option>
                {destination.mode === 'host-binary' && <option value="host-binary" disabled>Host binary (unsupported)</option>}
              </select>
            </Field>}
            {destination.mode === 'managed-container' && <>
              <Field label="Retention" hint="Empty: no planned expiry (VictoriaMetrics receives 100y)."><input style={styles.input} value={destination.retention ?? '30d'} onChange={event => updateDestination(index, { retention: event.target.value })} /></Field>
            </>}
          </div>
          {destination.mode === 'managed-container' && <label style={{ ...styles.row, marginTop: 14 }}>
            <input type="checkbox" checked={destination.exposeWebUi ?? false}
              onChange={event => updateDestination(index, { exposeWebUi: event.target.checked })} />
            Expose this VictoriaMetrics web interface to Signal K administrators
          </label>}
          <div style={{ ...styles.grid, marginTop: 14 }}>
            <Field label="Usage">
              {destination.kind === 'victoriametrics' ? <select style={styles.input} value={destinationUsage(destination)}
                onChange={event => setConfig(current => ({ ...current, destinations: setDestinationUsage(current.destinations, index, event.target.value) }))}>
                {destinationUsage(destination) === 'none' && <option value="none" disabled>Select usage</option>}
                <option value="write">Write only</option>
                <option value="read" disabled={readerIndex !== -1 && readerIndex !== index}>History only</option>
                <option value="both" disabled={readerIndex !== -1 && readerIndex !== index}>Write and History</option>
              </select> : <select style={styles.input} value={destinationUsage(destination) === 'write' ? 'write' : 'invalid'}
                onChange={() => setConfig(current => ({ ...current, destinations: setDestinationUsage(current.destinations, index, 'write') }))}>
                {destinationUsage(destination) !== 'write' && <option value="invalid" disabled>Select usage</option>}
                <option value="write">Write only</option>
              </select>}
            </Field>
            {destination.kind === 'victoriametrics' && destination.mode === 'remote' && <Field label="VictoriaMetrics base URL"><input style={styles.input} type="url" value={destination.url ?? ''} onChange={event => updateDestination(index, { url: event.target.value })} placeholder="https://host:8428" /></Field>}
            {destination.kind === 'prometheus-compatible' && destination.mode === 'remote' && <Field label="Remote Write URL"><input style={styles.input} type="url" value={destination.write?.url ?? ''} onChange={event => updateDestinationPart(index, 'write', { url: event.target.value })} placeholder="https://host/api/v1/write" /></Field>}
            {destination.mode === 'remote' && <AuthenticationFields auth={destination.auth}
              onChange={auth => updateDestination(index, { auth })} />}
          </div>
          {destination.read?.enabled && <details style={styles.details}>
            <summary style={styles.summary}>History query limits</summary>
            <div style={styles.grid}>
              {[
                ['maxRangeDays', 'Maximum range (days)', 30],
                ['maxSeries', 'Maximum series per path', 500],
                ['maxSamples', 'Maximum raw samples per path', 200000],
                ['maxResponseBytes', 'Maximum response (bytes)', 33554432],
                ['timeoutMs', 'Timeout (ms)', 15000]
              ].map(([key, label, defaultValue]) => <NumberField key={key} label={label} min={1}
                value={destination.read?.limits?.[key] ?? defaultValue}
                onChange={value => updateDestinationPart(index, 'read', { limits: { ...destination.read?.limits, [key]: value } })} />)}
            </div>
          </details>}
        </div>)}
        <Button variant="secondary" onClick={() => setConfig(current => ({ ...current, destinations: [...current.destinations, {
          id: nextDestinationId(current.destinations), kind: 'victoriametrics', mode: 'managed-container',
          retention: '30d', write: { enabled: true }, read: { enabled: false }
        }] }))}><Plus size={16} /> Add destination</Button>
      </section>
    </div>}

    <div style={styles.footer}>
      <Button onClick={handleSave} busy={saving} busyLabel="Saving..."><Save size={16} /> Save configuration</Button>
      <ActionStatus message={feedback.message} error={feedback.error} style={{ marginTop: 0 }} />
    </div>
  </div>
}
