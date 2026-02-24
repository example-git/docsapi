import { NextRequest, NextResponse } from "next/server"
import {
  LOCAL_DOCS_AUTH_COOKIE,
  getLocalDocsPassword,
  isLocalDocsPasswordValid,
} from "../../../../src/lib/local-docs-auth"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const expected = getLocalDocsPassword()
  if (!expected) {
    return NextResponse.json(
      { message: "Server is missing LOCAL_DOCS_PASSWORD. Local docs auth is unavailable." },
      { status: 503 },
    )
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ message: "Invalid JSON body." }, { status: 400 })
  }

  const password = typeof payload === "object" && payload && "password" in payload
    ? (payload as { password?: unknown }).password
    : undefined

  if (typeof password !== "string" || !isLocalDocsPasswordValid(password)) {
    return NextResponse.json({ message: "Invalid password." }, { status: 401 })
  }

  const isSecureRequest =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"

  const response = NextResponse.json({ ok: true })
  response.cookies.set(LOCAL_DOCS_AUTH_COOKIE, password, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest,
    path: "/",
    maxAge: 60 * 60 * 12,
  })
  return response
}

export async function DELETE(request: NextRequest) {
  const isSecureRequest =
    request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https"

  const response = NextResponse.json({ ok: true })
  response.cookies.set(LOCAL_DOCS_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest,
    path: "/",
    maxAge: 0,
  })
  return response
}
