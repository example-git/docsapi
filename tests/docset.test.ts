import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchDocumentationMarkdown } from "../src/lib/docset"
import { detectDocsetType } from "../src/lib/docset/detect"
import { extractDocContent } from "../src/lib/docset/extract"
import { htmlToMarkdown } from "../src/lib/docset/markdown"
import { searchDocumentation, searchDocumentationWithDiagnostics } from "../src/lib/docset/search"

describe("Docset Helpers", () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("detects common docset generators", () => {
    expect(detectDocsetType('<meta name="generator" content="Docusaurus" />', "https://x")).toBe(
      "docusaurus",
    )
    expect(detectDocsetType('<meta name="generator" content="MkDocs" />', "https://x")).toBe(
      "mkdocs",
    )
    expect(detectDocsetType('<meta name="generator" content="Sphinx" />', "https://x")).toBe(
      "sphinx",
    )
    expect(
      detectDocsetType('<script src="_static/documentation_options.js"></script>', "https://x"),
    ).toBe("sphinx")
    expect(detectDocsetType('<meta name="generator" content="TypeDoc" />', "https://x")).toBe(
      "typedoc",
    )
    expect(detectDocsetType('<meta name="generator" content="JSDoc 3" />', "https://x")).toBe(
      "jsdoc",
    )
    expect(detectDocsetType('<meta name="generator" content="rustdoc" />', "https://x")).toBe(
      "rustdoc",
    )
    expect(detectDocsetType("<html></html>", "https://pkg.go.dev/foo")).toBe("godoc")
    expect(detectDocsetType('<meta name="generator" content="pdoc" />', "https://x")).toBe("pdoc")
    expect(detectDocsetType("<main>hello</main>", "https://x")).toBe("generic")
  })

  it("extracts primary content and strips nav elements", () => {
    const html = `
      <html>
        <head><title>Guide</title></head>
        <body>
          <nav>ignore me</nav>
          <main>
            <article>
              <h1>Intro</h1>
              <p>Welcome to the docs.</p>
            </article>
          </main>
        </body>
      </html>
    `

    const { title, contentHtml } = extractDocContent(html, "generic")
    expect(title).toBe("Intro")
    expect(contentHtml).toContain("Welcome to the docs.")
    expect(contentHtml).not.toContain("ignore me")
  })

  it("converts HTML to Markdown", () => {
    const markdown = htmlToMarkdown("<h1>Title</h1><p>Hello <code>world</code>.</p>")
    expect(markdown).toContain("# Title")
    expect(markdown).toContain("Hello `world`.")
  })

  it("does not throw when converting malformed HTML", () => {
    expect(() => htmlToMarkdown("<table><tr></tr></table>")).not.toThrow()
  })

  it("fetches docs and renders markdown from a base URL", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        `
          <html>
            <head><title>Example</title></head>
            <body>
              <main>
                <article>
                  <h1>Example</h1>
                  <p>Doc content.</p>
                </article>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    )

    const result = await fetchDocumentationMarkdown({
      baseUrl: "https://docs.example.com",
      path: "/guide/intro",
    })

    expect(result.url).toBe("https://docs.example.com/guide/intro")
    expect(result.markdown).toContain("# Example")
    expect(result.markdown).toContain("Doc content.")
    expect(result.docsetType).toBe("generic")
    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.example.com/guide/intro",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "text/html",
          "User-Agent": expect.any(String),
        }),
      }),
    )
  })

  it("strips .html from inputs and resolves subpage bases", async () => {
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          `
            <html>
              <head><title>Asyncio</title></head>
              <body>
                <main>
                  <article>
                    <h1>Asyncio</h1>
                    <p>Task docs.</p>
                  </article>
                </main>
              </body>
            </html>
          `,
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
      ),
    )

    const result = await fetchDocumentationMarkdown({
      baseUrl: "https://docs.python.org/3/library/asyncio.html",
    })

    expect(result.url).toBe("https://docs.python.org/3/library/asyncio")
    expect(result.markdown).toContain("# Asyncio")
    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.python.org/3/library/asyncio",
      expect.any(Object),
    )

    await fetchDocumentationMarkdown({
      baseUrl: "https://docs.python.org/3/library/asyncio.html",
      path: "subtasks.html",
    })

    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.python.org/3/library/subtasks",
      expect.any(Object),
    )
  })

  it("treats leading-slash paths as doc-root relative for versioned subpaths", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        `
          <html>
            <head><title>Intro</title></head>
            <body>
              <main>
                <article>
                  <h1>Intro</h1>
                  <p>Welcome.</p>
                </article>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    )

    const result = await fetchDocumentationMarkdown({
      baseUrl: "https://docs.example.com/en/stable/",
      path: "/guide/intro",
    })

    expect(result.url).toBe("https://docs.example.com/en/stable/guide/intro")
    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.example.com/en/stable/guide/intro",
      expect.any(Object),
    )
  })

  it("strips hash fragments but preserves glossary.html", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        `
          <html>
            <head><title>Glossary</title></head>
            <body>
              <main>
                <article>
                  <h1>Glossary</h1>
                  <p>Definitions.</p>
                </article>
              </main>
            </body>
          </html>
        `,
        { status: 200, headers: { "Content-Type": "text/html" } },
      ),
    )

    const result = await fetchDocumentationMarkdown({
      baseUrl: "https://docs.example.com/guide/glossary.html#terms",
    })

    expect(result.url).toBe("https://docs.example.com/guide/glossary.html")
    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.example.com/guide/glossary.html",
      expect.any(Object),
    )
  })

  it("searches mkdocs-style search index", async () => {
    const index = {
      docs: [
        { title: "Intro", text: "Welcome to the guide", location: "/intro/" },
        { title: "Install", text: "Setup steps", location: "/install/" },
      ],
    }

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(index), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const results = await searchDocumentation("https://docs.example.com", "install", "mkdocs")
    expect(results.length).toBe(1)
    expect(results[0].title).toBe("Install")
    expect(results[0].url).toBe("https://docs.example.com/install/")
  })

  it("searches mkdocs index under versioned subpaths", async () => {
    const index = {
      docs: [{ title: "Intro", text: "Welcome", location: "intro/" }],
    }

    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(index), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    await searchDocumentation(
      "https://docs.example.com/en/stable/reference/foo/",
      "intro",
      "mkdocs",
    )

    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.example.com/en/stable/search/search_index.json",
      expect.any(Object),
    )
  })

  it("searches sphinx indexes and derives the doc root from deep URLs", async () => {
    const sphinxIndex = `Search.setIndex({"docnames":["intro","api"],"filenames":["intro.html","api.html"],"titles":["Intro","API Reference"],"terms":{"alpha":[0],"beta":[[1,2]]}})`

    global.fetch = vi.fn().mockImplementation((url) => {
      const urlString = String(url)
      if (urlString.endsWith("searchindex.js")) {
        return Promise.resolve(
          new Response(sphinxIndex, {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
        )
      }
      return Promise.resolve(new Response("Not found", { status: 404, statusText: "Not Found" }))
    })

    const results = await searchDocumentation(
      "https://docs.example.com/en/stable/reference/foo/",
      "alpha",
      "sphinx",
    )

    expect(global.fetch).toHaveBeenCalledWith(
      "https://docs.example.com/en/stable/searchindex.js",
      expect.any(Object),
    )
    expect(results.length).toBe(1)
    expect(results[0].url).toBe("https://docs.example.com/en/stable/intro.html")
  })

  it("falls back to sitemap.xml search", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("no index"))
      .mockRejectedValueOnce(new Error("no index"))
      .mockRejectedValueOnce(new Error("no index"))
      .mockRejectedValueOnce(new Error("no index"))
      .mockRejectedValueOnce(new Error("no index"))
      .mockResolvedValueOnce(
        new Response(
          `<?xml version="1.0"?>
          <urlset>
            <url><loc>https://docs.example.com/guide/intro</loc></url>
            <url><loc>https://docs.example.com/guide/install</loc></url>
          </urlset>`,
          { status: 200, headers: { "Content-Type": "application/xml" } },
        ),
      )

    const results = await searchDocumentation("https://docs.example.com", "intro")
    expect(results.length).toBe(1)
    expect(results[0].url).toBe("https://docs.example.com/guide/intro")
  })

  it("returns diagnostics when no searchable sources exist", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Nope", { status: 404, statusText: "Not Found" }))

    const { results, diagnostics } = await searchDocumentationWithDiagnostics(
      "https://docs.example.com/no-index/",
      "anything",
    )

    expect(results.length).toBe(0)
    expect(diagnostics.fetchedSourceUrls.length).toBe(0)
    expect(diagnostics.parsedSourceUrls.length).toBe(0)
  })

  it("returns diagnostics when sources are fetched but unparsable", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      const urlString = String(url)
      if (urlString.endsWith("search/search_index.json")) {
        return Promise.resolve(
          new Response("not json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
      }
      return Promise.resolve(new Response("Nope", { status: 404, statusText: "Not Found" }))
    })

    const { results, diagnostics } = await searchDocumentationWithDiagnostics(
      "https://docs.example.com/",
      "anything",
      "mkdocs",
    )

    expect(results.length).toBe(0)
    expect(diagnostics.fetchedSourceUrls.length).toBeGreaterThan(0)
    expect(diagnostics.parsedSourceUrls.length).toBe(0)
    expect(diagnostics.parseErrors.length).toBeGreaterThan(0)
  })
})
