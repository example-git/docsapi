import { fetchWithRateLimit, getRandomUserAgent } from "../fetch"

const SEARCH_INDEX_PATHS = [
  "search/search_index.json",
  "searchindex.json",
  "search.json",
  "search-index.json",
  "searchindex.js",
]

const SITEMAP_PATHS = ["sitemap.xml", "sitemap_index.xml"]

const NON_DOC_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".mp4",
  ".mp3",
  ".wav",
  ".css",
  ".js",
  ".map",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
])

export type DiscoverOptions = {
  includeIndexes?: boolean
  includeLinks?: boolean
  maxDiscover?: number
  maxDepth?: number
  sameHostOnly?: boolean
}

export type DiscoverResult = {
  urls: string[]
  diagnostics: {
    attempted: string[]
    fetched: string[]
    errors: Array<{ url: string; error: string }>
  }
}

export async function discoverDocumentationUrls(
  baseUrl: string,
  options: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const maxDiscover = normalizePositiveInt(options.maxDiscover, 300, 2000)
  const maxDepth = normalizePositiveInt(options.maxDepth, 2, 5)
  const includeIndexes = options.includeIndexes !== false
  const includeLinks = options.includeLinks !== false
  const sameHostOnly = options.sameHostOnly !== false

  const normalizedBase = normalizeUrl(baseUrl)
  const base = new URL(normalizedBase)

  const diagnostics: DiscoverResult["diagnostics"] = { attempted: [], fetched: [], errors: [] }
  const discovered = new Set<string>([normalizedBase])
  const seenCrawl = new Set<string>()
  const queue: Array<{ url: string; depth: number }> = [{ url: normalizedBase, depth: 0 }]

  if (includeIndexes) {
    const indexBases = buildIndexBaseCandidates(base)
    for (const indexBase of indexBases) {
      for (const path of SITEMAP_PATHS) {
        if (discovered.size >= maxDiscover) break
        const sitemapUrl = new URL(path, indexBase).toString()
        await tryDiscoverFromSitemap(sitemapUrl, base, discovered, diagnostics, maxDiscover, sameHostOnly)
      }

      for (const path of SEARCH_INDEX_PATHS) {
        if (discovered.size >= maxDiscover) break
        const indexUrl = new URL(path, indexBase).toString()
        await tryDiscoverFromSearchIndex(
          indexUrl,
          indexBase.toString(),
          base,
          discovered,
          diagnostics,
          maxDiscover,
          sameHostOnly,
        )
      }
    }
  }

  if (includeLinks) {
    while (queue.length > 0 && discovered.size < maxDiscover) {
      const current = queue.shift()
      if (!current) break
      if (current.depth > maxDepth) continue
      if (seenCrawl.has(current.url)) continue
      seenCrawl.add(current.url)

      let html: string
      try {
        diagnostics.attempted.push(current.url)
        html = await fetchText(current.url, "text/html")
        diagnostics.fetched.push(current.url)
      } catch (error) {
        diagnostics.errors.push({
          url: current.url,
          error: error instanceof Error ? error.message : "Unknown error",
        })
        continue
      }

      const links = parseLinksFromHtml(html, current.url)
      for (const link of links) {
        if (!isAllowedUrl(link, base, sameHostOnly)) continue
        if (!isLikelyDocumentationPage(link)) continue
        if (discovered.has(link)) continue
        discovered.add(link)
        if (current.depth < maxDepth) {
          queue.push({ url: link, depth: current.depth + 1 })
        }
        if (discovered.size >= maxDiscover) break
      }
    }
  }

  return {
    urls: Array.from(discovered),
    diagnostics,
  }
}

export function parseLinksFromHtml(html: string, sourceUrl: string): string[] {
  const matches = Array.from(html.matchAll(/<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi))
  const urls: string[] = []

  for (const match of matches) {
    const href = match[1].trim()
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue
    }

    try {
      const resolved = normalizeUrl(new URL(href, sourceUrl).toString())
      urls.push(resolved)
    } catch {
      // Ignore malformed URLs
    }
  }

  return dedupePreserveOrder(urls)
}

export function parseSitemapUrls(xml: string, sourceUrl: string): string[] {
  const matches = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/gi))
  const urls: string[] = []

  for (const match of matches) {
    const value = match[1].trim()
    if (!value) continue
    try {
      urls.push(normalizeUrl(new URL(value, sourceUrl).toString()))
    } catch {
      // Ignore malformed URLs
    }
  }

  return dedupePreserveOrder(urls)
}

export function parseSearchIndexUrls(raw: string, sourceUrl: string): string[] {
  const urls: string[] = []

  try {
    const json = JSON.parse(raw) as {
      docs?: Array<{ location?: string; url?: string }>
      urls?: string[]
      entries?: Array<{ href?: string; url?: string }>
    }

    for (const doc of json.docs ?? []) {
      const value = doc.location ?? doc.url
      if (!value) continue
      urls.push(resolveUrl(value, sourceUrl))
    }

    for (const value of json.urls ?? []) {
      urls.push(resolveUrl(value, sourceUrl))
    }

    for (const entry of json.entries ?? []) {
      const value = entry.href ?? entry.url
      if (!value) continue
      urls.push(resolveUrl(value, sourceUrl))
    }
  } catch {
    const match =
      raw.match(/Search\.setIndex\((\{[\s\S]*\})\)\s*;?/) ??
      raw.match(/var\s+index\s*=\s*(\{[\s\S]*\})\s*;?/)

    if (!match) return []

    try {
      const parsed = JSON.parse(match[1]) as { filenames?: string[]; docnames?: string[] }
      for (const file of parsed.filenames ?? []) {
        urls.push(resolveUrl(file, sourceUrl))
      }
      for (const docname of parsed.docnames ?? []) {
        urls.push(resolveUrl(`${docname}.html`, sourceUrl))
      }
    } catch {
      return []
    }
  }

  return dedupePreserveOrder(
    urls
      .map((url) => {
        try {
          return normalizeUrl(url)
        } catch {
          return ""
        }
      })
      .filter(Boolean),
  )
}

async function tryDiscoverFromSitemap(
  sitemapUrl: string,
  base: URL,
  discovered: Set<string>,
  diagnostics: DiscoverResult["diagnostics"],
  maxDiscover: number,
  sameHostOnly: boolean,
): Promise<void> {
  try {
    diagnostics.attempted.push(sitemapUrl)
    const xml = await fetchText(sitemapUrl, "application/xml, text/xml, text/plain")
    diagnostics.fetched.push(sitemapUrl)
    const urls = parseSitemapUrls(xml, sitemapUrl)
    for (const url of urls) {
      if (!isAllowedUrl(url, base, sameHostOnly)) continue
      if (!isLikelyDocumentationPage(url)) continue
      discovered.add(url)
      if (discovered.size >= maxDiscover) break
    }
  } catch (error) {
    diagnostics.errors.push({
      url: sitemapUrl,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

async function tryDiscoverFromSearchIndex(
  indexUrl: string,
  indexBase: string,
  base: URL,
  discovered: Set<string>,
  diagnostics: DiscoverResult["diagnostics"],
  maxDiscover: number,
  sameHostOnly: boolean,
): Promise<void> {
  try {
    diagnostics.attempted.push(indexUrl)
    const raw = await fetchText(indexUrl, "application/json, text/javascript, text/plain")
    diagnostics.fetched.push(indexUrl)
    const urls = parseSearchIndexUrls(raw, indexBase)
    for (const url of urls) {
      if (!isAllowedUrl(url, base, sameHostOnly)) continue
      if (!isLikelyDocumentationPage(url)) continue
      discovered.add(url)
      if (discovered.size >= maxDiscover) break
    }
  } catch (error) {
    diagnostics.errors.push({
      url: indexUrl,
      error: error instanceof Error ? error.message : "Unknown error",
    })
  }
}

function buildIndexBaseCandidates(base: URL): URL[] {
  const root = new URL("/", base)
  const currentDir = new URL(base.toString())
  if (!currentDir.pathname.endsWith("/")) {
    currentDir.pathname = `${currentDir.pathname}/`
  }
  return dedupePreserveOrder([currentDir.toString(), root.toString()]).map((value) => new URL(value))
}

function isAllowedUrl(url: string, base: URL, sameHostOnly: boolean): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return false
  }

  if (sameHostOnly && parsed.hostname !== base.hostname) {
    return false
  }

  return true
}

function isLikelyDocumentationPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.toLowerCase()

    for (const ext of NON_DOC_EXTENSIONS) {
      if (path.endsWith(ext)) return false
    }

    return true
  } catch {
    return false
  }
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ""
  return parsed.toString()
}

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetchWithRateLimit(url, {
    headers: {
      "User-Agent": getRandomUserAgent(),
      Accept: accept,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`)
  }

  return await response.text()
}

function resolveUrl(value: string, base: string): string {
  try {
    return new URL(value, base).toString()
  } catch {
    return value
  }
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    deduped.push(value)
  }
  return deduped
}

function normalizePositiveInt(value: unknown, defaultValue: number, maxValue: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return defaultValue
  }

  return Math.max(1, Math.min(maxValue, Math.floor(value)))
}
