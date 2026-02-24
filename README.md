# docsapi

docsapi is a fork of [sosumi.ai](https://github.com/nshipster/sosumi.ai). It focuses on a generic documentation API and MCP tools for common docset generators, with Apple Docs supported as a docset type.

The hosted instance for this fork is `https://docsapi.xo.vg`.

## Usage

### Apple Docs via /api (docset: apple)

Fetch Apple docs by appending the raw URL to `/api/`:

```
https://docsapi.xo.vg/api/https://developer.apple.com/documentation/swift/array
```

This works for API reference docs and Apple's [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) (HIG).

### Generic Docs API

You can also fetch Markdown for any doc site by appending the raw URL to `/api/`:

```
https://docsapi.xo.vg/api/https://docs.rs/serde/latest/serde/
```

Set `Accept: application/json` to receive a JSON response with `{ url, content }`.
Inputs ending in `.html` are normalized to the extension-less path.

### Bulk preload for local Docker deployments

Use `POST /api/preload` to discover doc URLs (sitemaps, search indexes, and in-page links) and save local parseable copies under `./local`.
The preload endpoint is async/non-blocking: it returns a `jobId` immediately, then you poll job status/result endpoints.

Example request:

```json
{
  "baseUrl": "https://docs.rs/serde/latest/serde/",
  "maxPages": 20,
  "maxDiscover": 300,
  "maxDepth": 2,
  "concurrency": 4,
  "includeIndexes": true,
  "includeLinks": true,
  "sameHostOnly": true,
  "format": "json"
}
```

Use `"concurrency"` (1-12, default 4) to avoid overload on large sites.
Final preloaded docs are written under `./local/<base-url-slug>/` so repeated jobs for the same site reuse one output directory.
Each job ID folder remains staging-only metadata/scratch output.
Files are named from each page/link title (slugged), with a matching `*.index.json` per doc.
This local-only preload route is disabled in Cloudflare Worker/unenv runtime and requires Node/Docker with writable filesystem.

Job endpoints:
- `GET /api/preload/jobs/{jobId}` for progress/status
- `GET /api/preload/jobs/{jobId}/result` for final output metadata

### Local Admin Panel (Password-protected)

Use `/local-docs` for local docs administration.

Set `LOCAL_DOCS_PASSWORD` in your environment to enable and protect:
- `POST /api/preload`
- `GET /api/preload/jobs/{jobId}`
- `GET /api/preload/jobs/{jobId}/result`
- `GET /api/local-docs/sites`
- `POST /api/local-docs/sites/{slug}` (`update` / `rename`)
- `DELETE /api/local-docs/sites/{slug}`
- `POST /api/local-docs/import` (ZIP upload restore)
- `POST /api/local-docs/backup` (ZIP download for selected sites)

`/api/preload` JSON responses now include:
- `siteIndex`: global index of all downloaded docs (`id`, `title`, `description`, `contentFile`, `indexFile`)
- `docIndexes`: per-document index objects (`headings`, `links`, and local cross-links via `localDocId`)
- `documents`: markdown payloads keyed to local filenames, each with embedded per-doc `index`

### MCP Integration (docsapi)

docsapi's MCP server supports Streamable HTTP and Server-Sent Events (SSE) transport. 
If your client supports either of these, 
configure it to connect directly to `https://docsapi.xo.vg/mcp`.

Otherwise,
you can run this command to proxy over stdio:

```json
{
  "mcpServers": {
    "docsapi": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://docsapi.xo.vg/mcp"]
    }
  }
}
```

See `https://docsapi.xo.vg/#clients` for client-specific instructions.

#### Available Resources

- `doc://{url}` - Documentation at a full URL, rendered as Markdown
  - Example: `doc://https://developer.apple.com/documentation/swift/array`
  - Example: `doc://https://docs.rs/serde/latest/serde/`

#### Available Tools

- `fetchAppleDocs` - Fetches Apple Developer documentation and Human Interface Guidelines by path
  - Parameters: `path` (string) - Documentation path (e.g., '/documentation/swift', 'swiftui/view', 'design/human-interface-guidelines/foundations/color')
  - Returns content as Markdown

- `fetchOnlineDocs` - Fetches documentation from any base URL with docset auto-detection
  - Parameters: `baseUrl` (string), `path` (string, optional), `docsetType` (string, optional)
  - Example: `baseUrl: "https://docs.rs"`, `path: "/serde/latest/serde/"`
  - Example: `baseUrl: "https://docs.python.org/3"`, `path: "/library/asyncio.html"`
  - Example: `baseUrl: "https://developer.apple.com"`, `path: "/documentation/swift/array"`, `docsetType: "apple"`
  - Returns content as Markdown, plus structured metadata (`docsetType`)

- `fetchDocs` - Reads preloaded local docs from `./local` without network fetches
  - Parameters: `source` (slug or URL, optional), `baseUrl` (optional), selectors `docId` | `url` | `path` | `title`, `docsetType` (optional)
  - Routing rules:
    - If `source` is a local slug, fetches local docs from that slug
    - If `source`/`url` points to a URL we already have locally, fetches local docs
    - If it is an Apple Developer URL/path, uses Apple fetch flow
    - Otherwise fetches online docs
  - Returns markdown plus structured metadata for the resolved source

- `listDocs` - Lists all downloaded local docs by site slug
  - Parameters: none
  - Returns available local `slug` values and per-slug document counts

- `searchDocs` - Searches local docs across slugs by title and content text
  - Parameters: `query` (string), `source` (slug or URL, optional), `slug` (optional), `limit` (optional)
  - Routing rules mirror `fetchDocs`:
    - local slug/known local URL -> local search
    - Apple Developer URL -> Apple search
    - other URL -> online search
    - no source -> local search across slugs
  - Returns ranked matches with snippets and source metadata


## Self-Hosting

This project is designed to be easily run on your own machine
or deployed to a hosting provider.

docsapi now runs as a Next.js app server runtime.

### Prerequisites

- Node.js 18+
- npm

### Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/example-git/docsapi.xo.vg.git
   cd docsapi.xo.vg
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start development server:**
   ```bash
   npm run dev
   ```

4. **Build and run production server (optional):**
   ```bash
   npm run build
   npm run start
   ```

Once the application is up and running, press the <kbd>b</kbd>
to open the URL in your browser.

To configure MCP clients to use your development server, 
replace `docsapi.xo.vg` with the local server address
(`http://localhost:3000` by default).

> [!NOTE]  
> This project now runs as a Next.js Node runtime.
> Use `npm run build` and `npm run start` for production.

### Docker / Container Registry

- Build locally:
  ```bash
  docker build -t docsapi:local .
  ```
- Run locally:
  ```bash
  docker run --rm -p 3000:3000 --env-file .env docsapi:local
  ```
- Published image (GitHub Container Registry): `ghcr.io/example-git/docsapi`

On push to `main` (and `v*` tags), GitHub Actions builds and pushes this image via `.github/workflows/container.yml`.
The build context excludes downloaded docs under `./local` via `.dockerignore`.

## Development

### Testing

This project uses [vitest](https://vitest.dev)
for  unit and integration testing.

```bash
npm run test          # Run tests
npm run test:ui       # Run tests with UI
npm run test:run      # Run tests once
```

### Code Quality

This project uses [Biome](https://biomejs.dev/) 
for code formatting, linting, and import organization.

- `npm run format` - Format all code files
- `npm run lint` - Lint and fix code issues
- `npm run check` - Format, lint, and organize imports (recommended)
- `npm run check:ci` - Check code without making changes (for CI)

### Editor Integration

For the best development experience, install the Biome extension for your editor:

- [VSCode](https://marketplace.visualstudio.com/items?itemName=biomejs.biome)
- [Vim/Neovim](https://github.com/biomejs/biome/tree/main/editors/vim)
- [Emacs](https://github.com/biomejs/biome/tree/main/editors/emacs)

## License

This project is available under the MIT license.
See the LICENSE file for more info.

## Legal

This is an unofficial,
independent project and is not affiliated with or endorsed by Apple Inc.
"Apple", "Xcode", and related marks are trademarks of Apple Inc.

This service is an accessibility-first,
on‑demand renderer.
It converts a single Apple Developer page to Markdown only when requested by a user.
It does not crawl, spider, or bulk download;
it does not attempt to bypass authentication or security;
and it implements rate limiting to avoid imposing unreasonable load.

Content is fetched transiently and may be cached briefly to improve performance.
No permanent archives are maintained.
All copyrights and other rights in the underlying content remain with Apple Inc.
Each page links back to the original source.

Your use of this service must comply with Apple's Terms of Use and applicable law.
You are solely responsible for how you access and use Apple's content through this tool.
Do not use this service to circumvent technical measures or for redistribution.
