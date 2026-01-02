import { getRandomUserAgent } from "../fetch"
import { fetchHIGPageData, renderHIGFromJSON } from "../hig"
import { fetchJSONData, renderFromJSON } from "../reference"
import { generateAppleDocUrl, normalizeDocumentationPath } from "../url"
import { detectDocsetType } from "./detect"
import { extractDocContent } from "./extract"
import { htmlToMarkdown } from "./markdown"
import type { DocsetRequest, DocsetType } from "./types"

function isAppleHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.endsWith("developer.apple.com") || parsed.hostname === "sosumi.ai"
  } catch {
    return false
  }
}

function isHigPath(pathname: string): boolean {
  return pathname.includes("design/human-interface-guidelines")
}

function resolveTargetUrl(baseUrl: string, path?: string): string {
  const trimmedBase = baseUrl.trim()
  if (!trimmedBase) {
    throw new Error("baseUrl is required")
  }

  const trimmedPath = path?.trim()
  if (trimmedPath && /^https?:\/\//i.test(trimmedPath)) {
    return trimmedPath
  }

  const baseWithScheme = /^https?:\/\//i.test(trimmedBase) ? trimmedBase : `https://${trimmedBase}`
  const parsedBase = new URL(baseWithScheme)
  const basePath = parsedBase.pathname
  const looksLikeFile = /\.[a-z0-9]+$/i.test(basePath)
  const baseDir = basePath.endsWith("/")
    ? basePath
    : looksLikeFile
      ? basePath.slice(0, basePath.lastIndexOf("/") + 1)
      : `${basePath}/`

  if (!trimmedPath) {
    return parsedBase.toString()
  }

  const baseForResolve = new URL(baseDir, parsedBase.origin)
  return new URL(trimmedPath, baseForResolve).toString()
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": getRandomUserAgent(),
      Accept: "text/html",
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch HTML: ${response.status} ${response.statusText}`)
  }

  return await response.text()
}

export async function fetchDocumentationMarkdown(
  request: DocsetRequest,
): Promise<{ markdown: string; url: string; docsetType: DocsetType }> {
  const resolvedUrl = resolveTargetUrl(request.baseUrl, request.path)
  const targetUrl = stripHtmlExtension(resolvedUrl)
  const isApple = request.docsetType === "apple" || isAppleHost(targetUrl)

  if (isApple) {
    const parsedUrl = new URL(targetUrl)
    const pathname = parsedUrl.pathname

    if (isHigPath(pathname)) {
      const higPath = pathname.replace(/^\/?(design\/human-interface-guidelines\/)/, "")
      const sourceUrl = `https://developer.apple.com/design/human-interface-guidelines/${higPath}`
      const jsonData = await fetchHIGPageData(higPath)
      const markdown = await renderHIGFromJSON(jsonData, sourceUrl)

      return { markdown, url: sourceUrl, docsetType: "apple" }
    }

    const normalizedPath = normalizeDocumentationPath(pathname)
    const appleUrl = generateAppleDocUrl(normalizedPath)
    const jsonData = await fetchJSONData(normalizedPath)
    const markdown = await renderFromJSON(jsonData, appleUrl)

    return { markdown, url: appleUrl, docsetType: "apple" }
  }

  let html: string
  let fetchUrl = targetUrl

  try {
    html = await fetchHtml(fetchUrl)
  } catch (error) {
    if (resolvedUrl !== targetUrl) {
      fetchUrl = resolvedUrl
      html = await fetchHtml(fetchUrl)
    } else {
      throw error
    }
  }

  const detected = request.docsetType ?? detectDocsetType(html, fetchUrl)
  const { title, contentHtml } = extractDocContent(html, detected)

  let markdown = htmlToMarkdown(contentHtml)
  let docsetType: DocsetType = detected
  if (!markdown) {
    markdown = htmlToMarkdown(html)
    docsetType = "html"
  }

  if (title && !markdown.startsWith(`# ${title}`)) {
    markdown = `# ${title}\n\n${markdown}`
  }

  return { markdown, url: fetchUrl, docsetType }
}

function stripHtmlExtension(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hash) {
      parsed.hash = ""
    }
    if (parsed.pathname.endsWith("index.html")) {
      parsed.pathname = parsed.pathname.slice(0, -"/index.html".length) || "/"
    } else if (parsed.pathname.endsWith("glossary.html")) {
      // Keep glossary.html as-is for sites that rely on it.
    } else if (parsed.pathname.endsWith(".html")) {
      parsed.pathname = parsed.pathname.slice(0, -".html".length)
    }
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1)
    }
    return parsed.toString()
  } catch {
    return url
  }
}
