import { NextRequest, NextResponse } from "next/server"
import { getPreloadJobStatus } from "../../../../../src/lib/preload-job-manager"
import { requireLocalDocsAuth } from "../../../../../src/lib/local-docs-auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  const { id } = await context.params
  const status = await getPreloadJobStatus(id)
  if (!status) {
    return NextResponse.json({ message: "Preload job not found." }, { status: 404 })
  }
  return NextResponse.json(status)
}
