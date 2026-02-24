import { docsetTypes } from "./docset/types"
import { fetchDocumentationMarkdown } from "./docset"
import { discoverDocumentationUrls } from "./docset/preload"
import {
  canUseLocalFilesystem,
  createLocalWriteSession,
  finalizeScrapedJsonl,
  readJobsList,
  readJobSnapshot,
  writeJobSnapshot,
  writePreloadBundleToLocal,
  writeScrapedDocJson,
} from "./preload-local"
import { buildPreloadBundle, buildPreloadTargets, normalizeMaxPages, parsePreloadPaths } from "./preload"

export type PreloadRequestBody = {
  baseUrl?: unknown
  paths?: unknown
  docsetType?: unknown
  format?: unknown
  maxPages?: unknown
  maxDiscover?: unknown
  maxDepth?: unknown
  includeBase?: unknown
  includeIndexes?: unknown
  includeLinks?: unknown
  sameHostOnly?: unknown
  concurrency?: unknown
}

export type PreloadJobStatus = "queued" | "running" | "completed" | "failed"

export type PreloadJobResult = {
  baseUrl: string
  discovered: number
  preloaded: number
  failed: number
  items: Array<{
    path: string
    url: string
    docsetType: (typeof docsetTypes)[number]
    content: string
  }>
  documents: Array<{
    id: string
    path: string
    url: string
    docsetType: (typeof docsetTypes)[number]
    title: string
    description: string
    contentFile: string
    indexFile: string
    content: string
    index: unknown
  }>
  siteIndex: unknown
  docIndexes: unknown
  errors: Array<{ path: string; error: string }>
  diagnostics: unknown
  concurrency: number
  localOutput: {
    enabled: boolean
    directory: string
    writtenDocs: number
    writtenIndexes: number
    siteIndexFile: string
    docsJsonDir: string
    jsonlFile: string
    errors: string[]
  }
}

type PreloadJob = {
  id: string
  status: PreloadJobStatus
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
  result?: PreloadJobResult
  error?: string
}

const preloadJobs = new Map<string, PreloadJob>()

export class LocalFilesystemUnavailableError extends Error {}

export async function enqueuePreloadJob(body: PreloadRequestBody): Promise<{
  jobId: string
  status: "queued"
  statusUrl: string
  resultUrl: string
}> {
  const hasLocalFs = await canUseLocalFilesystem()
  if (!hasLocalFs) {
    throw new LocalFilesystemUnavailableError(
      "Local-only preload is disabled in this runtime. Run in Node/Docker with writable filesystem.",
    )
  }

  if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
    throw new Error("baseUrl is required.")
  }

  const maxPages = normalizeMaxPages(
    typeof body.maxPages === "number" ? body.maxPages : Number(body.maxPages),
  )
  const maxDiscover =
    typeof body.maxDiscover === "number" && Number.isFinite(body.maxDiscover)
      ? Math.max(1, Math.min(2000, Math.floor(body.maxDiscover)))
      : 300
  const maxDepth =
    typeof body.maxDepth === "number" && Number.isFinite(body.maxDepth)
      ? Math.max(1, Math.min(5, Math.floor(body.maxDepth)))
      : 2
  const concurrency =
    typeof body.concurrency === "number" && Number.isFinite(body.concurrency)
      ? Math.max(1, Math.min(12, Math.floor(body.concurrency)))
      : 4
  const format = body.format === "jsonl" ? "jsonl" : "json"
  const saveLocal = true

  prunePreloadJobs()
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const job: PreloadJob = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    request: {
      baseUrl: body.baseUrl,
      format,
      maxPages,
      maxDiscover,
      maxDepth,
      concurrency,
      saveLocal,
    },
    progress: {
      discovered: 0,
      total: 0,
      completed: 0,
      failed: 0,
    },
  }
  preloadJobs.set(id, job)
  await safeWriteJobSnapshot({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    request: job.request,
    progress: job.progress,
  })
  void runPreloadJob(id, body)

  return {
    jobId: id,
    status: "queued",
    statusUrl: `/api/preload/jobs/${id}`,
    resultUrl: `/api/preload/jobs/${id}/result`,
  }
}

export async function getPreloadJobStatus(id: string): Promise<
  | {
      id: string
      status: string
      createdAt?: string
      updatedAt?: string
      request?: unknown
      progress?: unknown
      error?: string
      hasResult: boolean
      message?: string
    }
  | null
> {
  prunePreloadJobs()
  const job = preloadJobs.get(id)
  if (job) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: job.request,
      progress: job.progress,
      error: job.error,
      hasResult: Boolean(job.result),
    }
  }

  const persisted = await readJobSnapshot(id)
  if (persisted) {
    return {
      id: persisted.id,
      status: persisted.status,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      request: persisted.request,
      progress: persisted.progress,
      error: persisted.error,
      hasResult: persisted.status === "completed",
    }
  }

  const list = await readJobsList()
  const listEntry = list.find((entry) => entry.id === id)
  if (listEntry && !["completed", "failed"].includes(listEntry.status)) {
    return {
      id,
      status: listEntry.status,
      hasResult: false,
      message: "Job exists but is unfinished (from jobs.json list).",
    }
  }

  return null
}

export async function getPreloadJobResult(id: string): Promise<
  | { state: "completed"; result: PreloadJobResult }
  | { state: "failed"; error: string }
  | { state: "unfinished"; error: string }
  | { state: "not_found"; error: string }
> {
  prunePreloadJobs()
  const job = preloadJobs.get(id)
  if (job) {
    if (job.status === "failed") {
      return { state: "failed", error: job.error || "Preload job failed." }
    }
    if (job.status !== "completed" || !job.result) {
      return { state: "unfinished", error: "Preload job is not completed yet." }
    }
    return { state: "completed", result: job.result }
  }

  const persisted = await readJobSnapshot(id)
  if (persisted) {
    if (persisted.status === "failed") {
      return { state: "failed", error: persisted.error || "Preload job failed." }
    }
    if (persisted.status === "completed") {
      return {
        state: "not_found",
        error: "Preload job completed but its result has expired and is no longer available.",
      }
    }
    if (!["completed", "failed"].includes(persisted.status)) {
      return {
        state: "unfinished",
        error: "Preload job exists but is unfinished (from jobs.json list).",
      }
    }
  }

  return { state: "not_found", error: "Preload job not found." }
}

async function runPreloadJob(id: string, body: PreloadRequestBody): Promise<void> {
  const job = preloadJobs.get(id)
  if (!job || typeof body.baseUrl !== "string") return

  try {
    job.status = "running"
    job.updatedAt = new Date().toISOString()
    await safeWriteJobSnapshot({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: job.request,
      progress: job.progress,
    })

    const userPaths = parsePreloadPaths(body.paths)
    const includeBase = body.includeBase !== false
    const maxPages = normalizeMaxPages(
      typeof body.maxPages === "number" ? body.maxPages : Number(body.maxPages),
    )
    const maxDiscover =
      typeof body.maxDiscover === "number" && Number.isFinite(body.maxDiscover)
        ? Math.max(1, Math.min(2000, Math.floor(body.maxDiscover)))
        : 300
    const maxDepth =
      typeof body.maxDepth === "number" && Number.isFinite(body.maxDepth)
        ? Math.max(1, Math.min(5, Math.floor(body.maxDepth)))
        : 2
    const concurrency =
      typeof body.concurrency === "number" && Number.isFinite(body.concurrency)
        ? Math.max(1, Math.min(12, Math.floor(body.concurrency)))
        : 4
    const saveLocal = true

    const discovery = await discoverDocumentationUrls(body.baseUrl, {
      includeIndexes: body.includeIndexes !== false,
      includeLinks: body.includeLinks !== false,
      maxDiscover,
      maxDepth,
      sameHostOnly: body.sameHostOnly !== false,
    })

    // discovery.urls[0] is always the normalized base URL (it seeds the discovered Set).
    // When includeBase=true, buildPreloadTargets already prepends "" (which resolves to
    // the base URL), so exclude it from discovery.urls to avoid fetching the base twice.
    const discoveredUrls = includeBase
      ? discovery.urls.filter((url) => url !== discovery.urls[0])
      : discovery.urls
    const targets = buildPreloadTargets({
      includeBase,
      maxPages,
      paths: [...userPaths, ...discoveredUrls],
    })
    job.progress.discovered = discovery.urls.length
    job.progress.total = targets.length
    job.updatedAt = new Date().toISOString()

    if (targets.length === 0) {
      throw new Error("No targets found to preload.")
    }

    const docsetType =
      typeof body.docsetType === "string" &&
      docsetTypes.includes(body.docsetType as (typeof docsetTypes)[number])
        ? (body.docsetType as (typeof docsetTypes)[number])
        : undefined

    const items: Array<{
      path: string
      url: string
      docsetType: (typeof docsetTypes)[number]
      content: string
    }> = []
    const errors: Array<{ path: string; error: string }> = []
    const localSession = await createLocalWriteSession(id)
    if (!localSession.ok || !localSession.session) {
      throw new Error(localSession.result.errors[0] || "Failed to initialize local output")
    }
    let localOutput = localSession.result

    let index = 0
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
      while (true) {
        const current = index
        index += 1
        if (current >= targets.length) break

        const path = targets[current]
        try {
          const result = await fetchDocumentationMarkdown({
            baseUrl: body.baseUrl as string,
            path: path || undefined,
            docsetType,
          })

          items.push({
            path: path || "/",
            url: result.url,
            docsetType: result.docsetType,
            content: result.markdown,
          })
          const writeDoc = await writeScrapedDocJson(localSession.session, {
            path: path || "/",
            url: result.url,
            docsetType: result.docsetType,
            content: result.markdown,
          })
          if (!writeDoc.ok) {
            throw new Error(writeDoc.error || "Failed to write scraped JSON")
          }
          job.progress.completed += 1
        } catch (error) {
          errors.push({
            path: path || "/",
            error: error instanceof Error ? error.message : "Unknown error",
          })
          job.progress.failed += 1
        } finally {
          job.updatedAt = new Date().toISOString()
          await safeWriteJobSnapshot({
            id: job.id,
            status: job.status,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            request: job.request,
            progress: job.progress,
            error: job.error,
          })
        }
      }
    })

    await Promise.all(workers)

    if (items.length === 0) {
      throw new Error("No pages could be preloaded. Check baseUrl and crawl settings.")
    }

    const bundle = buildPreloadBundle(body.baseUrl, items)
    localOutput = saveLocal ? await writePreloadBundleToLocal(bundle, localOutput) : localOutput
    if (!localOutput.enabled) {
      throw new Error(localOutput.errors[0] || "Failed to write local output")
    }
    const finalized = await finalizeScrapedJsonl(localSession.session)
    if (!finalized.ok) {
      throw new Error(finalized.error || "Failed to finalize scraped JSONL")
    }
    localOutput.jsonlFile = finalized.file || localOutput.jsonlFile
    const documents = bundle.siteIndex.docs.map((doc) => {
      const source = bundle.docs.find((entry) => entry.url === doc.url && entry.path === doc.path)
      return {
        ...doc,
        content: source?.content ?? "",
        index: bundle.docIndexes[doc.id],
      }
    })

    job.result = {
      baseUrl: body.baseUrl,
      discovered: discovery.urls.length,
      preloaded: items.length,
      failed: errors.length,
      items,
      documents,
      siteIndex: bundle.siteIndex,
      docIndexes: bundle.docIndexes,
      errors,
      diagnostics: discovery.diagnostics,
      concurrency,
      localOutput,
    }
    job.status = "completed"
    job.updatedAt = new Date().toISOString()
    await safeWriteJobSnapshot({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: job.request,
      progress: job.progress,
      error: job.error,
    })
  } catch (error) {
    job.status = "failed"
    job.error = error instanceof Error ? error.message : "Unknown preload job error"
    job.updatedAt = new Date().toISOString()
    await safeWriteJobSnapshot({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: job.request,
      progress: job.progress,
      error: job.error,
    })
  }
}

async function safeWriteJobSnapshot(snapshot: Parameters<typeof writeJobSnapshot>[0]): Promise<void> {
  try {
    await writeJobSnapshot(snapshot)
  } catch (error) {
    console.error("Failed to persist job snapshot:", error)
  }
}

function prunePreloadJobs(): void {
  const now = Date.now()
  const ttlMs = 1000 * 60 * 60
  const maxJobs = 25

  for (const [id, job] of preloadJobs) {
    const ageMs = now - new Date(job.updatedAt).getTime()
    if (ageMs > ttlMs && job.status !== "running") {
      preloadJobs.delete(id)
    }
  }

  if (preloadJobs.size <= maxJobs) return

  const sorted = Array.from(preloadJobs.values()).sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  )
  for (const job of sorted) {
    if (preloadJobs.size <= maxJobs) break
    if (job.status === "running") continue
    preloadJobs.delete(job.id)
  }
}
