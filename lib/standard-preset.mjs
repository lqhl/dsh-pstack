const STANDARD_ROW = '- id: preset-standard'
const TOP_LEVEL_ENTRY = /^-(?:\s|$)/

function splitDump(dump) {
  return String(dump).replace(/\r\n?/g, '\n').split('\n')
}

function oneIndex(lines, predicate, what, from = 0, to = lines.length) {
  const matches = []
  for (let index = from; index < to; index += 1) {
    if (predicate(lines[index])) matches.push(index)
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${what}, found ${matches.length}`)
  }
  return matches[0]
}

function pluginList(lines, start, end) {
  const config = oneIndex(lines, (line) => line === '  config:', 'top-level `  config:` field under preset-standard', start + 1, end)
  const plugins = oneIndex(lines, (line) => line === '    plugins:', '`    plugins:` list under preset-standard config', config + 1, end)

  const extracted = []
  for (let index = plugins + 1; index < end; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      if (extracted.length === 0) {
        throw new Error(`preset-standard plugins list is malformed at line ${index + 1}: blank line before the first plugin entry`)
      }
      extracted.push('')
      continue
    }
    if (!line.startsWith('      ')) break

    const entry = line.slice(6)
    const indent = line.match(/^ */)[0].length
    if (indent === 6 && !entry.startsWith('- ')) {
      throw new Error(`preset-standard plugins list is malformed at line ${index + 1}: expected an indent-6 \`- id:\` plugin entry, found ${JSON.stringify(line)}`)
    }
    if (entry.startsWith('- ')) {
      if (!/^- id: \S/.test(entry)) {
        throw new Error(`preset-standard plugins list is malformed at line ${index + 1}: expected an indent-6 \`- id:\` plugin entry`)
      }
      extracted.push(entry)
      continue
    }
    if (extracted.length === 0) {
      throw new Error(`preset-standard plugins list is malformed at line ${index + 1}: expected an indent-6 \`- id:\` plugin entry, found ${JSON.stringify(line)}`)
    }
    extracted.push(entry)
  }

  while (extracted.length > 0 && extracted.at(-1) === '') extracted.pop()
  if (extracted.length === 0) throw new Error('preset-standard has an empty plugins list')
  return extracted
}

/**
 * @param {string} dump output of `dsh --profile <name> --dump-config`
 * @returns {{ lines: string[], text: string }}
 */
export function extractStandardPlugins(dump) {
  const lines = splitDump(dump)
  const start = oneIndex(lines, (line) => line === STANDARD_ROW, `top-level \`${STANDARD_ROW}\` row`)

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (TOP_LEVEL_ENTRY.test(lines[index])) {
      end = index
      break
    }
  }

  const plugins = pluginList(lines, start, end)
  return { lines: plugins, text: plugins.join('\n') }
}
