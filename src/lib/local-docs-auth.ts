import { NextRequest, NextResponse } from "next/server"
import { existsSync, readFileSync } from "node:fs"
import { timingSafeEqual } from "node:crypto"
import path from "node:path"

export const LOCAL_DOCS_AUTH_COOKIE = "local_docs_auth"
const LOCAL_DOCS_PASSWORD_ENV = "LOCAL_DOCS_PASSWORD"

export function getLocalDocsPassword(): string | null {
  const value = process.env[LOCAL_DOCS_PASSWORD_ENV]
  if (value && value.trim()) return value
  return readPasswordFromDotenv()
}

export function isLocalDocsPasswordValid(password: string | null | undefined): boolean {
  const expected = getLocalDocsPassword()
  if (!expected) return false
  if (!password) return false
  try {
    const a = Buffer.from(expected, "utf8")
    const b = Buffer.from(password, "utf8")
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export function extractLocalDocsPassword(request: NextRequest): string | null {
  const fromHeader = request.headers.get("x-local-docs-password")
  if (fromHeader) return fromHeader

  const authHeader = request.headers.get("authorization")
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim()
    if (bearer) return bearer
  }

  const fromCookie = request.cookies.get(LOCAL_DOCS_AUTH_COOKIE)?.value
  return fromCookie || null
}

export function requireLocalDocsAuth(request: NextRequest): NextResponse | null {
  const expected = getLocalDocsPassword()
  if (!expected) {
    return NextResponse.json(
      { message: `Server is missing ${LOCAL_DOCS_PASSWORD_ENV}. Local docs routes are disabled.` },
      { status: 503 },
    )
  }

  const provided = extractLocalDocsPassword(request)
  if (!isLocalDocsPasswordValid(provided)) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 })
  }

  return null
}

function readPasswordFromDotenv(): string | null {
  const candidates = [path.resolve(process.cwd(), ".env.local"), path.resolve(process.cwd(), ".env")]
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    try {
      const raw = readFileSync(filePath, "utf8")
      const parsed = parseDotenvLine(raw, LOCAL_DOCS_PASSWORD_ENV)
      if (parsed && parsed.trim()) return parsed.trim()
    } catch {
      continue
    }
  }
  return null
}

function parseDotenvLine(content: string, key: string): string | null {
  const lines = content.split(/\r?\n/g)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const candidateKey = trimmed.slice(0, eq).trim()
    if (candidateKey !== key) continue
    const value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1)
    }
    return value
  }
  return null
}
