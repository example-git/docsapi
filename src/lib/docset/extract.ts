import { parseHTML } from "linkedom"

import type { DocsetType } from "./types"

const selectorsByType: Record<DocsetType, string[]> = {
  apple: [],
  docusaurus: ["main article", ".theme-doc-markdown", ".markdown"],
  mkdocs: [".md-content__inner", ".md-content", "main"],
  sphinx: ["div[role='main']", ".document", "#content"],
  typedoc: ["#main-content", ".tsd-panel", "main"],
  jsdoc: ["#main", "section#main", ".page"],
  rustdoc: ["main", "#main-content", ".docblock"],
  godoc: ["main", "#pkg-overview", "#pkg-index"],
  pdoc: ["main", "#content", ".pdoc"],
  html: ["body"],
  generic: ["article", "main", "div[role='main']", "#content", ".content"],
}

const fallbackSelectors = ["article", "main", "div[role='main']", "#content", ".content", "body"]

const stripSelectors = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "script",
  "style",
  "noscript",
  "svg",
  ".toc",
  ".table-of-contents",
  ".breadcrumbs",
  ".breadcrumb",
  ".pagination",
  ".sidebar",
  ".theme-doc-sidebar-container",
  ".theme-doc-toc",
  ".theme-doc-toc-mobile",
  ".md-sidebar",
  ".wy-nav-side",
  ".rst-versions",
]

function removeUnwanted(root: Element): void {
  for (const selector of stripSelectors) {
    root.querySelectorAll(selector).forEach((node) => node.remove())
  }
}

function findMainContent(document: Document, docsetType: DocsetType): Element | null {
  const selectors = selectorsByType[docsetType] ?? []
  for (const selector of selectors) {
    const node = document.querySelector(selector)
    if (node) {
      return node
    }
  }

  for (const selector of fallbackSelectors) {
    const node = document.querySelector(selector)
    if (node) {
      return node
    }
  }

  return document.body
}

export function extractDocContent(html: string, docsetType: DocsetType): {
  title: string
  contentHtml: string
} {
  const { document } = parseHTML(html)
  const root = findMainContent(document, docsetType)

  if (!root) {
    return { title: "", contentHtml: "" }
  }

  removeUnwanted(root)

  const title =
    document.querySelector("h1")?.textContent?.trim() ?? document.title?.trim() ?? ""

  return {
    title,
    contentHtml: root.innerHTML,
  }
}
