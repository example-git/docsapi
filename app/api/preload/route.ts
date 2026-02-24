import { NextRequest, NextResponse } from "next/server"
import { enqueuePreloadJob, LocalFilesystemUnavailableError } from "../../../src/lib/preload-job-manager"
import { requireLocalDocsAuth } from "../../../src/lib/local-docs-auth"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json(
      {
        message: "Invalid JSON body. Expected fields like baseUrl, paths, maxPages, and format.",
      },
      { status: 400 },
    )
  }

  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ message: "Request body must be a JSON object." }, { status: 400 })
  }

  try {
    const queued = await enqueuePreloadJob(payload)
    return NextResponse.json(queued, { status: 202 })
  } catch (error) {
    if (error instanceof LocalFilesystemUnavailableError) {
      return NextResponse.json({ message: error.message }, { status: 501 })
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to enqueue preload job." },
      { status: 400 },
    )
  }
}
