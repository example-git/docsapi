import { NextRequest, NextResponse } from "next/server"
import { fetchDocumentationMarkdown } from "../../../src/lib/docset"

export const runtime = "nodejs"

export async function GET(request: NextRequest, context: { params: Promise<{ url: string[] }> }) {
  const params = await context.params
  const rawPath = (params.url || []).join("/")
  if (!rawPath) {
    return NextResponse.json({ message: "Missing documentation URL" }, { status: 400 })
  }

  const decodedPath = decodeURIComponent(rawPath)
  const withQuery =
    request.nextUrl.search && !decodedPath.includes("?")
      ? `${decodedPath}${request.nextUrl.search}`
      : decodedPath
  const normalizedInput = withQuery.startsWith("http") ? withQuery : `https://${withQuery}`
  const targetUrl = encodeURI(normalizedInput)

  try {
    const { markdown, url } = await fetchDocumentationMarkdown({ baseUrl: targetUrl })
    if (!markdown || markdown.trim().length < 100) {
      return NextResponse.json(
        {
          message: "The documentation page loaded but contained insufficient content.",
        },
        { status: 502 },
      )
    }

    const headers = new Headers({
      "Content-Location": url,
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      ETag: `"${Buffer.from(markdown).toString("base64").slice(0, 16)}"`,
      "Last-Modified": new Date().toUTCString(),
    })

    const accept = request.headers.get("accept") || ""
    if (accept.includes("application/json")) {
      headers.set("Content-Type", "application/json; charset=utf-8")
      return new NextResponse(
        JSON.stringify({
          url,
          content: markdown,
        }),
        { status: 200, headers },
      )
    }

    headers.set("Content-Type", "text/markdown; charset=utf-8")
    return new NextResponse(markdown, { status: 200, headers })
  } catch (error) {
    return NextResponse.json(
      {
        error: "Service temporarily unavailable",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
