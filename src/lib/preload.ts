import type { DocsetType } from "./docset/types"

export type PreloadItem = {
  path: string
  url: string
  docsetType: DocsetType
  content: string
}

export type PreloadDocSummary = {
  id: string
  path: string
  url: string
  docsetType: DocsetType
  title: string
  description: string
  contentFile: string
  indexFile: string
}

export type PreloadLinkIndexEntry = {
  title: string
  url: string
  description: string
  localDocId?: string
}

export type PreloadDocHeading = {
  level: number
  text: string
}

export type PreloadSuggestedDoc = {
  docId: string
  title: string
  path: string
  url: string
  contentFile: string
  indexFile: string
  overlapScore: number
  sharedTerms: number
}

export type PreloadDocIndex = {
  doc: PreloadDocSummary
  headings: PreloadDocHeading[]
  links: PreloadLinkIndexEntry[]
  suggested?: PreloadSuggestedDoc[]
}

export type PreloadSiteIndex = {
  version: 1
  generatedAt: string
  baseUrl: string
  totalDocs: number
  docs: PreloadDocSummary[]
}

export type PreloadBundle = {
  siteIndex: PreloadSiteIndex
  docIndexes: Record<string, PreloadDocIndex>
  docs: PreloadItem[]
}

export function parsePreloadPaths(input: unknown): string[] {
  if (Array.isArray(input)) {
    return dedupePaths(
      input
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    )
  }

  if (typeof input !== "string") {
    return []
  }

  const parts = input
    .split(/[\n,\r]/g)
    .map((part) => part.trim())
    .filter(Boolean)

  return dedupePaths(parts)
}

export function buildPreloadTargets(options: {
  includeBase: boolean
  maxPages: number
  paths: string[]
}): string[] {
  const normalizedMax = normalizeMaxPages(options.maxPages)
  const merged = options.includeBase ? ["", ...options.paths] : options.paths
  const deduped = dedupePaths(merged)
  return deduped.slice(0, normalizedMax)
}

export function normalizeMaxPages(input: unknown): number {
  if (typeof input !== "number" || Number.isNaN(input)) {
    return 200
  }

  return Math.max(1, Math.min(2000, Math.floor(input)))
}

export function buildPreloadBundle(baseUrl: string, items: PreloadItem[]): PreloadBundle {
  const normalizedItems = [...items].sort((a, b) => a.url.localeCompare(b.url))
  const urlToId = new Map<string, string>()
  const usedFileBases = new Set<string>()
  const summaries: PreloadDocSummary[] = normalizedItems.map((item, index) => {
    const id = `doc-${String(index + 1).padStart(5, "0")}`
    const title = extractMarkdownTitle(item.content) || humanizePath(item.path, item.url)
    const description = extractMarkdownDescription(item.content)
    const fileBase = uniqueFileBase(slugifyFileBase(title || humanizePath(item.path, item.url)), usedFileBases)
    const contentFile = `${fileBase}.md`
    const indexFile = `${fileBase}.index.json`
    const summary: PreloadDocSummary = {
      id,
      path: item.path,
      url: item.url,
      docsetType: item.docsetType,
      title,
      description,
      contentFile,
      indexFile,
    }
    urlToId.set(normalizeComparableUrl(item.url), id)
    return summary
  })

  const docIndexes: Record<string, PreloadDocIndex> = {}

  for (const summary of summaries) {
    const doc = normalizedItems.find((item) => normalizeComparableUrl(item.url) === normalizeComparableUrl(summary.url))
    if (!doc) continue

    const headings = extractMarkdownHeadings(doc.content)
    const rawLinks = extractMarkdownLinks(doc.content, doc.url)
    const dedupedLinks = dedupeLinkEntries(rawLinks).map((link) => {
      const localDocId = urlToId.get(normalizeComparableUrl(link.url))
      return {
        ...link,
        localDocId,
      }
    })

    docIndexes[summary.id] = {
      doc: summary,
      headings,
      links: dedupedLinks,
    }
  }

  return {
    siteIndex: {
      version: 1,
      generatedAt: new Date().toISOString(),
      baseUrl,
      totalDocs: summaries.length,
      docs: summaries,
    },
    docIndexes,
    docs: normalizedItems,
  }
}

export function toJsonl(bundle: PreloadBundle): string {
  const lines: string[] = []
  lines.push(JSON.stringify({ type: "site_index", data: bundle.siteIndex }))

  for (const doc of bundle.docs) {
    const summary = bundle.siteIndex.docs.find((entry) => entry.url === doc.url && entry.path === doc.path)
    lines.push(
      JSON.stringify({
        type: "doc",
        id: summary?.id,
        contentFile: summary?.contentFile,
        indexFile: summary?.indexFile,
        path: doc.path,
        url: doc.url,
        docsetType: doc.docsetType,
        content: doc.content,
      }),
    )
  }

  for (const summary of bundle.siteIndex.docs) {
    const docIndex = bundle.docIndexes[summary.id]
    if (!docIndex) continue
    lines.push(JSON.stringify({ type: "doc_index", id: summary.id, data: docIndex }))
  }

  return lines.join("\n")
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []

  for (const path of paths) {
    const normalized = normalizePath(path)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    deduped.push(normalized)
  }

  return deduped
}

function normalizePath(path: string): string {
  if (!path) return ""

  if (/^https?:\/\//i.test(path)) {
    return path
  }

  if (path.startsWith("/")) {
    return path
  }

  return `/${path}`
}

function extractMarkdownTitle(content: string): string {
  const titleMatch = content.match(/^#\s+(.+)$/m)
  if (!titleMatch) return ""
  return cleanText(titleMatch[1])
}

function extractMarkdownDescription(content: string): string {
  const lines = content.split("\n")
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("#")) continue
    if (trimmed.startsWith("---")) continue
    if (trimmed.startsWith("*[")) continue
    return cleanText(trimmed).slice(0, 280)
  }
  return ""
}

function extractMarkdownHeadings(content: string): PreloadDocHeading[] {
  const matches = Array.from(content.matchAll(/^(#{1,6})\s+(.+)$/gm))
  return matches.map((match) => ({
    level: match[1].length,
    text: cleanText(match[2]),
  }))
}

function extractMarkdownLinks(content: string, sourceUrl: string): PreloadLinkIndexEntry[] {
  const matches = Array.from(content.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g))
  const entries: PreloadLinkIndexEntry[] = []

  for (const match of matches) {
    const rawTitle = match[1].trim()
    const rawUrl = match[2].trim()
    if (!rawTitle || !rawUrl) continue

    let resolvedUrl = rawUrl
    try {
      resolvedUrl = new URL(rawUrl, sourceUrl).toString()
    } catch {
      // Keep original URL if resolving fails.
    }

    entries.push({
      title: cleanText(rawTitle),
      url: resolvedUrl,
      description: cleanText(rawTitle),
    })
  }

  return entries
}

function dedupeLinkEntries(entries: PreloadLinkIndexEntry[]): PreloadLinkIndexEntry[] {
  const seen = new Set<string>()
  const deduped: PreloadLinkIndexEntry[] = []
  for (const entry of entries) {
    const key = `${entry.url}::${entry.title}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(entry)
  }
  return deduped
}

function humanizePath(path: string, url: string): string {
  const source = path && path !== "/" ? path : new URL(url).pathname
  const part = source.split("/").filter(Boolean).pop() || "Documentation"
  return cleanText(part.replace(/[-_]/g, " "))
}

function cleanText(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeComparableUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    const asString = parsed.toString()
    return asString.endsWith("/") ? asString.slice(0, -1) : asString
  } catch {
    return url
  }
}

function slugifyFileBase(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
  return slug || "document"
}

function uniqueFileBase(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }

  let count = 2
  while (used.has(`${base}-${count}`)) {
    count += 1
  }
  const next = `${base}-${count}`
  used.add(next)
  return next
}
