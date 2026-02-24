import { enqueuePreloadJob } from "./preload-job-manager"

export type LocalSiteSummary = {
  slug: string
  baseUrl: string
  totalDocs: number
}

type LocalSiteIndex = {
  baseUrl: string
  docs?: unknown[]
}

type LocalSitesIndexEntry = {
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

export async function listManagedLocalSites(): Promise<LocalSiteSummary[]> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const localRoot = path.resolve(process.cwd(), "local")
  const indexPath = path.join(localRoot, "sites-index.json")

  try {
    const raw = await fs.readFile(indexPath, "utf8")
    const parsed = JSON.parse(raw) as Partial<LocalSitesIndex>
    if (parsed && Array.isArray(parsed.sites)) {
      return parsed.sites
        .filter((entry): entry is LocalSitesIndexEntry => Boolean(entry?.slug && entry?.baseUrl))
        .map((entry) => ({
          slug: entry.slug,
          baseUrl: entry.baseUrl,
          totalDocs: Number.isFinite(entry.totalDocs) ? entry.totalDocs : 0,
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug))
    }
  } catch {
    // fallback scan below
  }

  return scanManagedLocalSites()
}

export async function updateLocalSite(slug: string): Promise<{ jobId: string; statusUrl: string; resultUrl: string }> {
  const site = await getLocalSiteBySlug(slug)
  if (!site) {
    throw new Error(`Local site "${slug}" not found.`)
  }

  const queued = await enqueuePreloadJob({
    baseUrl: site.baseUrl,
    format: "json",
    includeIndexes: true,
    includeLinks: true,
    includeBase: true,
    sameHostOnly: true,
    maxPages: 200,
    maxDiscover: 300,
    maxDepth: 2,
    concurrency: 4,
  })

  return {
    jobId: queued.jobId,
    statusUrl: queued.statusUrl,
    resultUrl: queued.resultUrl,
  }
}

export async function deleteLocalSite(slug: string): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const normalizedSlug = normalizeSiteSlug(slug)
  if (!normalizedSlug) {
    throw new Error("Invalid slug. Use lowercase letters, numbers, and hyphens only.")
  }
  const target = path.resolve(process.cwd(), "local", normalizedSlug)
  await fs.rm(target, { recursive: true, force: true })
  await rebuildLocalSitesIndex()
}

export async function renameLocalSite(oldSlug: string, newSlug: string): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")

  const normalizedOld = normalizeSiteSlug(oldSlug)
  if (!normalizedOld) {
    throw new Error("Invalid slug. Use lowercase letters, numbers, and hyphens only.")
  }

  const normalized = normalizeSiteSlug(newSlug)
  if (!normalized) {
    throw new Error("Invalid new slug. Use lowercase letters, numbers, and hyphens only.")
  }

  const oldPath = path.resolve(process.cwd(), "local", normalizedOld)
  const newPath = path.resolve(process.cwd(), "local", normalized)
  if (oldPath === newPath) return

  try {
    await fs.access(oldPath)
  } catch {
    throw new Error(`Local site "${oldSlug}" not found.`)
  }

  try {
    await fs.access(newPath)
    throw new Error(`Target slug "${normalized}" already exists.`)
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error
  }

  await fs.rename(oldPath, newPath)
  await rebuildLocalSitesIndex()
}

export function normalizeSiteSlug(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) return null
  return trimmed
}

async function getLocalSiteBySlug(slug: string): Promise<LocalSiteSummary | null> {
  const sites = await listManagedLocalSites()
  return sites.find((site) => site.slug === slug) || null
}

export async function installLocalSiteDirectory(sourceDir: string, preferredSlug?: string): Promise<string> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const slugSource = preferredSlug || path.basename(sourceDir)
  const normalized = normalizeSiteSlug(slugSource.replace(/_/g, "-"))
  if (!normalized) {
    throw new Error(`Invalid site slug from imported directory "${slugSource}".`)
  }

  const targetDir = path.resolve(process.cwd(), "local", normalized)
  await fs.rm(targetDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(targetDir), { recursive: true })
  await fs.cp(sourceDir, targetDir, { recursive: true })
  return normalized
}

async function scanManagedLocalSites(): Promise<LocalSiteSummary[]> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const localRoot = path.resolve(process.cwd(), "local")
  const entries = await fs.readdir(localRoot, { withFileTypes: true })
  const sites: LocalSiteSummary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const siteIndexPath = path.join(localRoot, entry.name, "site-index.json")
    try {
      const raw = await fs.readFile(siteIndexPath, "utf8")
      const parsed = JSON.parse(raw) as LocalSiteIndex
      sites.push({
        slug: entry.name,
        baseUrl: parsed.baseUrl || "",
        totalDocs: Array.isArray(parsed.docs) ? parsed.docs.length : 0,
      })
    } catch {
      continue
    }
  }

  sites.sort((a, b) => a.slug.localeCompare(b.slug))
  return sites
}

export async function rebuildLocalSitesIndex(): Promise<void> {
  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const sites = await scanManagedLocalSites()
  const payload: LocalSitesIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sites: sites.map((site) => ({
      slug: site.slug,
      baseUrl: site.baseUrl,
      totalDocs: site.totalDocs,
      updatedAt: new Date().toISOString(),
    })),
  }
  const indexPath = path.resolve(process.cwd(), "local", "sites-index.json")
  await fs.writeFile(indexPath, JSON.stringify(payload, null, 2), "utf8")
}
