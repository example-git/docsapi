import { StreamableHTTPTransport } from "@hono/mcp"
import { Hono } from "hono"
import { createMcpServer } from "./mcp"

export async function handleMcpRequest(request: Request): Promise<Response> {
  const mcpServer = createMcpServer()
  const mcpApp = new Hono()

  mcpApp.all("/mcp", async (c) => {
    const transport = new StreamableHTTPTransport()
    await mcpServer.connect(transport)
    return transport.handleRequest(c)
  })

  return mcpApp.fetch(request)
}
