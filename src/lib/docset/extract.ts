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
  generic: [
    "article",
    "main",
    ".prose",
    ".markdown-body",
    ".docs-content",
    ".doc-content",
    ".content-area",
    ".page-content",
    "div[role='main']",
    "#content",
    ".content",
  ],
}

const fallbackSelectors = ["main", "article", "div[role='main']", "#content", ".content", "body"]

const MIN_CONTENT_LENGTH = 200

const stripSelectors = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "[role='navigation']",
  ".navbar",
  ".site-header",
  ".site-footer",
  ".topbar",
  ".announcement",
  ".alert",
  ".banner",
  ".cookie",
  ".search",
  ".search-container",
  ".searchbox",
  ".skip-link",
  ".toc-nav",
  ".toc-container",
  ".toc-sidebar",
  ".docs-toc",
  ".docs-toc-container",
  ".docs-header",
  ".site-nav",
  ".site-navigation",
  ".docs-nav",
  ".docs-sidebar",
  ".doc-sidebar",
  ".doc-nav",
  ".sidebar-nav",
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
  const selectors = [...(selectorsByType[docsetType] ?? []), ...fallbackSelectors]

  for (const selector of selectors) {
    const node = document.querySelector(selector)
    if (!node) continue
    const clone = node.cloneNode(true) as Element
    removeUnwanted(clone)
    const text = clone.textContent?.trim() ?? ""
    if (text.length >= MIN_CONTENT_LENGTH) {
      return clone
    }
  }

  return document.body ? (document.body.cloneNode(true) as Element) : null
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

  const titleElement = root.querySelector("h1") ?? document.querySelector("h1")
  const title = titleElement?.textContent?.trim() ?? document.title?.trim() ?? ""

  if (titleElement && titleElement.textContent?.trim() === title) {
    titleElement.remove()
  }

  return {
    title,
    contentHtml: root.innerHTML,
  }
}
