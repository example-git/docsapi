import { NextRequest, NextResponse } from "next/server"
import { searchDocumentation } from "../../../../src/lib/docset/search"

export const runtime = "nodejs"

export async function GET(request: NextRequest, context: { params: Promise<{ url: string[] }> }) {
  const params = await context.params
  const rawPath = (params.url || []).join("/")
  if (!rawPath) {
    return NextResponse.json({ message: "Missing documentation URL" }, { status: 400 })
  }

  const query = request.nextUrl.searchParams.get("q")?.trim() ?? ""
  if (!query) {
    return NextResponse.json({ message: "Missing search query" }, { status: 400 })
  }

  const decodedPath = decodeURIComponent(rawPath)
  const normalizedInput = decodedPath.startsWith("http") ? decodedPath : `https://${decodedPath}`
  const targetUrl = encodeURI(normalizedInput)

  const results = await searchDocumentation(targetUrl, query)
  return NextResponse.json({ query, results })
}
