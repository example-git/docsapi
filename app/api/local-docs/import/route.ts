import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { NextRequest, NextResponse } from "next/server"
import yauzl from "yauzl"
import { requireLocalDocsAuth } from "../../../../src/lib/local-docs-auth"
import {
  rebuildLocalSitesIndex,
  installLocalSiteDirectory,
  normalizeSiteSlug,
} from "../../../../src/lib/local-site-admin"
import { finalDirectoryNameFromBaseUrl } from "../../../../src/lib/preload-local"

export const runtime = "nodejs"

type ImportedSiteIndex = {
  baseUrl?: string
}

export async function POST(request: NextRequest) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  const form = await request.formData()
  const zipFile = form.get("file")
  if (!(zipFile instanceof File)) {
    return NextResponse.json({ message: "Missing uploaded file." }, { status: 400 })
  }
  if (!zipFile.name.toLowerCase().endsWith(".zip")) {
    return NextResponse.json({ message: "Only .zip uploads are supported." }, { status: 400 })
  }
  const MAX_ZIP_SIZE = 512 * 1024 * 1024 // 512 MB
  if (zipFile.size > MAX_ZIP_SIZE) {
    return NextResponse.json({ message: "Uploaded file exceeds 512 MB limit." }, { status: 413 })
  }

  const tempRoot = path.resolve(process.cwd(), ".tmp", `local-import-${randomUUID()}`)
  const zipPath = path.join(tempRoot, "upload.zip")
  const extractDir = path.join(tempRoot, "extracted")

  try {
    await mkdir(extractDir, { recursive: true })
    const bytes = Buffer.from(await zipFile.arrayBuffer())
    await writeFile(zipPath, bytes)

    await extractZip(zipPath, extractDir)
    const importedDirs = await findSiteDirectories(extractDir)
    if (importedDirs.length === 0) {
      return NextResponse.json(
        { message: "No site-index.json files found in uploaded zip." },
        { status: 400 },
      )
    }

    const importedSlugs: string[] = []
    for (const dir of importedDirs) {
      const slug = await chooseImportSlug(dir, extractDir)
      const installed = await installLocalSiteDirectory(dir, slug)
      importedSlugs.push(installed)
    }
    await rebuildLocalSitesIndex()

    return NextResponse.json({
      importedCount: importedSlugs.length,
      importedSlugs: [...new Set(importedSlugs)].sort((a, b) => a.localeCompare(b)),
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Zip import failed." },
      { status: 500 },
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function chooseImportSlug(siteDir: string, extractDir: string): Promise<string | undefined> {
  const siteIndexPath = path.join(siteDir, "site-index.json")
  const raw = await readFile(siteIndexPath, "utf8")
  const parsed = JSON.parse(raw) as ImportedSiteIndex
  const slugFromBase = parsed.baseUrl ? finalDirectoryNameFromBaseUrl(parsed.baseUrl) : undefined

  if (siteDir === extractDir && slugFromBase) {
    return slugFromBase
  }

  const byDir = normalizeSiteSlug(path.basename(siteDir).replace(/_/g, "-"))
  return byDir || slugFromBase
}

async function findSiteDirectories(rootDir: string): Promise<string[]> {
  const out = new Set<string>()
  await walk(rootDir, async (fullPath, isDirectory) => {
    if (isDirectory) return
    if (path.basename(fullPath) !== "site-index.json") return
    out.add(path.dirname(fullPath))
  })
  return [...out]
}

async function walk(
  dir: string,
  onEntry: (fullPath: string, isDirectory: boolean) => Promise<void>,
): Promise<void> {
  const { readdir } = await import("node:fs/promises")
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    await onEntry(fullPath, entry.isDirectory())
    if (entry.isDirectory()) {
      await walk(fullPath, onEntry)
    }
  }
}

async function extractZip(zipPath: string, outputDir: string): Promise<void> {
  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, opened) => {
      if (error || !opened) return reject(error || new Error("Unable to open zip."))
      resolve(opened)
    })
  })

  await new Promise<void>((resolve, reject) => {
    zipFile.readEntry()

    zipFile.on("entry", async (entry) => {
      try {
        const target = safeExtractPath(outputDir, entry.fileName)
        if (entry.fileName.endsWith("/")) {
          await mkdir(target, { recursive: true })
          zipFile.readEntry()
          return
        }

        await mkdir(path.dirname(target), { recursive: true })
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => {
          zipFile.openReadStream(entry, (error, readStream) => {
            if (error || !readStream) return rej(error || new Error("Failed opening zip entry stream."))
            res(readStream)
          })
        })
        await pipeline(stream, createWriteStream(target))
        zipFile.readEntry()
      } catch (error) {
        reject(error)
      }
    })

    zipFile.on("end", () => resolve())
    zipFile.on("error", (error) => reject(error))
  })
}

function safeExtractPath(outputDir: string, fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/")
  if (normalized.includes("../")) {
    throw new Error(`Unsafe zip entry path: ${fileName}`)
  }

  const target = path.resolve(outputDir, normalized)
  const base = path.resolve(outputDir)
  if (!target.startsWith(base + path.sep) && target !== base) {
    throw new Error(`Zip entry escapes output directory: ${fileName}`)
  }
  return target
}
