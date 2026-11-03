// Shared DOI/PMID lookup and key generation.
export const KEEP = new Set(['type', 'title', 'container-title', 'container-title-short', 'volume', 'issue', 'page',
  'DOI', 'PMID', 'PMCID', 'URL', 'ISSN', 'publisher', 'author', 'editor', 'issued', 'abstract'])

async function getJSON(url, accept = 'application/json') {
  const r = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': 'zotlet/0.1 (https://github.com; mailto:local@zotlet)'
    },
    redirect: 'follow'
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`HTTP ${r.status} from ${url}${text ? ': ' + text.slice(0, 120) : ''}`)
  }
  return r.json()
}

export async function fetchItem(ident) {
  let d
  const raw = String(ident || '').trim()
  if (!raw) throw new Error('Empty identifier')

  if (/^(pmid:?\s*)?\d+$/i.test(raw)) {
    const pmid = raw.replace(/\D/g, '')
    d = await getJSON(`https://api.ncbi.nlm.nih.gov/lit/ctxp/v1/pubmed/?format=csl&id=${pmid}`, '*/*')
    if (d.DOI) {
      try { d = await getJSON(`https://doi.org/${encodeURIComponent(d.DOI)}`, 'application/vnd.citationstyles.csl+json') } catch {}
    }
    d.PMID = pmid
  } else {
    let doi = raw.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/i, '').trim()
    if (!doi.startsWith('10.')) throw new Error(`Not a valid DOI or PMID: ${raw}`)
    d = await getJSON(`https://doi.org/${encodeURIComponent(doi)}`, 'application/vnd.citationstyles.csl+json')
  }

  d = Object.fromEntries(Object.entries(d).filter(([k]) => KEEP.has(k)))
  for (const k of ['title', 'container-title', 'container-title-short', 'ISSN']) {
    if (Array.isArray(d[k])) d[k] = d[k][0] || ''
  }
  // Normalize author/editor to only family/given/literal strings (drop sequence, affiliation, role, etc.)
  function cleanName(name) {
    if (!name || typeof name !== 'object') return null
    const clean = {}
    for (const k of ['family', 'given', 'literal']) {
      if (typeof name[k] === 'string' && name[k].trim()) clean[k] = name[k].trim()
    }
    if (!clean.family && !clean.literal) {
      const any = Object.values(name).find(v => typeof v === 'string' && v.trim() && v.length < 80)
      if (any) clean.literal = any.trim()
    }
    return (clean.family || clean.literal) ? clean : null
  }
  for (const role of ['author', 'editor']) {
    if (!Array.isArray(d[role])) continue
    d[role] = d[role].map(cleanName).filter(Boolean)
    if (!d[role].length) delete d[role]
  }

  if (!d.title) throw new Error('Lookup succeeded but no title was returned')
  return d
}

export function mkkey(it, lib) {
  const a = (it.author || [{}])[0] || {}
  const fam = (a.family || a.literal || 'anon').toLowerCase().replace(/[^a-z]/g, '')
  const base = fam + (it.issued?.['date-parts']?.[0]?.[0] ?? '')
  const used = new Set(lib.map((i) => i.id))
  let k = base
  for (let n = 0; used.has(k); n++) k = base + 'abcdefghijklmnopqrstuvwxyz'[n]
  return k
}
