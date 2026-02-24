import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { fetchDocumentationMarkdown } from "./docset"
import { docsetTypes } from "./docset/types"
import { searchDocumentationWithDiagnostics } from "./docset/search"
import { fetchHIGPageData, renderHIGFromJSON } from "./hig"
import {
  findLocalDocByUrl,
  findLocalDoc,
  hasLocalSlug,
  listLocalSlugs,
  loadLocalSiteIndex,
  readLocalDocContent,
  searchLocalDocumentation,
} from "./local-docs"
import { fetchJSONData, renderFromJSON } from "./reference"
import { searchAppleDeveloperDocs } from "./search"
import { generateAppleDocUrl, normalizeDocumentationPath } from "./url"

const MCP_TOOL_TIMEOUT_MS = 20000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise
      .then((value) => {
        clearTimeout(timeoutId)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

function isApplePath(value: string): boolean {
  return (
    value.includes("design/human-interface-guidelines") ||
    value.startsWith("/documentation/") ||
    value.startsWith("documentation/")
  )
}

function extractApplePathFromUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.hostname !== "developer.apple.com") return null
    return parsed.pathname
  } catch {
    return null
  }
}

function isLikelyUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function createMcpServer() {
  const server = new McpServer({
    name: "docsapi",
    version: "1.0.0",
  })

  // Register doc://{url} resource template (supports any docset with auto-detect)
  server.registerResource(
    "documentation",
    new ResourceTemplate("doc://{url}", { list: undefined }),
    {
      title: "Documentation",
      description: "Documentation content from a full URL, rendered as Markdown",
    },
    async (uri, { url }) => {
      try {
        const decodedUrl = decodeURIComponent(url.toString())
        const targetUrl = decodedUrl.startsWith("http") ? decodedUrl : `https://${decodedUrl}`
        const { markdown } = await withTimeout(
          fetchDocumentationMarkdown({ baseUrl: targetUrl }),
          MCP_TOOL_TIMEOUT_MS,
          "MCP resource fetch",
        )

        if (!markdown || markdown.trim().length < 100) {
          throw new Error("Insufficient content in documentation")
        }

        return {
          contents: [
            {
              uri: uri.href,
              text: markdown,
              mimeType: "text/markdown",
            },
          ],
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        return {
          contents: [
            {
              uri: uri.href,
              text: `Error fetching content: ${errorMessage}`,
              mimeType: "text/plain",
            },
          ],
        }
      }
    },
  )

  server.registerTool(
    "fetchDocs",
    {
      title: "Fetch Docs",
      description:
        "Intelligently fetch docs from local cache, Apple docs, or online doc sites based on provided inputs.",
      inputSchema: {
        source: z.string().optional().describe("Optional source slug or source URL."),
        baseUrl: z.string().optional().describe("Base URL for online docs (e.g., 'https://docs.example.com')."),
        slug: z
          .string()
          .optional()
          .describe("Local docs slug under ./local/{slug}."),
        docId: z.string().optional().describe("Document ID from site-index.json (e.g., 'doc-00042')."),
        url: z.string().optional().describe("Doc URL for online fetch or local match."),
        path: z
          .string()
          .optional()
          .describe(
            "Doc path for apple/online fetch or local match (e.g., '/documentation/swift' or '/guide/intro').",
          ),
        title: z.string().optional().describe("Title (exact or contains match)."),
        docsetType: z
          .enum(docsetTypes)
          .optional()
          .describe("Optional online docset hint (e.g., 'docusaurus', 'mkdocs', 'sphinx')."),
      },
      outputSchema: {
        source: z.enum(["local", "apple", "online"]),
        slug: z.string(),
        baseUrl: z.string(),
        url: z.string().optional(),
        docsetType: z.string().optional(),
        doc: z
          .object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
            path: z.string(),
            docsetType: z.string(),
            contentFile: z.string(),
            indexFile: z.string(),
          })
          .optional(),
        markdown: z.string().optional(),
        suggestions: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              path: z.string(),
              url: z.string(),
            }),
          )
          .optional(),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ source, baseUrl, slug, docId, url, path, title, docsetType }) => {
      const sourceHint = source?.trim()
      const sourceSlug = sourceHint && !isLikelyUrl(sourceHint) ? sourceHint : undefined
      const sourceUrl = sourceHint && isLikelyUrl(sourceHint) ? sourceHint : undefined
      const localSlugHint = slug?.trim() || sourceSlug
      const localUrlHint = url || sourceUrl
      try {
        if (localSlugHint && (await hasLocalSlug(localSlugHint))) {
          const { slug: resolvedSlug, siteIndex } = await loadLocalSiteIndex({ slug: localSlugHint })
          const selectorProvided = Boolean(docId || url || path || title)
          const { doc, suggestions } = findLocalDoc(siteIndex.docs, { docId, url, path, title })

          if (!selectorProvided) {
            const top = siteIndex.docs.slice(0, 10)
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "No selector was provided. Pass one of docId, url, path, or title.\n\n" +
                    top.map((entry) => `- ${entry.id}: ${entry.title} (${entry.path})`).join("\n"),
                },
              ],
              structuredContent: {
                source: "local" as const,
                slug: resolvedSlug,
                baseUrl: siteIndex.baseUrl,
                suggestions: top.map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  path: entry.path,
                  url: entry.url,
                })),
              },
            }
          }

          if (doc) {
            const markdown = await withTimeout(
              readLocalDocContent(resolvedSlug, doc.contentFile),
              MCP_TOOL_TIMEOUT_MS,
              "Local documentation fetch",
            )

            return {
              content: [
                {
                  type: "text" as const,
                  text: markdown,
                },
              ],
              structuredContent: {
                source: "local" as const,
                slug: resolvedSlug,
                baseUrl: siteIndex.baseUrl,
                url: doc.url,
                docsetType: doc.docsetType,
                doc: {
                  id: doc.id,
                  title: doc.title,
                  url: doc.url,
                  path: doc.path,
                  docsetType: doc.docsetType,
                  contentFile: doc.contentFile,
                  indexFile: doc.indexFile,
                },
                markdown,
                suggestions: suggestions.map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  path: entry.path,
                  url: entry.url,
                })),
              },
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: "No matching local document found.",
              },
            ],
            structuredContent: {
              source: "local" as const,
              slug: localSlugHint,
              baseUrl: siteIndex.baseUrl,
              suggestions: suggestions.map((entry) => ({
                id: entry.id,
                title: entry.title,
                path: entry.path,
                url: entry.url,
              })),
              error: "No matching local document found.",
            },
          }
        }

        if (localUrlHint) {
          const localMatch = await findLocalDocByUrl(localUrlHint)
          if (localMatch) {
            const markdown = await withTimeout(
              readLocalDocContent(localMatch.slug, localMatch.doc.contentFile),
              MCP_TOOL_TIMEOUT_MS,
              "Local documentation fetch",
            )
            return {
              content: [{ type: "text" as const, text: markdown }],
              structuredContent: {
                source: "local" as const,
                slug: localMatch.slug,
                baseUrl: localMatch.siteIndex.baseUrl,
                url: localMatch.doc.url,
                docsetType: localMatch.doc.docsetType,
                doc: {
                  id: localMatch.doc.id,
                  title: localMatch.doc.title,
                  url: localMatch.doc.url,
                  path: localMatch.doc.path,
                  docsetType: localMatch.doc.docsetType,
                  contentFile: localMatch.doc.contentFile,
                  indexFile: localMatch.doc.indexFile,
                },
                markdown,
              },
            }
          }
        }

        const applePathFromUrl = extractApplePathFromUrl(url || sourceUrl || baseUrl || "")
        const maybeApplePath = path || applePathFromUrl
        const shouldUseApple = Boolean(applePathFromUrl || (maybeApplePath && isApplePath(maybeApplePath)))

        if (shouldUseApple && maybeApplePath) {
          if (maybeApplePath.includes("design/human-interface-guidelines")) {
            const higPath = maybeApplePath.replace(/^\/?(design\/human-interface-guidelines\/)/, "")
            const sourceUrl = `https://developer.apple.com/design/human-interface-guidelines/${higPath}`

            const jsonData = await withTimeout(fetchHIGPageData(higPath), MCP_TOOL_TIMEOUT_MS, "Apple HIG fetch")
            const markdown = await withTimeout(renderHIGFromJSON(jsonData, sourceUrl), MCP_TOOL_TIMEOUT_MS, "Apple HIG render")
            if (!markdown || markdown.trim().length < 100) {
              throw new Error("Insufficient content in Apple HIG page")
            }

            return {
              content: [{ type: "text" as const, text: markdown }],
              structuredContent: {
                source: "apple" as const,
                slug: "",
                baseUrl: "https://developer.apple.com",
                url: sourceUrl,
                docsetType: "apple",
                markdown,
              },
            }
          }

          const normalizedPath = normalizeDocumentationPath(maybeApplePath)
          const appleUrl = generateAppleDocUrl(normalizedPath)
          const jsonData = await withTimeout(fetchJSONData(normalizedPath), MCP_TOOL_TIMEOUT_MS, "Apple docs fetch")
          const markdown = await withTimeout(renderFromJSON(jsonData, appleUrl), MCP_TOOL_TIMEOUT_MS, "Apple docs render")
          if (!markdown || markdown.trim().length < 100) {
            throw new Error("Insufficient content in Apple documentation")
          }

          return {
            content: [{ type: "text" as const, text: markdown }],
            structuredContent: {
              source: "apple" as const,
              slug: "",
              baseUrl: "https://developer.apple.com",
              url: appleUrl,
              docsetType: "apple",
              markdown,
            },
          }
        }

        const onlineBaseUrl = baseUrl || sourceUrl || url
        if (!onlineBaseUrl) {
          throw new Error(
            "Unable to resolve source. Provide a local slug/URL, an Apple docs URL/path, or an online base URL.",
          )
        }

        const {
          markdown,
          url: resolvedUrl,
          docsetType: resolvedType,
        } = await withTimeout(
          fetchDocumentationMarkdown({
            baseUrl: onlineBaseUrl,
            path,
            docsetType,
          }),
          MCP_TOOL_TIMEOUT_MS,
          "Online documentation fetch",
        )
        if (!markdown || markdown.trim().length < 100) {
          throw new Error("Insufficient content in online documentation")
        }

        return {
          content: [{ type: "text" as const, text: markdown }],
          structuredContent: {
            source: "online" as const,
            slug: "",
            baseUrl: onlineBaseUrl,
            url: resolvedUrl,
            docsetType: resolvedType,
            markdown,
          },
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        return {
          content: [
            {
              type: "text" as const,
              text: `Error reading local documentation: ${errorMessage}`,
            },
          ],
          structuredContent: {
            source: "online",
            slug: localSlugHint ?? "",
            baseUrl: baseUrl ?? "",
            url: url ?? undefined,
            docsetType: docsetType ?? undefined,
            error: errorMessage,
          },
        }
      }
    },
  )

  server.registerTool(
    "listDocs",
    {
      title: "List Local Documentation",
      description: "List all available local documentation slugs and per-slug document counts.",
      inputSchema: {},
      outputSchema: {
        slugs: z.array(
          z.object({
            slug: z.string(),
            baseUrl: z.string(),
            totalDocs: z.number(),
          }),
        ),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const slugs = await listLocalSlugs()

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Found ${slugs.length} local documentation slug(s)\n\n` +
                slugs.map((entry) => `- ${entry.slug}: ${entry.totalDocs} docs`).join("\n"),
            },
          ],
          structuredContent: {
            slugs,
          },
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing local documentation: ${errorMessage}`,
            },
          ],
          structuredContent: {
            slugs: [],
            error: errorMessage,
          },
        }
      }
    },
  )

  server.registerTool(
    "searchDocs",
    {
      title: "Search Docs",
      description:
        "Search docs using source routing: local for known slug/URL, Apple for developer.apple.com URLs, otherwise online.",
      inputSchema: {
        query: z.string().describe("Search query"),
        source: z.string().optional().describe("Optional source slug or source URL."),
        slug: z
          .string()
          .optional()
          .describe("Optional slug filter. If omitted, searches across all available slugs."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum number of results to return (default: 50)."),
      },
      outputSchema: {
        source: z.enum(["local", "apple", "online"]),
        query: z.string(),
        totalResults: z.number(),
        searchedSlugs: z.array(z.string()),
        results: z.array(
          z.object({
            slug: z.string().optional(),
            title: z.string(),
            url: z.string(),
            snippet: z.string(),
            score: z.number().optional(),
          }),
        ),
        error: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, source, slug, limit }) => {
      const sourceHint = source?.trim()
      const sourceSlug = sourceHint && !isLikelyUrl(sourceHint) ? sourceHint : undefined
      const sourceUrl = sourceHint && isLikelyUrl(sourceHint) ? sourceHint : undefined
      const slugHint = slug?.trim() || sourceSlug
      try {
        if (slugHint && (await hasLocalSlug(slugHint))) {
          const payload = await searchLocalDocumentation({ query, slug: slugHint, limit })
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Found ${payload.totalResults} local match(es) for "${query}" in ${slugHint}\n\n` +
                  payload.results
                    .map((entry, index) => `${index + 1}. [${entry.slug}] ${entry.title}\n   ${entry.url}\n   ${entry.snippet}`)
                    .join("\n\n"),
              },
            ],
            structuredContent: {
              source: "local" as const,
              query: payload.query,
              totalResults: payload.totalResults,
              searchedSlugs: payload.searchedSlugs,
              results: payload.results.map((entry) => ({
                slug: entry.slug,
                title: entry.title,
                url: entry.url,
                snippet: entry.snippet,
                score: entry.score,
              })),
            },
          }
        }

        if (sourceUrl) {
          const localByUrl = await findLocalDocByUrl(sourceUrl)
          if (localByUrl) {
            const payload = await searchLocalDocumentation({ query, slug: localByUrl.slug, limit })
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Found ${payload.totalResults} local match(es) for "${query}" in ${localByUrl.slug}\n\n` +
                    payload.results
                      .map((entry, index) => `${index + 1}. [${entry.slug}] ${entry.title}\n   ${entry.url}\n   ${entry.snippet}`)
                      .join("\n\n"),
                },
              ],
              structuredContent: {
                source: "local" as const,
                query: payload.query,
                totalResults: payload.totalResults,
                searchedSlugs: payload.searchedSlugs,
                results: payload.results.map((entry) => ({
                  slug: entry.slug,
                  title: entry.title,
                  url: entry.url,
                  snippet: entry.snippet,
                  score: entry.score,
                })),
              },
            }
          }
        }

        const applePath = extractApplePathFromUrl(sourceUrl || "")
        if (applePath) {
          const payload = await withTimeout(searchAppleDeveloperDocs(query), MCP_TOOL_TIMEOUT_MS, "Apple docs search")
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Found ${payload.results.length} Apple match(es) for "${query}"\n\n` +
                  payload.results
                    .map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}\n   ${entry.description || ""}`)
                    .join("\n\n"),
              },
            ],
            structuredContent: {
              source: "apple" as const,
              query: payload.query,
              totalResults: payload.results.length,
              searchedSlugs: [],
              results: payload.results.map((entry) => ({
                title: entry.title,
                url: entry.url,
                snippet: entry.description || "",
              })),
            },
          }
        }

        if (!sourceUrl) {
          const payload = await searchLocalDocumentation({ query, slug: slugHint, limit })
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Found ${payload.totalResults} local match(es) for "${query}" across ${payload.searchedSlugs.length} slug(s)\n\n` +
                  payload.results
                    .map((entry, index) => `${index + 1}. [${entry.slug}] ${entry.title}\n   ${entry.url}\n   ${entry.snippet}`)
                    .join("\n\n"),
              },
            ],
            structuredContent: {
              source: "local" as const,
              query: payload.query,
              totalResults: payload.totalResults,
              searchedSlugs: payload.searchedSlugs,
              results: payload.results.map((entry) => ({
                slug: entry.slug,
                title: entry.title,
                url: entry.url,
                snippet: entry.snippet,
                score: entry.score,
              })),
            },
          }
        }

        const { results, diagnostics } = await withTimeout(
          searchDocumentationWithDiagnostics(sourceUrl, query),
          MCP_TOOL_TIMEOUT_MS,
          "Online docs search",
        )
        const noFetchedSources = diagnostics.fetchedSourceUrls.length === 0
        const noParsedSources = diagnostics.parsedSourceUrls.length === 0
        const message =
          results.length === 0
            ? noFetchedSources
              ? `No results: no searchable index/sitemap was found for "${sourceUrl}".`
              : noParsedSources
                ? "No results: a search source was fetched but could not be parsed."
                : `No results found for "${query}" (search index/sitemap was available).`
            : `Found ${results.length} online result(s) for "${query}".`

        return {
          content: [
            {
              type: "text" as const,
              text:
                message +
                (results.length
                  ? `\n\n${results
                      .map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}\n   ${entry.snippet}`)
                      .join("\n\n")}`
                  : ""),
            },
          ],
          structuredContent: {
            source: "online" as const,
            query,
            totalResults: results.length,
            searchedSlugs: [],
            results: results.map((entry) => ({
              title: entry.title,
              url: entry.url,
              snippet: entry.snippet,
            })),
          },
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching local documentation: ${errorMessage}`,
            },
          ],
          structuredContent: {
            source: "local",
            query,
            totalResults: 0,
            searchedSlugs: slugHint ? [slugHint] : [],
            results: [],
            error: errorMessage,
          },
        }
      }
    },
  )

  return server
}
