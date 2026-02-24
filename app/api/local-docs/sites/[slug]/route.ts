import { NextRequest, NextResponse } from "next/server"
import { requireLocalDocsAuth } from "../../../../../src/lib/local-docs-auth"
import { deleteLocalSite, renameLocalSite, updateLocalSite } from "../../../../../src/lib/local-site-admin"

export const runtime = "nodejs"

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  const { slug } = await context.params
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 400 })
  }

  const action = typeof payload === "object" && payload && "action" in payload
    ? (payload as { action?: unknown }).action
    : undefined

  try {
    if (action === "update") {
      const queued = await updateLocalSite(slug)
      return NextResponse.json({ message: `Update queued for ${slug}.`, ...queued }, { status: 202 })
    }

    if (action === "rename") {
      const newSlug = typeof payload === "object" && payload && "newSlug" in payload
        ? (payload as { newSlug?: unknown }).newSlug
        : undefined
      if (typeof newSlug !== "string" || !newSlug.trim()) {
        return NextResponse.json({ message: "newSlug is required for rename." }, { status: 400 })
      }
      await renameLocalSite(slug, newSlug)
      return NextResponse.json({ message: `Renamed ${slug} to ${newSlug}.` })
    }

    return NextResponse.json({ message: "Unsupported action. Use 'update' or 'rename'." }, { status: 400 })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Local site action failed." },
      { status: 400 },
    )
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const authFailure = requireLocalDocsAuth(request)
  if (authFailure) return authFailure

  const { slug } = await context.params
  try {
    await deleteLocalSite(slug)
    return NextResponse.json({ message: `Deleted ${slug}.` })
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed deleting local site." },
      { status: 400 },
    )
  }
}
