import { fetchWithRateLimit, getRandomUserAgent } from "../fetch"
import type { DocsetType } from "./types"

const searchIndexPaths = [
  "search/search_index.json",
  "searchindex.json",
  "search.json",
  "search-index.json",
  "searchindex.js",
]

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    throw new Error("baseUrl is required")
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  const parsed = new URL(withScheme)
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }
  return parsed.toString()
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

function toAbsoluteUrl(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRateLimit(url, {
    headers: {
      "User-Agent": getRandomUserAgent(),
      Accept: "application/json, text/plain, text/html",
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch search index: ${response.status} ${response.statusText}`)
  }

  return await response.text()
}

function parseMkDocsIndex(raw: string, baseUrl: string, query: string) {
  const data = JSON.parse(raw) as {
    docs?: Array<{ title?: string; text?: string; location?: string }>
  }
  const docs = data.docs ?? []
  return docs
    .filter((doc) => {
      const title = doc.title?.toLowerCase() ?? ""
      const text = doc.text?.toLowerCase() ?? ""
      return title.includes(query) || text.includes(query)
    })
    .map((doc) => ({
      title: doc.title ?? "Untitled",
      url: doc.location ? toAbsoluteUrl(baseUrl, doc.location) : baseUrl,
      snippet: doc.text?.slice(0, 200) ?? "",
      source: "mkdocs",
    }))
}

function parseSphinxIndex(raw: string, baseUrl: string, query: string) {
  const match = raw.match(/Search\.setIndex\((\{[\s\S]*\})\);/)
  if (!match) {
    return []
  }

  const json = match[1]
  const data = JSON.parse(json) as {
    docnames?: string[]
    titles?: string[]
  }

  const docnames = data.docnames ?? []
  const titles = data.titles ?? []

  return titles
    .map((title, index) => ({
      title,
      url: toAbsoluteUrl(baseUrl, `${docnames[index]}.html`),
    }))
    .filter((entry) => entry.title.toLowerCase().includes(query))
    .map((entry) => ({
      title: entry.title,
      url: entry.url,
      snippet: "",
      source: "sphinx",
    }))
}

function parseSitemap(raw: string, baseUrl: string, query: string) {
  const matches = Array.from(raw.matchAll(/<loc>([^<]+)<\/loc>/gi))
  return matches
    .map((match) => match[1])
    .filter((loc) => loc.toLowerCase().includes(query))
    .map((loc) => ({
      title: loc.split("/").pop() || loc,
      url: toAbsoluteUrl(baseUrl, loc),
      snippet: "",
      source: "sitemap",
    }))
}

export async function searchDocumentation(
  baseUrl: string,
  query: string,
  docsetType?: DocsetType,
): Promise<
  Array<{
    title: string
    url: string
    snippet: string
    source: string
  }>
> {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery) {
    return []
  }

  for (const path of searchIndexPaths) {
    try {
      const indexUrl = toAbsoluteUrl(normalizedBase, path)
      const raw = await fetchText(indexUrl)
      if (path.endsWith(".json") && (docsetType === "mkdocs" || docsetType === undefined)) {
        const results = parseMkDocsIndex(raw, normalizedBase, normalizedQuery)
        if (results.length) {
          return results
        }
      }
      if (path.endsWith(".js") && (docsetType === "sphinx" || docsetType === undefined)) {
        const results = parseSphinxIndex(raw, normalizedBase, normalizedQuery)
        if (results.length) {
          return results
        }
      }
    } catch {
      continue
    }
  }

  try {
    const sitemap = await fetchText(toAbsoluteUrl(normalizedBase, "sitemap.xml"))
    const results = parseSitemap(sitemap, normalizedBase, normalizedQuery)
    if (results.length) {
      return results
    }
  } catch {
    return []
  }

  return []
}
