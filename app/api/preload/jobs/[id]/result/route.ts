import { NextRequest, NextResponse } from "next/server"
import { getPreloadJobResult } from "../../../../../../src/lib/preload-job-manager"
import { requireLocalDocsAuth } from "../../../../../../src/lib/local-docs-auth"

export const runtime = "nodejs"

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  const { id } = await context.params
  const result = await getPreloadJobResult(id)

  if (result.state === "completed") {
    return NextResponse.json(result.result)
  }
  if (result.state === "failed") {
    return NextResponse.json({ message: result.error }, { status: 500 })
  }
  if (result.state === "unfinished") {
    return NextResponse.json({ message: result.error }, { status: 409 })
  }
  return NextResponse.json({ message: result.error }, { status: 404 })
}
