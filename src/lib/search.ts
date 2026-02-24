import { parseHTML } from "linkedom"
import { fetchWithRateLimit } from "./fetch"

export interface SearchResult {
  title: string
  url: string
  description: string
  breadcrumbs: string[]
  tags: string[]
  type: string // 'documentation' | 'general' etc.
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
}


export async function searchAppleDeveloperDocs(query: string): Promise<SearchResponse> {
  const searchUrl = `https://developer.apple.com/search/?q=${encodeURIComponent(query)}`

  try {
    const response = await fetchWithRateLimit(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    })

    if (!response.ok) {
      throw new Error(`Search request failed: ${response.status}`)
    }

    const html = await response.text()
    const { document } = parseHTML(html)

    const resultItems = document.querySelectorAll("li.search-result")
    const results: SearchResult[] = []

    for (const item of resultItems) {
      const className = item.getAttribute("class") || ""
      let type = "other"
      if (className.includes("documentation")) type = "documentation"
      else if (className.includes("general")) type = "general"

      const linkEl = item.querySelector("a.click-analytics-result")
      if (!linkEl) continue

      const href = linkEl.getAttribute("href") || ""
      const url = href.startsWith("/") ? `https://developer.apple.com${href}` : href
      const title = linkEl.textContent?.trim() || ""
      if (!title || !url) continue

      const descEl = item.querySelector("p.result-description")
      const description = descEl?.textContent?.trim() || ""

      const breadcrumbEls = item.querySelectorAll("li.breadcrumb-list-item")
      const breadcrumbs = Array.from(breadcrumbEls)
        .map((el) => el.textContent?.trim() || "")
        .filter(Boolean)

      const tagEls = item.querySelectorAll("li.result-tag")
      const tags = Array.from(tagEls)
        .map((el) => el.textContent?.trim() || "")
        .filter(Boolean)

      results.push({ title, url, description, breadcrumbs, tags, type })
    }

    return {
      query,
      results,
    }
  } catch (error) {
    console.error("Error searching Apple Developer docs:", error)
    return {
      query,
      results: [],
    }
  }
}
