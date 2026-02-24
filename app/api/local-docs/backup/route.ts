import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { execFile } from "node:child_process"
import { NextRequest, NextResponse } from "next/server"
import { requireLocalDocsAuth } from "../../../../src/lib/local-docs-auth"
import { listManagedLocalSites } from "../../../../src/lib/local-site-admin"

export const runtime = "nodejs"

const execFileAsync = promisify(execFile)

export async function POST(request: NextRequest) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 400 })
  }

  const slugs = Array.isArray((payload as { slugs?: unknown[] })?.slugs)
    ? (payload as { slugs: unknown[] }).slugs.filter((value): value is string => typeof value === "string")
    : []
  if (slugs.length === 0) {
    return NextResponse.json({ message: "Provide at least one slug." }, { status: 400 })
  }

  const knownSites = await listManagedLocalSites()
  const knownSlugs = new Set(knownSites.map((site) => site.slug))
  const selected = slugs.filter((slug) => knownSlugs.has(slug))
  if (selected.length === 0) {
    return NextResponse.json({ message: "None of the selected slugs exist." }, { status: 404 })
  }

  const tempDir = path.resolve(process.cwd(), ".tmp", randomUUID())
  const zipPath = path.join(tempDir, `local-backup-${randomUUID()}.zip`)
  const localRoot = path.resolve(process.cwd(), "local")
  const archiveName = `local-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`

  try {
    await mkdir(tempDir, { recursive: true })
    const pythonProgram = [
      "import os, sys, zipfile",
      "out = sys.argv[1]",
      "root = sys.argv[2]",
      "slugs = sys.argv[3:]",
      "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
      "    for slug in slugs:",
      "        base = os.path.join(root, slug)",
      "        for dirpath, _, files in os.walk(base):",
      "            for f in files:",
      "                full = os.path.join(dirpath, f)",
      "                rel = os.path.relpath(full, root)",
      "                z.write(full, rel)",
    ].join("\n")

    await execFileAsync("python3", ["-c", pythonProgram, zipPath, localRoot, ...selected], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024 * 20,
    })
    const bytes = await readFile(zipPath)

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${archiveName}"`,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to build backup zip." },
      { status: 500 },
    )
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
