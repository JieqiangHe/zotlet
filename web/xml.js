// Small XML reader for local CSL metadata validation, not a complete CSL schema validator.
import { createHash } from 'node:crypto'
export const CSL_NS = 'http://purl.org/net/xbiblio/csl'
const decode = (value) => value.replace(/&([^;]+);/g, (_, name) => {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  if (Object.hasOwn(named, name)) return named[name]
  if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16))
  if (/^#\d+$/.test(name)) return String.fromCodePoint(+name.slice(1))
  throw new Error('Unsupported XML entity')
})
export function parseXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1024 * 1024) throw new Error('CSL must be text smaller than 1 MiB')
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD and external entities are not supported')
  const root = { children: [], ns: { xml: 'http://www.w3.org/XML/1998/namespace' } }, stack = [root]
  const pattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^<>"']|"[^"]*"|'[^']*')+>|[^<]+/g
  let offset = 0
  for (const match of xml.matchAll(pattern)) {
    if (match.index !== offset) throw new Error('Malformed XML')
    const token = match[0], parent = stack.at(-1); offset += token.length
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (token.startsWith('<![CDATA[')) { parent.children.push(token.slice(9, -3)); continue }
    if (!token.startsWith('<')) { if (/&(?![\w#]+;)/.test(token)) throw new Error('Malformed XML entity'); parent.children.push(decode(token)); continue }
    if (token.startsWith('</')) {
      if (stack.length === 1 || token.slice(2, -1).trim() !== parent.name) throw new Error('Unbalanced XML')
      parent.closeStart = match.index; parent.end = offset; stack.pop(); continue
    }
    const tag = /^<([\w:.-]+)([\s\S]*?)(\/?)>$/.exec(token)
    if (!tag) throw new Error('Unsupported XML tag')
    const attrs = {}, ns = { ...parent.ns }, regex = /\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g
    let end = 0
    for (const attr of tag[2].matchAll(regex)) {
      if (attr.index !== end || Object.hasOwn(attrs, attr[1])) throw new Error('Malformed or duplicate XML attribute')
      end += attr[0].length; attrs[attr[1]] = decode(attr[2] ?? attr[3])
      if (attr[1] === 'xmlns') ns[''] = attrs[attr[1]]
      else if (attr[1].startsWith('xmlns:')) ns[attr[1].slice(6)] = attrs[attr[1]]
    }
    if (tag[2].slice(end).trim()) throw new Error('Malformed XML attribute')
    const parts = tag[1].split(':'), local = parts.at(-1), uri = ns[parts.length === 1 ? '' : parts[0]]
    if (parts.length > 2 || (parts.length === 2 && !uri)) throw new Error('Unknown XML namespace')
    const node = { name: tag[1], local, uri, attrs, ns, children: [], start: match.index, openEnd: offset, end: offset }
    parent.children.push(node)
    if (!tag[3]) { if (stack.length > 200) throw new Error('XML is too deeply nested'); stack.push(node) }
  }
  if (offset !== xml.length || stack.length !== 1) throw new Error('Incomplete XML')
  const elements = root.children.filter((x) => typeof x !== 'string')
  if (elements.length !== 1 || root.children.some((x) => typeof x === 'string' && x.trim())) throw new Error('Expected one XML root')
  return elements[0]
}
const child = (node, name) => node.children.find((n) => typeof n !== 'string' && n.local === name && n.uri === CSL_NS)
const text = (node) => !node ? '' : typeof node === 'string' ? node : node.children.map(text).join('')
export function describeStyle(xml) {
  const root = parseXml(xml), info = child(root, 'info')
  if (root.local !== 'style' || root.uri !== CSL_NS) throw new Error('Expected a CSL style with the standard namespace')
  if (root.attrs.version !== '1.0') throw new Error('Use a CSL 1.0-compatible style')
  const title = text(child(info || { children: [] }, 'title')).trim(), url = text(child(info || { children: [] }, 'id')).trim()
  let validURI = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(url)
  try { validURI ||= !!new URL(url).protocol } catch {}
  if (!title || title.length > 200) throw new Error('A style title of 1–200 characters is required')
  if (!validURI || url.length > 4000 || /\s/.test(url)) throw new Error('The CSL style ID must be an absolute URI or UUID')
  const id = /^http:\/\/www\.zotero\.org\/styles\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})$/.exec(url)?.[1]
    || `custom-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`
  const parent = info?.children.find((node) => typeof node !== 'string' && node.local === 'link' && node.uri === CSL_NS && node.attrs.rel === 'independent-parent')?.attrs.href
  return { id, title, uri: url, parent: parent || null, root, info }
}
export function styleMetadata(xml) {
  const { root, id, title, uri } = describeStyle(xml)
  if (root.attrs.class !== 'in-text') throw new Error('Only independent in-text styles are supported by the current editor workflow')
  if (!child(child(root, 'citation') || { children: [] }, 'layout') || !child(child(root, 'bibliography') || { children: [] }, 'layout')) throw new Error('Import an independent style containing citation and bibliography layouts')
  return { id, title, uri }
}
export function resolveAlias(aliasXML, parentXML) {
  const alias = describeStyle(aliasXML), parent = describeStyle(parentXML)
  styleMetadata(parentXML)
  if (!alias.parent || alias.parent !== parent.uri) throw new Error('The parent style does not match this alias')
  const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const changes = []
  for (const [name, value] of [['title', alias.title], ['id', alias.uri]]) {
    const node = child(parent.info, name)
    changes.push({ start: node.openEnd, end: node.closeStart, value: escape(value) })
  }
  for (const node of parent.info.children.filter((node) => typeof node !== 'string' && node.local === 'link' && node.attrs.rel === 'self')) {
    changes.push({ start: node.start, end: node.end, value: `<${node.name} href="${escape(alias.uri)}" rel="self"/>` })
  }
  if (alias.root.attrs['default-locale']) {
    const opening = parentXML.slice(parent.root.start, parent.root.openEnd), locale = escape(alias.root.attrs['default-locale'])
    changes.push({ start: parent.root.start, end: parent.root.openEnd,
      value: /\sdefault-locale\s*=/.test(opening) ? opening.replace(/\sdefault-locale\s*=\s*(?:"[^"]*"|'[^']*')/, ` default-locale="${locale}"`) : opening.replace(/>$/, ` default-locale="${locale}">`) })
  }
  let xml = parentXML
  for (const change of changes.sort((a, b) => b.start - a.start)) xml = xml.slice(0, change.start) + change.value + xml.slice(change.end)
  // Preserve the original alias's attribution/license metadata as well as the parent's.
  xml += `\n<!-- Resolved dependent style, original source follows:\n${aliasXML.replace(/--/g, '- -')}\n-->\n`
  styleMetadata(xml)
  return xml
}
