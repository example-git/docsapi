import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import { cache } from "hono/cache"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { trimTrailingSlash } from "hono/trailing-slash"

import { NotFoundError } from "./lib/fetch"
import { createMcpServer } from "./lib/mcp"
import { fetchDocumentationMarkdown } from "./lib/docset"

interface Env {
  ASSETS: Fetcher
  NODE_ENV: string
}

const app = new Hono<{ Bindings: Env }>()

app.use("*", async (c, next) => {
  await next()

  // Security headers
  c.header("X-Content-Type-Options", "nosniff")
  c.header("X-Frame-Options", "DENY")
  c.header("X-XSS-Protection", "1; mode=block")
  c.header("Referrer-Policy", "strict-origin-when-cross-origin")
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

  // Performance headers
  c.header("Vary", "Accept")

  // Development-specific headers
  if (c.env.NODE_ENV === "development") {
    c.header("Cache-Control", "no-store")
  }
})

app.use("*", cors())

app.use(trimTrailingSlash())

app.use("*", async (c, next) => {
  if (c.env.NODE_ENV !== "development") {
    cache({
      cacheName: "sosumi-cache",
      cacheControl: "max-age=86400", // 24 hours
    })
  }
  await next()
})

const mcpServer = createMcpServer()
app.all("/mcp", async (c) => {
  const transport = new StreamableHTTPTransport()
  await mcpServer.connect(transport)
  return transport.handleRequest(c)
})

app.get("/api/*", async (c) => {
  const rawPath = c.req.path.replace("/api/", "")
  if (!rawPath) {
    throw new HTTPException(400, { message: "Missing documentation URL" })
  }

  const requestUrl = new URL(c.req.url)
  const decodedPath = decodeURIComponent(rawPath)
  const withQuery =
    requestUrl.search && !decodedPath.includes("?") ? `${decodedPath}${requestUrl.search}` : decodedPath
  const normalizedInput = withQuery.startsWith("http") ? withQuery : `https://${withQuery}`
  const targetUrl = encodeURI(normalizedInput)

  const { markdown, url } = await fetchDocumentationMarkdown({ baseUrl: targetUrl })

  if (!markdown || markdown.trim().length < 100) {
    throw new HTTPException(502, {
      message: "The documentation page loaded but contained insufficient content.",
    })
  }

  const headers = {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Location": url,
    "Cache-Control": "public, max-age=3600, s-maxage=86400",
    ETag: `"${Buffer.from(markdown).toString("base64").slice(0, 16)}"`,
    "Last-Modified": new Date().toUTCString(),
  }

  if (c.req.header("Accept")?.includes("application/json")) {
    return c.json(
      {
        url,
        content: markdown,
      },
      200,
      { ...headers, "Content-Type": "application/json; charset=utf-8" },
    )
  }

  return c.text(markdown, 200, headers)
})

app.get("/api/search/*", async (c) => {
  const rawPath = c.req.path.replace("/api/search/", "")
  if (!rawPath) {
    throw new HTTPException(400, { message: "Missing documentation URL" })
  }

  const query = c.req.query("q")?.trim() ?? ""
  if (!query) {
    throw new HTTPException(400, { message: "Missing search query" })
  }

  const requestUrl = new URL(c.req.url)
  const decodedPath = decodeURIComponent(rawPath)
  const withQuery =
    requestUrl.search && !decodedPath.includes("?") ? `${decodedPath}${requestUrl.search}` : decodedPath
  const normalizedInput = withQuery.startsWith("http") ? withQuery : `https://${withQuery}`
  const targetUrl = encodeURI(normalizedInput)

  const { searchDocumentation } = await import("./lib/docset/search")
  const results = await searchDocumentation(targetUrl, query)

  return c.json(
    {
      query,
      results,
    },
    200,
    { "Content-Type": "application/json; charset=utf-8" },
  )
})

// Catch-all route for any other requests - returns 404
app.all("*", (c) => {
  return c.text(
    `# Not Found

The requested resource was not found on this server.

Use the API routes instead:
- \`/api/https://docs.example.com/path\`
- \`/api/search/https://docs.example.com?q=search\`

---
*[docsapi](https://docsapi.xo.vg) - Documentation for LLMs*`,
    404,
    { "Content-Type": "text/markdown; charset=utf-8" },
  )
})

app.onError((err, c) => {
  console.error("Error occurred:", err)

  if (err instanceof HTTPException) {
    // Get the custom response
    return err.getResponse()
  }

  if (err instanceof NotFoundError) {
    const accept = c.req.header("Accept")
    if (accept?.includes("application/json")) {
      return c.json(
        {
          error: "Documentation not found",
          message: "The requested documentation page does not exist.",
        },
        404,
      )
    }

    return c.text(
      `# Not Found

The requested documentation page does not exist.

## What you can try:

1. **Check the URL** - Make sure the path is correct
2. **Browse from a parent page** - Try starting from a higher-level documentation page

---
*[docsapi](https://docsapi.xo.vg) - Documentation for LLMs*`,
      404,
      { "Content-Type": "text/markdown; charset=utf-8" },
    )
  }

  // Handle unexpected errors
  const accept = c.req.header("Accept")
  if (accept?.includes("application/json")) {
    return c.json(
      {
        error: "Service temporarily unavailable",
        message:
          "We encountered an unexpected issue while processing your request. Please try again in a few moments.",
      },
      500,
    )
  }

  return c.text(
    `# Service Temporarily Unavailable

We encountered an unexpected issue while processing your request.

## What you can try:

1. **Wait a moment and try again** - This is often a temporary issue
2. **Check the URL** - Make sure you're using a valid documentation URL
3. **Try a different page** - Some pages may have temporary issues

If this issue persists, please report it to <info@sosumi.ai>.

---
*[docsapi](https://docsapi.xo.vg) - Documentation for LLMs*`,
    500,
    { "Content-Type": "text/markdown; charset=utf-8" },
  )
})

export default app
