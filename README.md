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

- `searchAppleDocumentation` - Searches Apple Developer documentation
  - Parameters: `query` (string)
  - Returns structured results with titles, URLs, descriptions, breadcrumbs, and tags

- `fetchAppleDocumentation` - Fetches Apple Developer documentation and Human Interface Guidelines by path
  - Parameters: `path` (string) - Documentation path (e.g., '/documentation/swift', 'swiftui/view', 'design/human-interface-guidelines/foundations/color')
  - Returns content as Markdown

- `fetchDocumentation` - Fetches documentation from any base URL with docset auto-detection
  - Parameters: `baseUrl` (string), `path` (string, optional), `docsetType` (string, optional)
  - Example: `baseUrl: "https://docs.rs"`, `path: "/serde/latest/serde/"`
  - Example: `baseUrl: "https://docs.python.org/3"`, `path: "/library/asyncio.html"`
  - Example: `baseUrl: "https://developer.apple.com"`, `path: "/documentation/swift/array"`, `docsetType: "apple"`
  - Returns content as Markdown, plus structured metadata (`docsetType`)

- `searchDocumentation` - Basic search for common docset generators
  - Parameters: `baseUrl` (string), `query` (string), `docsetType` (string, optional)
  - Returns structured results with titles and URLs


## Self-Hosting

This project is designed to be easily run on your own machine
or deployed to a hosting provider.

docsapi is currently hosted by 
[Cloudflare Workers](https://workers.cloudflare.com).

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

Once the application is up and running, press the <kbd>b</kbd>
to open the URL in your browser.

To configure MCP clients to use your development server, 
replace `docsapi.xo.vg` with the local server address
(`http://localhost:8787` by default).

> [!NOTE]  
> The application is built with Hono, 
> making it compatible with various runtimes.
>
> See the [Hono docs](https://hono.dev/docs/getting-started/basic)
> for more information about deploying to different platforms.

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

### Cloudflare Workers

Whenever you update your `wrangler.toml` or change your Worker bindings, 
be sure to re-run:

```bash
npm run cf-typegen
```

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

**Contact:** <info@sosumi.ai>
