import { handleMcpRequest } from "../../src/lib/mcp-handler"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  return handleMcpRequest(request)
}

export async function POST(request: Request) {
  return handleMcpRequest(request)
}

export async function OPTIONS(request: Request) {
  return handleMcpRequest(request)
}

export async function PUT(request: Request) {
  return handleMcpRequest(request)
}

export async function PATCH(request: Request) {
  return handleMcpRequest(request)
}

export async function DELETE(request: Request) {
  return handleMcpRequest(request)
}

export async function HEAD(request: Request) {
  return handleMcpRequest(request)
}
