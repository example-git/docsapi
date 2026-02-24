import { describe, expect, it } from "vitest"
import { parseLinksFromHtml, parseSearchIndexUrls, parseSitemapUrls } from "../src/lib/docset/preload"
import {
  buildPreloadBundle,
  buildPreloadTargets,
  normalizeMaxPages,
  parsePreloadPaths,
  toJsonl,
} from "../src/lib/preload"

describe("Preload helpers", () => {
  it("parses paths from newline and comma lists", () => {
    const paths = parsePreloadPaths("guide/intro\n/guide/install, https://docs.example.com/api")
    expect(paths).toEqual(["/guide/intro", "/guide/install", "https://docs.example.com/api"])
  })

  it("builds deduped targets with base and max limit", () => {
    const targets = buildPreloadTargets({
      includeBase: true,
      maxPages: 3,
      paths: ["/a", "/a", "/b", "/c"],
    })

    expect(targets).toEqual(["", "/a", "/b"])
  })

  it("clamps max pages", () => {
    expect(normalizeMaxPages(0)).toBe(1)
    expect(normalizeMaxPages(9999)).toBe(2000)
    expect(normalizeMaxPages(Number.NaN)).toBe(200)
  })

  it("serializes JSONL", () => {
    const bundle = buildPreloadBundle("https://docs.example.com", [
      { path: "/x", url: "https://docs.example.com/x", docsetType: "generic", content: "# X" },
      { path: "/y", url: "https://docs.example.com/y", docsetType: "mkdocs", content: "# Y" },
    ])
    const jsonl = toJsonl(bundle)

    const lines = jsonl.split("\n")
    expect(lines.length).toBe(5)
    expect(lines[0]).toContain('"type":"site_index"')
    expect(lines[1]).toContain('"type":"doc"')
    expect(lines[3]).toContain('"type":"doc_index"')
  })

  it("builds site and per-doc indexes with descriptions and links", () => {
    const bundle = buildPreloadBundle("https://docs.example.com", [
      {
        path: "/guide/start",
        url: "https://docs.example.com/guide/start",
        docsetType: "generic",
        content: "# Getting Started\n\nLearn how to begin.\n\nSee [API](https://docs.example.com/api).",
      },
      {
        path: "/api",
        url: "https://docs.example.com/api",
        docsetType: "generic",
        content: "# API\n\nAPI reference docs.",
      },
    ])

    expect(bundle.siteIndex.totalDocs).toBe(2)
    expect(bundle.siteIndex.docs[0].title).toBe("API")
    expect(bundle.siteIndex.docs[1].description).toBe("Learn how to begin.")
    const guide = bundle.siteIndex.docs.find((doc) => doc.path === "/guide/start")
    expect(guide).toBeDefined()
    const guideIndex = bundle.docIndexes[guide?.id || ""]
    expect(guideIndex.headings[0].text).toBe("Getting Started")
    expect(guideIndex.links[0].url).toBe("https://docs.example.com/api")
    expect(guideIndex.links[0].localDocId).toBeDefined()
  })
})

describe("Discovery parsers", () => {
  it("extracts links from html", () => {
    const html = `
      <a href="/guide/">Guide</a>
      <a href="https://docs.example.com/api/">API</a>
      <a href="#fragment">Skip</a>
    `

    const urls = parseLinksFromHtml(html, "https://docs.example.com/start/")
    expect(urls).toEqual(["https://docs.example.com/guide/", "https://docs.example.com/api/"])
  })

  it("extracts urls from sitemap xml", () => {
    const xml = `
      <urlset>
        <url><loc>https://docs.example.com/guide/</loc></url>
        <url><loc>/api/</loc></url>
      </urlset>
    `
    const urls = parseSitemapUrls(xml, "https://docs.example.com/sitemap.xml")
    expect(urls).toEqual(["https://docs.example.com/guide/", "https://docs.example.com/api/"])
  })

  it("extracts urls from mkdocs and sphinx indexes", () => {
    const mkdocsRaw = JSON.stringify({
      docs: [{ location: "/guide/" }, { url: "/api/" }],
      urls: ["/extra/"],
    })
    const mkdocsUrls = parseSearchIndexUrls(mkdocsRaw, "https://docs.example.com/")
    expect(mkdocsUrls).toEqual([
      "https://docs.example.com/guide/",
      "https://docs.example.com/api/",
      "https://docs.example.com/extra/",
    ])

    const sphinxRaw = `Search.setIndex({"docnames":["intro"],"filenames":["api.html"]})`
    const sphinxUrls = parseSearchIndexUrls(sphinxRaw, "https://docs.example.com/")
    expect(sphinxUrls).toEqual(["https://docs.example.com/api.html", "https://docs.example.com/intro.html"])
  })
})
