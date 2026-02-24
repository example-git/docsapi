import type { LocalSitesIndexEntry } from "./preload-local"

export type LocalSiteIndexDoc = {
  id: string
  path: string
  url: string
  docsetType: string
  title: string
  description: string
  contentFile: string
  indexFile: string
}

type LocalSiteIndex = {
  baseUrl: string
  docs: LocalSiteIndexDoc[]
}

export type LocalSearchResult = {
  slug: string
  baseUrl: string
  docId: string
  title: string
  path: string
  url: string
  docsetType: string
  contentFile: string
  titleMatch: boolean
  contentMatch: boolean
  snippet: string
  score: number
}

export async function listLocalSlugs(): Promise<
  Array<{
    slug: string
    baseUrl: string
    totalDocs: number
  }>
> {
  const indexed = await readLocalSitesIndex()
  if (indexed.length > 0) {
    return indexed.map((site) => ({
      slug: site.slug,
      baseUrl: site.baseUrl,
      totalDocs: site.totalDocs,
    }))
  }

  const fs = await import("node:fs/promises")
  const path = await import("node:path")

  const localRoot = path.resolve(process.cwd(), "local")
  const entries = await fs.readdir(localRoot, { withFileTypes: true })
  const slugs: Array<{ slug: string; baseUrl: string; totalDocs: number }> = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const siteIndexPath = path.resolve(localRoot, entry.name, "site-index.json")
    if (!(await fileExists(siteIndexPath))) continue

    try {
      const raw = await fs.readFile(siteIndexPath, "utf8")
      const parsed = JSON.parse(raw) as LocalSiteIndex
      if (!parsed || !Array.isArray(parsed.docs)) continue
      slugs.push({
        slug: entry.name,
        baseUrl: parsed.baseUrl,
        totalDocs: parsed.docs.length,
      })
    } catch {
      continue
    }
  }

  slugs.sort((a, b) => a.slug.localeCompare(b.slug))
  await writeLocalSitesIndex(
    slugs.map((site) => ({
      slug: site.slug,
      baseUrl: site.baseUrl,
      totalDocs: site.totalDocs,
      updatedAt: new Date().toISOString(),
    })),
  )
  return slugs
}

export async function searchLocalDocumentation(options: {
  query: string
  slug?: string
  limit?: number
}): Promise<{
  query: string
  totalResults: number
  searchedSlugs: string[]
  results: LocalSearchResult[]
}> {
  const query = options.query.trim()
  if (!query) {
    return { query, totalResults: 0, searchedSlugs: [], results: [] }
  }

  const normalizedQuery = query.toLowerCase()
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit!))) : 50
  const targetSlugs = options.slug?.trim() ? [options.slug.trim()] : (await listLocalSlugs()).map((site) => site.slug)
  const results: LocalSearchResult[] = []

  for (const slug of targetSlugs) {
    const { siteIndex } = await loadLocalSiteIndex({ slug })
    for (const doc of siteIndex.docs) {
      const title = doc.title || ""
      const normalizedTitle = title.toLowerCase()
      const titleMatch = normalizedTitle.includes(normalizedQuery)

      const content = await readLocalDocContent(slug, doc.contentFile)
      const normalizedContent = content.toLowerCase()
      const contentIndex = normalizedContent.indexOf(normalizedQuery)
      const contentMatch = contentIndex >= 0

      if (!titleMatch && !contentMatch) continue

      const snippet = contentMatch
        ? makeSnippet(content, contentIndex, query.length)
        : `Title match: ${doc.title || doc.path || doc.url}`
      const score = computeSearchScore({
        title,
        query: normalizedQuery,
        contentIndex,
      })

      results.push({
        slug,
        baseUrl: siteIndex.baseUrl,
        docId: doc.id,
        title: doc.title,
        path: doc.path,
        url: doc.url,
        docsetType: doc.docsetType,
        contentFile: doc.contentFile,
        titleMatch,
        contentMatch,
        snippet,
        score,
      })
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.slug !== b.slug) return a.slug.localeCompare(b.slug)
    return a.title.localeCompare(b.title)
  })

  return {
    query,
    totalResults: results.length,
    searchedSlugs: targetSlugs,
    results: results.slice(0, limit),
  }
}

export async function loadLocalSiteIndex(options?: {
  slug?: string
}): Promise<{ slug: string; siteIndex: LocalSiteIndex }> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")

  const requestedSlug = options?.slug?.trim()

  if (requestedSlug) {
    const siteIndexPath = path.resolve(process.cwd(), "local", requestedSlug, "site-index.json")
    const raw = await fs.readFile(siteIndexPath, "utf8")
    const parsed = JSON.parse(raw) as LocalSiteIndex
    if (!parsed || !Array.isArray(parsed.docs)) {
      throw new Error(`Invalid site-index.json for slug ${requestedSlug}`)
    }
    return { slug: requestedSlug, siteIndex: parsed }
  }

  const latestSlug = await resolveLatestSlug()
  if (!latestSlug) {
    throw new Error("No local documentation sites found. Run /api/preload first.")
  }

  const siteIndexPath = path.resolve(process.cwd(), "local", latestSlug, "site-index.json")
  const raw = await fs.readFile(siteIndexPath, "utf8")
  const parsed = JSON.parse(raw) as LocalSiteIndex
  if (!parsed || !Array.isArray(parsed.docs)) {
    throw new Error(`Invalid site-index.json for slug ${latestSlug}`)
  }

  return { slug: latestSlug, siteIndex: parsed }
}

export async function hasLocalSlug(slug: string): Promise<boolean> {
  const slugs = await listLocalSlugs()
  return slugs.some((entry) => entry.slug === slug)
}

export async function findLocalDocByUrl(
  url: string,
): Promise<{ slug: string; siteIndex: LocalSiteIndex; doc: LocalSiteIndexDoc } | null> {
  const slugs = await listLocalSlugs()
  for (const site of slugs) {
    const { slug, siteIndex } = await loadLocalSiteIndex({ slug: site.slug })
    const { doc } = findLocalDoc(siteIndex.docs, { url })
    if (doc) {
      return { slug, siteIndex, doc }
    }
  }
  return null
}

export async function readLocalDocContent(slug: string, contentFile: string): Promise<string> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const slugDir = path.resolve(process.cwd(), "local", slug)
  const docPath = path.resolve(slugDir, contentFile)
  // Ensure the resolved path stays inside the slug directory
  if (!docPath.startsWith(slugDir + path.sep) && docPath !== slugDir) {
    throw new Error(`Invalid contentFile path: ${contentFile}`)
  }
  return fs.readFile(docPath, "utf8")
}

export function findLocalDoc(
  docs: LocalSiteIndexDoc[],
  query: {
    docId?: string
    url?: string
    path?: string
    title?: string
  },
): { doc: LocalSiteIndexDoc | null; suggestions: LocalSiteIndexDoc[] } {
  const docId = query.docId?.trim()
  const url = query.url?.trim()
  const path = query.path?.trim()
  const title = query.title?.trim()

  if (docId) {
    const match = docs.find((doc) => doc.id === docId) || null
    return { doc: match, suggestions: [] }
  }

  if (url) {
    const normalizedUrl = normalizeComparableUrl(url)
    const match =
      docs.find((doc) => normalizeComparableUrl(doc.url) === normalizedUrl) ||
      docs.find((doc) => normalizeComparableUrl(doc.path) === normalizedUrl) ||
      null
    return { doc: match, suggestions: [] }
  }

  if (path) {
    const normalizedPath = normalizeComparablePath(path)
    const match =
      docs.find((doc) => normalizeComparablePath(doc.path) === normalizedPath) ||
      docs.find((doc) => normalizeComparablePath(doc.url) === normalizedPath) ||
      null
    return { doc: match, suggestions: [] }
  }

  if (title) {
    const lowerTitle = title.toLowerCase()
    const exact = docs.find((doc) => doc.title.toLowerCase() === lowerTitle)
    if (exact) {
      return { doc: exact, suggestions: [] }
    }
    const contains = docs.filter((doc) => doc.title.toLowerCase().includes(lowerTitle))
    return {
      doc: contains[0] || null,
      suggestions: contains.slice(0, 10),
    }
  }

  return { doc: null, suggestions: docs.slice(0, 10) }
}

function normalizeComparableUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ""
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ""
    parsed.search = ""
    return parsed.toString().replace(/\/+$/, "").toLowerCase()
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase()
  }
}

function normalizeComparablePath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "/"
  try {
    const parsed = new URL(trimmed)
    return normalizePathname(parsed.pathname)
  } catch {
    return normalizePathname(trimmed)
  }
}

function normalizePathname(value: string): string {
  const ensured = value.startsWith("/") ? value : `/${value}`
  if (ensured === "/") return "/"
  return ensured.replace(/\/+$/, "").toLowerCase()
}

async function resolveLatestSlug(): Promise<string | null> {
  const indexed = await readLocalSitesIndex()
  if (indexed.length > 0) {
    return [...indexed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.slug ?? null
  }
  const scanned = await scanLocalSlugs()
  if (scanned.length > 0) {
    return scanned[0]?.slug ?? null
  }
  return null
}

async function fileExists(target: string): Promise<boolean> {
  const fs = await import("node:fs/promises")
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function readLocalSitesIndex(): Promise<LocalSitesIndexEntry[]> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const indexPath = path.resolve(process.cwd(), "local", "sites-index.json")

  try {
    const raw = await fs.readFile(indexPath, "utf8")
    const parsed = JSON.parse(raw) as { sites?: LocalSitesIndexEntry[] }
    if (!parsed || !Array.isArray(parsed.sites)) return []
    return parsed.sites
      .filter((site): site is LocalSitesIndexEntry => Boolean(site?.slug && site?.baseUrl))
      .map((site) => ({
        slug: site.slug,
        baseUrl: site.baseUrl,
        totalDocs: Number.isFinite(site.totalDocs) ? site.totalDocs : 0,
        updatedAt: site.updatedAt || new Date().toISOString(),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug))
  } catch {
    return []
  }
}

async function scanLocalSlugs(): Promise<Array<{ slug: string; baseUrl: string; totalDocs: number }>> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const localRoot = path.resolve(process.cwd(), "local")
  const entries = await fs.readdir(localRoot, { withFileTypes: true })
  const slugs: Array<{ slug: string; baseUrl: string; totalDocs: number }> = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const siteIndexPath = path.resolve(localRoot, entry.name, "site-index.json")
    if (!(await fileExists(siteIndexPath))) continue

    try {
      const raw = await fs.readFile(siteIndexPath, "utf8")
      const parsed = JSON.parse(raw) as LocalSiteIndex
      if (!parsed || !Array.isArray(parsed.docs)) continue
      slugs.push({
        slug: entry.name,
        baseUrl: parsed.baseUrl,
        totalDocs: parsed.docs.length,
      })
    } catch {
      continue
    }
  }

  slugs.sort((a, b) => a.slug.localeCompare(b.slug))
  return slugs
}

async function writeLocalSitesIndex(sites: LocalSitesIndexEntry[]): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const indexPath = path.resolve(process.cwd(), "local", "sites-index.json")
  const payload = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    sites: sites.sort((a, b) => a.slug.localeCompare(b.slug)),
  }
  await fs.writeFile(indexPath, JSON.stringify(payload, null, 2), "utf8")
}

function makeSnippet(content: string, index: number, queryLength: number): string {
  const radius = 110
  const start = Math.max(0, index - radius)
  const end = Math.min(content.length, index + queryLength + radius)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < content.length ? "..." : ""
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`
}

function computeSearchScore(input: { title: string; query: string; contentIndex: number }): number {
  const normalizedTitle = input.title.toLowerCase()
  let score = 0
  if (normalizedTitle === input.query) score += 120
  if (normalizedTitle.startsWith(input.query)) score += 80
  if (normalizedTitle.includes(input.query)) score += 40
  if (input.contentIndex >= 0) {
    score += 20
    score += Math.max(0, 20 - Math.floor(input.contentIndex / 400))
  }
  return score
}
