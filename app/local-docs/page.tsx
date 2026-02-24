"use client"

import { FormEvent, useState } from "react"
import { useRouter } from "next/navigation"

export default function LocalDocsLoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [message, setMessage] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setMessage("Authenticating...")
    try {
      const response = await fetch("/api/local-docs/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })

      if (!response.ok) {
        const text = await response.text()
        setMessage(`Auth failed (${response.status}): ${text}`)
        return
      }

      setMessage("Authenticated. Redirecting...")
      setPassword("")
      router.replace("/local-docs/admin")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        width: "100%",
        margin: 0,
        padding: "3rem 1rem",
        fontFamily: "sans-serif",
        color: "#f3f4f6",
        background: "#0b0f17",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: 560 }}>
        <h1>Local Docs Login</h1>
        <p>Enter the local docs password to access the admin panel.</p>

        <section style={{ border: "1px solid #2b2f3a", borderRadius: 8, padding: 16, background: "#121520" }}>
          <form onSubmit={onSubmit} style={{ display: "grid", gap: 10 }}>
            <input
              type="password"
              placeholder="Local docs password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              style={{ padding: 8, background: "#0c0f18", color: "#f3f4f6", border: "1px solid #2b2f3a", borderRadius: 6 }}
            />
            <button type="submit" disabled={submitting} style={{ padding: 10, background: "#1f6feb", color: "#fff", border: 0, borderRadius: 6 }}>
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
          <p style={{ color: "#d1d5db" }}>{message}</p>
        </section>
      </div>
    </main>
  )
}
