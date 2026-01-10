import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { fetchDocumentationMarkdown } from "./docset"
import { searchDocumentationWithDiagnostics } from "./docset/search"
import { docsetTypes } from "./docset/types"
import { fetchHIGPageData, renderHIGFromJSON } from "./hig"
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

  // Register Apple search tool
  server.registerTool(
    "searchAppleDocumentation",
    {
      title: "Search Apple Documentation",
      description: "Search Apple Developer documentation and return structured results",
      inputSchema: {
        query: z.string().describe("Search query for Apple documentation"),
      },
      outputSchema: {
        query: z.string().describe("The search query that was executed"),
        results: z
          .array(
            z.object({
              title: z.string().describe("Title of the documentation page"),
              url: z.string().describe("Full URL to the documentation page"),
              description: z.string().describe("Brief description of the page content"),
              breadcrumbs: z
                .array(z.string())
                .describe("Navigation breadcrumbs showing the page hierarchy"),
              tags: z
                .array(z.string())
                .describe("Tags associated with the page (languages, platforms, etc.)"),
              type: z.string().describe("Type of result (documentation, general, etc.)"),
            }),
          )
          .describe("Array of search results"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      try {
        const searchResponse = await withTimeout(
          searchAppleDeveloperDocs(query),
          MCP_TOOL_TIMEOUT_MS,
          "Apple search",
        )

        const structuredContent = {
          query: searchResponse.query,
          results: searchResponse.results.map((result) => ({
            title: result.title,
            url: result.url,
            description: result.description,
            breadcrumbs: result.breadcrumbs,
            tags: result.tags,
            type: result.type,
          })),
        }

        if (searchResponse.results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No results found for "${query}"`,
              },
            ],
            structuredContent,
          }
        }

        // Provide a readable text summary
        const resultText =
          `Found ${searchResponse.results.length} result(s) for "${query}":\n\n` +
          searchResponse.results
            .map(
              (result, index) =>
                `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.description || "No description"}`,
            )
            .join("\n\n")

        return {
          content: [
            {
              type: "text" as const,
              text: resultText,
            },
          ],
          structuredContent,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"

        const structuredContent = {
          query,
          results: [],
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching Apple Developer documentation: ${errorMessage}`,
            },
          ],
          structuredContent,
        }
      }
    },
  )

  // Register documentation fetch tool (supports both dev docs and HIG)
  server.registerTool(
    "fetchAppleDocumentation",
    {
      title: "Fetch Apple Documentation",
      description:
        "Fetch Apple Developer documentation and Human Interface Guidelines by path and return as markdown",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Documentation path (e.g., '/documentation/swift', 'swiftui/view', 'design/human-interface-guidelines/foundations/color')",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ path }) => {
      try {
        // Check if this is a HIG path
        if (path.includes("design/human-interface-guidelines")) {
          // Handle HIG content
          const higPath = path.replace(/^\/?(design\/human-interface-guidelines\/)/, "")
          const sourceUrl = `https://developer.apple.com/design/human-interface-guidelines/${higPath}`

          const jsonData = await fetchHIGPageData(higPath)
          const markdown = await renderHIGFromJSON(jsonData, sourceUrl)

          if (!markdown || markdown.trim().length < 100) {
            throw new Error("Insufficient content in HIG page")
          }

          return {
            content: [
              {
                type: "text" as const,
                text: markdown,
              },
            ],
          }
        } else {
          // Handle regular developer documentation
          const normalizedPath = normalizeDocumentationPath(path)
          const appleUrl = generateAppleDocUrl(normalizedPath)

          const jsonData = await fetchJSONData(normalizedPath)
          const markdown = await renderFromJSON(jsonData, appleUrl)

          if (!markdown || markdown.trim().length < 100) {
            throw new Error("Insufficient content in documentation")
          }

          return {
            content: [
              {
                type: "text" as const,
                text: markdown,
              },
            ],
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"

        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching content for "${path}": ${errorMessage}`,
            },
          ],
        }
      }
    },
  )

  // Register generic documentation fetch tool with baseUrl support
  server.registerTool(
    "fetchDocumentation",
    {
      title: "Fetch Documentation",
      description:
        "Fetch documentation from a base URL and path, auto-detecting common docset generators",
      inputSchema: {
        baseUrl: z.string().describe("Base documentation URL (e.g., 'https://docs.example.com')"),
        path: z
          .string()
          .optional()
          .describe("Optional path or full URL to a specific doc page (e.g., '/guide/intro')"),
        docsetType: z
          .enum(docsetTypes)
          .optional()
          .describe("Optional docset hint (e.g., 'docusaurus', 'mkdocs', 'sphinx')"),
      },
      outputSchema: {
        url: z.string().describe("Resolved URL that was fetched"),
        docsetType: z.enum(docsetTypes).describe("Detected or provided docset type"),
        markdown: z.string().describe("Documentation content rendered as Markdown"),
        error: z.string().optional().describe("Error message when the fetch fails"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ baseUrl, path, docsetType }) => {
      try {
        const {
          markdown,
          url,
          docsetType: resolvedType,
        } = await withTimeout(
          fetchDocumentationMarkdown({
            baseUrl,
            path,
            docsetType,
          }),
          MCP_TOOL_TIMEOUT_MS,
          "Documentation fetch",
        )

        if (!markdown || markdown.trim().length < 100) {
          throw new Error("Insufficient content in documentation")
        }

        return {
          content: [
            {
              type: "text" as const,
              text: markdown,
            },
          ],
          structuredContent: {
            url,
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
              text: `Error fetching documentation: ${errorMessage}`,
            },
          ],
          structuredContent: {
            url: path ? `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}` : baseUrl,
            docsetType: docsetType ?? "generic",
            markdown: "",
            error: errorMessage,
          },
        }
      }
    },
  )

  server.registerTool(
    "searchDocumentation",
    {
      title: "Search Documentation",
      description: "Basic search across common docset generators using the site's index or sitemap",
      inputSchema: {
        baseUrl: z.string().describe("Base documentation URL (e.g., 'https://docs.example.com')"),
        query: z.string().describe("Search query"),
        docsetType: z
          .enum(docsetTypes)
          .optional()
          .describe("Optional docset hint (e.g., 'mkdocs', 'sphinx')"),
      },
      outputSchema: {
        query: z.string(),
        results: z.array(
          z.object({
            title: z.string(),
            url: z.string(),
            snippet: z.string(),
            source: z.string(),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ baseUrl, query, docsetType }) => {
      try {
        const { results, diagnostics } = await withTimeout(
          searchDocumentationWithDiagnostics(baseUrl, query, docsetType),
          MCP_TOOL_TIMEOUT_MS,
          "Documentation search",
        )

        const noFetchedSources = diagnostics.fetchedSourceUrls.length === 0
        const noParsedSources = diagnostics.parsedSourceUrls.length === 0

        const message =
          results.length === 0
            ? noFetchedSources
              ? `No results: no searchable index/sitemap was found for "${baseUrl}".`
              : noParsedSources
                ? "No results: a search source was fetched but could not be parsed."
                : `No results found for "${query}" (search index/sitemap was available).`
            : `Found ${results.length} result(s) for "${query}".`

        return {
          content: [
            {
              type: "text" as const,
              text: message,
            },
          ],
          structuredContent: {
            query,
            results,
          },
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching documentation: ${errorMessage}`,
            },
          ],
          structuredContent: {
            query,
            results: [],
          },
        }
      }
    },
  )

  return server
}
