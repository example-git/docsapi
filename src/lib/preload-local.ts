import type { PreloadBundle, PreloadDocIndex, PreloadDocSummary, PreloadItem } from "./preload"

export type LocalWriteResult = {
  enabled: boolean
  directory: string
  writtenDocs: number
  writtenIndexes: number
  siteIndexFile: string
  docsJsonDir: string
  jsonlFile: string
  errors: string[]
}

export type LocalSitesIndexEntry = {
  slug: string
  baseUrl: string
  totalDocs: number
  updatedAt: string
}

type LocalSitesIndex = {
  version: 1
  generatedAt: string
  sites: LocalSitesIndexEntry[]
}

type LocalWriteSession = {
  rootDir: string
  docsJsonDir: string
  usedNames: Set<string>
  sequence: number
}

let fsProbeCache: boolean | null = null

export async function canUseLocalFilesystem(): Promise<boolean> {
  if (fsProbeCache !== null) {
    return fsProbeCache
  }

  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const probeDir = path.resolve(process.cwd(), ".fs-probe")
    await fs.mkdir(probeDir, { recursive: true })
    await fs.rm(probeDir, { recursive: true, force: true })
    fsProbeCache = true
    return true
  } catch {
    fsProbeCache = false
    return false
  }
}

export type PersistedJobSnapshot = {
  id: string
  status: "queued" | "running" | "completed" | "failed"
  createdAt: string
  updatedAt: string
  request: {
    baseUrl: string
    format: "json" | "jsonl"
    maxPages: number
    maxDiscover: number
    maxDepth: number
    concurrency: number
    saveLocal: boolean
  }
  progress: {
    discovered: number
    total: number
    completed: number
    failed: number
  }
  error?: string
}

export async function createLocalWriteSession(jobId: string): Promise<{
  ok: boolean
  session?: LocalWriteSession
  result: LocalWriteResult
}> {
  const result: LocalWriteResult = {
    enabled: false,
    directory: "local",
    writtenDocs: 0,
    writtenIndexes: 0,
    siteIndexFile: "site-index.json",
    docsJsonDir: "docs-json",
    jsonlFile: "scraped.jsonl",
    errors: [],
  }

  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const rootDir = path.resolve(process.cwd(), "local", jobId)
    const docsJsonDir = path.join(rootDir, "docs-json")
    await fs.mkdir(docsJsonDir, { recursive: true })

    result.enabled = true
    result.directory = rootDir
    result.docsJsonDir = docsJsonDir

    return {
      ok: true,
      session: {
        rootDir,
        docsJsonDir,
        usedNames: new Set<string>(),
        sequence: 0,
      },
      result,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to initialize local output"
    if (message.includes("not implemented yet") || message.includes("[unenv]")) {
      result.errors.push(
        "Filesystem writes are not available in this runtime (Cloudflare Worker/unenv). " +
          "Run in a Node/Docker server runtime with a writable local volume.",
      )
    } else {
      result.errors.push(message)
    }
    return { ok: false, result }
  }
}

export async function writeScrapedDocJson(
  session: LocalWriteSession,
  item: PreloadItem,
): Promise<{ ok: boolean; file?: string; error?: string }> {
  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const base = uniqueBaseName(session, item)
    const file = `${base}.json`
    const target = path.join(session.docsJsonDir, file)
    await fs.writeFile(target, JSON.stringify(item, null, 2), "utf8")
    return { ok: true, file: target }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to write scraped doc JSON",
    }
  }
}

export async function finalizeScrapedJsonl(session: LocalWriteSession): Promise<{
  ok: boolean
  file?: string
  error?: string
}> {
  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const jsonFiles = (await fs.readdir(session.docsJsonDir))
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b))

    const lines: string[] = []
    for (const file of jsonFiles) {
      const fullPath = path.join(session.docsJsonDir, file)
      const raw = await fs.readFile(fullPath, "utf8")
      const parsed = JSON.parse(raw) as PreloadItem
      lines.push(JSON.stringify(parsed))
    }

    const jsonlPath = path.join(session.rootDir, "scraped.jsonl")
    await fs.writeFile(jsonlPath, lines.join("\n"), "utf8")
    return { ok: true, file: jsonlPath }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to finalize JSONL",
    }
  }
}

export async function writePreloadBundleToLocal(
  bundle: PreloadBundle,
  result: LocalWriteResult,
): Promise<LocalWriteResult> {
  if (!result.enabled) return result

  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const finalDir = path.resolve(process.cwd(), "local", finalDirectoryNameFromBaseUrl(bundle.siteIndex.baseUrl))
    await fs.mkdir(finalDir, { recursive: true })

    await fs.writeFile(
      path.join(finalDir, result.siteIndexFile),
      JSON.stringify(bundle.siteIndex, null, 2),
      "utf8",
    )

    const urlToLocalFile = new Map<string, string>()
    for (const summary of bundle.siteIndex.docs) {
      urlToLocalFile.set(normalizeLocalComparableUrl(summary.url), summary.contentFile)
      if (summary.path) {
        try {
          const resolvedFromPath = new URL(summary.path, bundle.siteIndex.baseUrl).toString()
          urlToLocalFile.set(normalizeLocalComparableUrl(resolvedFromPath), summary.contentFile)
        } catch {
          // Ignore paths that are not valid/absolute URLs.
        }
      }
    }

    for (const doc of bundle.siteIndex.docs) {
      const sourceContent =
        bundle.docs.find((entry) => entry.url === doc.url && entry.path === doc.path)?.content || ""
      const content = rewriteMarkdownLinksToLocal(sourceContent, doc.url, urlToLocalFile)
      const perDocIndex = bundle.docIndexes[doc.id]
      const rewrittenDocIndex =
        perDocIndex == null ? { doc, headings: [], links: [] } : rewriteDocIndexLinksToLocal(perDocIndex, urlToLocalFile)

      await fs.writeFile(path.join(finalDir, doc.contentFile), content, "utf8")
      result.writtenDocs += 1

      const indexPath = path.join(finalDir, doc.indexFile)
      const mergedIndex = await mergeWithExistingDocIndex(indexPath, rewrittenDocIndex)
      await fs.writeFile(
        indexPath,
        JSON.stringify(mergedIndex, null, 2),
        "utf8",
      )
      result.writtenIndexes += 1
    }

    await updateLocalSitesIndex({
      slug: finalDirectoryNameFromBaseUrl(bundle.siteIndex.baseUrl),
      baseUrl: bundle.siteIndex.baseUrl,
      totalDocs: bundle.siteIndex.docs.length,
      updatedAt: new Date().toISOString(),
    })
    await annotateSuggestedDocsInLocalDir(finalDir, bundle.siteIndex.docs)

    result.directory = finalDir
    return result
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "Failed writing final local bundle")
    result.enabled = false
    return result
  }
}

export function finalDirectoryNameFromBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrlForName(baseUrl)
  const slug = slugify(normalized)
  return slug || "docs"
}

export async function writeJobSnapshot(snapshot: PersistedJobSnapshot): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const root = path.resolve(process.cwd(), "local")
  const jobDir = path.join(root, snapshot.id)
  const jobFile = path.join(jobDir, "job.json")
  const listFile = path.join(root, "jobs.json")

  await fs.mkdir(jobDir, { recursive: true })
  await fs.writeFile(jobFile, JSON.stringify(snapshot, null, 2), "utf8")

  let list: Array<{ id: string; status: string; updatedAt: string }> = []
  try {
    const raw = await fs.readFile(listFile, "utf8")
    list = JSON.parse(raw) as Array<{ id: string; status: string; updatedAt: string }>
  } catch {
    list = []
  }

  const next = list.filter((entry) => entry.id !== snapshot.id)
  next.push({ id: snapshot.id, status: snapshot.status, updatedAt: snapshot.updatedAt })
  next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  await fs.writeFile(listFile, JSON.stringify(next, null, 2), "utf8")
}

export async function readJobSnapshot(id: string): Promise<PersistedJobSnapshot | null> {
  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const jobFile = path.resolve(process.cwd(), "local", id, "job.json")
    const raw = await fs.readFile(jobFile, "utf8")
    return JSON.parse(raw) as PersistedJobSnapshot
  } catch {
    return null
  }
}

export async function readJobsList(): Promise<Array<{ id: string; status: string; updatedAt: string }>> {
  try {
    const fs = await import("node:fs/promises")
    const path = await import("node:path")
    const listFile = path.resolve(process.cwd(), "local", "jobs.json")
    const raw = await fs.readFile(listFile, "utf8")
    return JSON.parse(raw) as Array<{ id: string; status: string; updatedAt: string }>
  } catch {
    return []
  }
}

function uniqueBaseName(session: LocalWriteSession, item: PreloadItem): string {
  const fromPath = item.path.split("/").filter(Boolean).pop() || ""
  const fromUrl = safeUrlLeaf(item.url)
  const seed = slugify(fromPath || fromUrl || "doc")

  let candidate = seed
  while (session.usedNames.has(candidate)) {
    session.sequence += 1
    candidate = `${seed}-${session.sequence}`
  }
  session.usedNames.add(candidate)
  return candidate
}

function safeUrlLeaf(url: string): string {
  try {
    const parsed = new URL(url)
    const leaf = parsed.pathname.split("/").filter(Boolean).pop()
    return leaf || parsed.hostname
  } catch {
    return "doc"
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
  return slug || "doc"
}

function normalizeBaseUrlForName(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl)
    const path = parsed.pathname.replace(/\/+$/, "")
    return `${parsed.hostname}${path}`.toLowerCase()
  } catch {
    return baseUrl.toLowerCase()
  }
}

async function updateLocalSitesIndex(nextEntry: LocalSitesIndexEntry): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const localRoot = path.resolve(process.cwd(), "local")
  const indexPath = path.join(localRoot, "sites-index.json")

  let current: LocalSitesIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sites: [],
  }

  try {
    const raw = await fs.readFile(indexPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<LocalSitesIndex>
    if (parsed && Array.isArray(parsed.sites)) {
      current = {
        version: 1,
        generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : current.generatedAt,
        sites: parsed.sites
          .filter((item): item is LocalSitesIndexEntry => Boolean(item?.slug && item?.baseUrl))
          .map((item) => ({
            slug: item.slug,
            baseUrl: item.baseUrl,
            totalDocs: Number.isFinite(item.totalDocs) ? item.totalDocs : 0,
            updatedAt: item.updatedAt || new Date().toISOString(),
          })),
      }
    }
  } catch {
    // start fresh
  }

  const without = current.sites.filter((site) => site.slug !== nextEntry.slug)
  without.push(nextEntry)
  without.sort((a, b) => a.slug.localeCompare(b.slug))

  const next: LocalSitesIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sites: without,
  }

  await fs.writeFile(indexPath, JSON.stringify(next, null, 2), "utf8")
}

function rewriteMarkdownLinksToLocal(
  markdown: string,
  sourceUrl: string,
  urlToLocalFile: Map<string, string>,
): string {
  const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/g

  return markdown.replace(linkPattern, (full, label: string, rawTarget: string, offset: number) => {
    if (offset > 0 && markdown[offset - 1] === "!") {
      return full
    }

    const parsed = parseMarkdownLinkTarget(rawTarget)
    if (!parsed) return full

    let resolved: URL
    try {
      resolved = new URL(parsed.href, sourceUrl)
    } catch {
      return full
    }

    const localFile = urlToLocalFile.get(normalizeLocalComparableUrl(resolved.toString()))
    if (!localFile) return full

    const localHref = `${localFile}${resolved.hash || ""}`
    const withTitle = parsed.titleSuffix ? `${localHref}${parsed.titleSuffix}` : localHref
    return `[${label}](${withTitle})`
  })
}

function parseMarkdownLinkTarget(rawTarget: string): { href: string; titleSuffix: string } | null {
  const target = rawTarget.trim()
  if (!target) return null

  if (target.startsWith("<")) {
    const closing = target.indexOf(">")
    if (closing > 1) {
      const href = target.slice(1, closing)
      const titleSuffix = target.slice(closing + 1)
      return { href, titleSuffix }
    }
  }

  const split = target.match(/^(\S+)(\s+.+)?$/)
  if (!split) return null
  return {
    href: split[1],
    titleSuffix: split[2] || "",
  }
}

function normalizeLocalComparableUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    parsed.search = ""
    const asString = parsed.toString()
    return asString.endsWith("/") ? asString.slice(0, -1) : asString
  } catch {
    return url
  }
}

function rewriteDocIndexLinksToLocal(
  docIndex: PreloadDocIndex,
  urlToLocalFile: Map<string, string>,
): PreloadDocIndex {
  return {
    ...docIndex,
    links: docIndex.links.map((link) => {
      let parsed: URL
      try {
        parsed = new URL(link.url)
      } catch {
        return link
      }

      const localFile = urlToLocalFile.get(normalizeLocalComparableUrl(parsed.toString()))
      if (!localFile) return link

      return {
        ...link,
        url: `${localFile}${parsed.hash || ""}`,
      }
    }),
  }
}

async function annotateSuggestedDocsInLocalDir(finalDir: string, docs: PreloadDocSummary[]): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")

  type TokenizedDoc = {
    doc: PreloadDocSummary
    tokens: Set<string>
  }

  const tokenized: TokenizedDoc[] = []
  for (const doc of docs) {
    try {
      const contentPath = path.join(finalDir, doc.contentFile)
      const content = await fs.readFile(contentPath, "utf8")
      tokenized.push({
        doc,
        tokens: tokenizeForOverlap(content, doc.title),
      })
    } catch {
      tokenized.push({
        doc,
        tokens: tokenizeForOverlap(doc.title, doc.title),
      })
    }
  }

  const byDocId = new Map<string, Array<{ target: PreloadDocSummary; score: number; sharedTerms: number }>>()
  for (const source of tokenized) {
    const suggestions: Array<{ target: PreloadDocSummary; score: number; sharedTerms: number }> = []

    for (const target of tokenized) {
      if (source.doc.id === target.doc.id) continue
      const sharedTerms = countSharedTerms(source.tokens, target.tokens)
      if (sharedTerms < 8) continue
      const score = sharedTerms / Math.max(1, Math.min(source.tokens.size, target.tokens.size))
      if (score < 0.18) continue
      suggestions.push({
        target: target.doc,
        score,
        sharedTerms,
      })
    }

    suggestions.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.sharedTerms !== a.sharedTerms) return b.sharedTerms - a.sharedTerms
      return a.target.title.localeCompare(b.target.title)
    })
    byDocId.set(source.doc.id, suggestions.slice(0, 10))
  }

  for (const doc of docs) {
    const indexPath = path.join(finalDir, doc.indexFile)
    try {
      const raw = await fs.readFile(indexPath, "utf8")
      const parsed = JSON.parse(raw) as PreloadDocIndex
      const existingSuggested =
        parsed && Array.isArray((parsed as { suggested?: unknown[] }).suggested)
          ? ((parsed as { suggested?: unknown[] }).suggested as unknown[])
          : undefined
      const suggestions = (byDocId.get(doc.id) || []).map((entry) => ({
        docId: entry.target.id,
        title: entry.target.title,
        path: entry.target.path,
        url: entry.target.url,
        contentFile: entry.target.contentFile,
        indexFile: entry.target.indexFile,
        overlapScore: Number(entry.score.toFixed(3)),
        sharedTerms: entry.sharedTerms,
      }))
      parsed.suggested = existingSuggested && existingSuggested.length > 0 ? parsed.suggested : suggestions
      await fs.writeFile(indexPath, JSON.stringify(parsed, null, 2), "utf8")
    } catch {
      continue
    }
  }
}

function tokenizeForOverlap(content: string, title: string): Set<string> {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "your",
    "into",
    "when",
    "where",
    "have",
    "more",
    "using",
    "used",
    "than",
    "will",
    "been",
    "they",
    "their",
    "only",
    "about",
    "into",
    "over",
    "also",
    "such",
    "just",
    "each",
    "after",
    "before",
    "through",
    "while",
    "between",
    "under",
    "very",
  ])

  const combined = `${title}\n${content}`
    .toLowerCase()
    .replace(/[`*_#[\]()>~\-]/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
  const words = combined.match(/[a-z0-9]{3,}/g) || []
  const tokens = new Set<string>()
  for (const word of words) {
    if (stopWords.has(word)) continue
    tokens.add(word)
  }
  return tokens
}

function countSharedTerms(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let count = 0
  for (const token of small) {
    if (large.has(token)) count += 1
  }
  return count
}

async function mergeWithExistingDocIndex(indexPath: string, generated: PreloadDocIndex): Promise<PreloadDocIndex> {
  const fs = await import("node:fs/promises")
  try {
    const raw = await fs.readFile(indexPath, "utf8")
    const existing = JSON.parse(raw) as Record<string, unknown>
    const existingSuggested = Array.isArray(existing.suggested) ? existing.suggested : undefined

    return {
      ...(existing as object),
      doc: generated.doc,
      headings: generated.headings,
      links: generated.links,
      suggested: existingSuggested ? (existingSuggested as PreloadDocIndex["suggested"]) : generated.suggested,
    }
  } catch {
    return generated
  }
}
