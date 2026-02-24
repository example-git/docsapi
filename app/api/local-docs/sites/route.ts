import { NextRequest, NextResponse } from "next/server"
import { requireLocalDocsAuth } from "../../../../src/lib/local-docs-auth"
import { listManagedLocalSites } from "../../../../src/lib/local-site-admin"

export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  try {
    const sites = await listManagedLocalSites()
    return NextResponse.json({ sites })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to list local sites." },
      { status: 500 },
    )
  }
}
