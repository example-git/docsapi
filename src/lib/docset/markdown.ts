import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

function createTurndownService(options: { gfm: boolean }): TurndownService {
  const service = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  })

  if (options.gfm) {
    service.use(gfm)
  }

  service.addRule("stripEmptyLinks", {
    filter: (node) => node.nodeName === "A" && !(node as HTMLAnchorElement).textContent?.trim(),
    replacement: () => "",
  })

  return service
}

export function htmlToMarkdown(html: string): string {
  const cleaned = html.replace(/\u00a0/g, " ").trim()
  if (!cleaned) {
    return ""
  }

  const { document } = parseHTML("<!doctype html><html><body></body></html>")
  const container = document.createElement("div")
  container.innerHTML = cleaned

  try {
    return createTurndownService({ gfm: true }).turndown(container).trim()
  } catch {
    try {
      return createTurndownService({ gfm: false }).turndown(container).trim()
    } catch {
      return ""
    }
  }
}
