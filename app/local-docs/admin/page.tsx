"use client"

import { type CSSProperties, FormEvent, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"

type LocalSite = {
  slug: string
  baseUrl: string
  totalDocs: number
}

const card: CSSProperties = {
  border: "1px solid #2b2f3a",
  borderRadius: 12,
  padding: 18,
  background: "#121520",
  boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
}

const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #30363d",
  background: "#1b2232",
  color: "#f3f4f6",
}

const inputStyle: CSSProperties = {
  padding: 8,
  background: "#0c0f18",
  color: "#f3f4f6",
  border: "1px solid #2b2f3a",
  borderRadius: 8,
}

export default function LocalDocsAdminPage() {
  const router = useRouter()
  const [status, setStatus] = useState("")
  const [output, setOutput] = useState("")
  const [running, setRunning] = useState(false)
  const [sites, setSites] = useState<LocalSite[]>([])
  const [sitesStatus, setSitesStatus] = useState("")
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({})
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([])
  const [importFile, setImportFile] = useState<File | null>(null)
  const [locked, setLocked] = useState(false)

  const defaults = useMemo(
    () => ({
      baseUrl: "https://docs.rs/serde/latest/serde/",
      paths: "",
      maxPages: 200,
      maxDiscover: 300,
      maxDepth: 2,
      concurrency: 4,
      includeIndexes: true,
      includeLinks: true,
      includeBase: true,
      sameHostOnly: true,
    }),
    [],
  )

  async function onLogout() {
    await fetch("/api/local-docs/auth", { method: "DELETE" })
    router.replace("/local-docs")
  }

  async function loadSites() {
    const response = await fetch("/api/local-docs/sites")
    if (!response.ok) {
      if (response.status === 401) {
        setLocked(true)
        router.replace("/local-docs")
        return
      }
      setSitesStatus(`Failed loading sites (${response.status}).`)
      return
    }

    setLocked(false)
    const data = (await response.json()) as { sites: LocalSite[] }
    setSites(data.sites || [])
    setSelectedSlugs((prev) => prev.filter((slug) => (data.sites || []).some((site) => site.slug === slug)))
    setSitesStatus(`Loaded ${data.sites?.length || 0} site(s).`)
  }

  async function onUpdateSite(slug: string) {
    setSitesStatus(`Queueing update for ${slug}...`)
    const response = await fetch(`/api/local-docs/sites/${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update" }),
    })
    const text = await response.text()
    if (!response.ok) {
      setSitesStatus(`Update failed for ${slug} (${response.status}). ${text}`)
      return
    }
    setSitesStatus(`Update queued for ${slug}. ${text}`)
  }

  async function onDeleteSite(slug: string) {
    const yes = window.confirm(`Delete local site "${slug}"?`)
    if (!yes) return
    const response = await fetch(`/api/local-docs/sites/${encodeURIComponent(slug)}`, { method: "DELETE" })
    const text = await response.text()
    if (!response.ok) {
      setSitesStatus(`Delete failed for ${slug} (${response.status}). ${text}`)
      return
    }
    setSitesStatus(`Deleted ${slug}.`)
    await loadSites()
  }

  async function onRenameSite(oldSlug: string) {
    const newSlug = (renameDrafts[oldSlug] || "").trim()
    if (!newSlug) {
      setSitesStatus("Enter a new slug first.")
      return
    }
    const response = await fetch(`/api/local-docs/sites/${encodeURIComponent(oldSlug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", newSlug }),
    })
    const text = await response.text()
    if (!response.ok) {
      setSitesStatus(`Rename failed (${response.status}). ${text}`)
      return
    }
    setSitesStatus(`Renamed ${oldSlug} to ${newSlug}.`)
    setRenameDrafts((prev) => ({ ...prev, [oldSlug]: "" }))
    await loadSites()
  }

  async function onPreloadSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const baseUrl = String(form.get("baseUrl") || "").trim()
    const paths = String(form.get("paths") || "")
    const maxPages = Number.parseInt(String(form.get("maxPages") || defaults.maxPages), 10)
    const maxDiscover = Number.parseInt(String(form.get("maxDiscover") || defaults.maxDiscover), 10)
    const maxDepth = Number.parseInt(String(form.get("maxDepth") || defaults.maxDepth), 10)
    const concurrency = Number.parseInt(String(form.get("concurrency") || defaults.concurrency), 10)
    const includeBase = Boolean(form.get("includeBase"))
    const includeIndexes = Boolean(form.get("includeIndexes"))
    const includeLinks = Boolean(form.get("includeLinks"))
    const sameHostOnly = Boolean(form.get("sameHostOnly"))

    setRunning(true)
    setStatus("Queueing preload job...")
    setOutput("")
    try {
      const enqueueResponse = await fetch("/api/preload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl,
          paths,
          maxPages,
          maxDiscover,
          maxDepth,
          concurrency,
          format: "json",
          includeIndexes,
          includeLinks,
          includeBase,
          sameHostOnly,
          saveLocal: true,
        }),
      })

      if (!enqueueResponse.ok) {
        const errorText = await enqueueResponse.text()
        setStatus(`Error: ${enqueueResponse.status}`)
        setOutput(errorText)
        return
      }

      const job = (await enqueueResponse.json()) as { jobId: string; statusUrl: string; resultUrl: string }
      setStatus(`Job ${job.jobId} queued. Processing...`)

      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const statusResponse = await fetch(job.statusUrl)
        if (!statusResponse.ok) {
          const statusErr = await statusResponse.text()
          setStatus(`Status error: ${statusResponse.status}`)
          setOutput(statusErr)
          return
        }

        const statusData = (await statusResponse.json()) as {
          id: string
          status: string
          progress: { completed: number; total: number; failed: number; discovered: number }
          error?: string
        }
        setStatus(
          `Job ${statusData.id}: ${statusData.status} | done ${statusData.progress.completed}/${statusData.progress.total}, failed ${statusData.progress.failed}, discovered ${statusData.progress.discovered}`,
        )

        if (statusData.status === "failed") {
          setOutput(statusData.error || "Preload job failed.")
          return
        }
        if (statusData.status !== "completed") {
          continue
        }

        const resultResponse = await fetch(job.resultUrl)
        if (!resultResponse.ok) {
          const resultErr = await resultResponse.text()
          setStatus(`Result error: ${resultResponse.status}`)
          setOutput(resultErr)
          return
        }

        const data = await resultResponse.json()
        setStatus(`Preloaded ${data.preloaded} docs (failed: ${data.failed}, discovered: ${data.discovered}).`)
        setOutput(JSON.stringify(data, null, 2).slice(0, 12000))
        await loadSites()
        return
      }
    } catch (error) {
      setStatus("Preload failed.")
      setOutput(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  async function onDownloadBackup() {
    if (selectedSlugs.length === 0) {
      setSitesStatus("Select at least one site to backup.")
      return
    }
    setSitesStatus(`Building backup for ${selectedSlugs.length} site(s)...`)
    const response = await fetch("/api/local-docs/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slugs: selectedSlugs }),
    })
    if (!response.ok) {
      const text = await response.text()
      setSitesStatus(`Backup failed (${response.status}). ${text}`)
      return
    }

    const blob = await response.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = href
    a.download = `local-backup-${Date.now()}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(href)
    setSitesStatus(`Backup ready (${selectedSlugs.length} site(s)).`)
  }

  async function onImportBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!importFile) {
      setSitesStatus("Choose a zip file first.")
      return
    }

    setSitesStatus("Importing backup zip...")
    const formData = new FormData()
    formData.set("file", importFile)
    const response = await fetch("/api/local-docs/import", {
      method: "POST",
      body: formData,
    })
    const text = await response.text()
    if (!response.ok) {
      setSitesStatus(`Import failed (${response.status}). ${text}`)
      return
    }
    setSitesStatus(`Import completed. ${text}`)
    setImportFile(null)
    await loadSites()
  }

  useEffect(() => {
    void loadSites()
  }, [])

  if (locked) {
    return (
      <main style={{ maxWidth: 560, margin: "3rem auto", padding: "0 1rem", fontFamily: "sans-serif", color: "#f3f4f6" }}>
        <p>Authentication required. Redirecting...</p>
      </main>
    )
  }

  return (
    <main
      style={{
        minHeight: "100%",
        width: "100%",
        margin: 0,
        padding: "2rem 1rem 2rem",
        boxSizing: "border-box",
        background: "#0b0f17",
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          margin: "0 auto",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
          color: "#f3f4f6",
        }}
      >
        <header
          style={{
            ...card,
            marginBottom: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            background: "linear-gradient(140deg, #151a28, #111521)",
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 30 }}>Local Docs Admin</h1>
            <p style={{ margin: "6px 0 0", opacity: 0.78, color: "#c9d1d9" }}>Manage local docs sites, backups, and refresh jobs.</p>
          </div>
          <button type="button" onClick={onLogout} style={buttonStyle}>
            Logout
          </button>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 16 }}>
          <section style={card}>
            <h2 style={{ marginTop: 0 }}>Preload Job</h2>
            <form onSubmit={onPreloadSubmit} style={{ display: "grid", gap: 10 }}>
              <input name="baseUrl" type="url" defaultValue={defaults.baseUrl} required style={{ ...inputStyle, padding: 10 }} />
              <textarea name="paths" placeholder="/guide\n/reference" rows={4} defaultValue={defaults.paths} style={{ ...inputStyle, padding: 10 }} />
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(90px,1fr))", gap: 8 }}>
                <input name="maxPages" type="number" min={1} max={2000} defaultValue={defaults.maxPages} style={inputStyle} />
                <input name="maxDiscover" type="number" min={1} max={2000} defaultValue={defaults.maxDiscover} style={inputStyle} />
                <input name="maxDepth" type="number" min={1} max={5} defaultValue={defaults.maxDepth} style={inputStyle} />
                <input name="concurrency" type="number" min={1} max={12} defaultValue={defaults.concurrency} style={inputStyle} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label><input name="includeBase" type="checkbox" defaultChecked={defaults.includeBase} /> Include base URL</label>
                <label><input name="includeIndexes" type="checkbox" defaultChecked={defaults.includeIndexes} /> Scrape indexes</label>
                <label><input name="includeLinks" type="checkbox" defaultChecked={defaults.includeLinks} /> Crawl links</label>
                <label><input name="sameHostOnly" type="checkbox" defaultChecked={defaults.sameHostOnly} /> Same host only</label>
              </div>
              <button type="submit" disabled={running} style={{ ...buttonStyle, background: "#1f6feb", border: 0, padding: "10px 14px" }}>
                {running ? "Running..." : "Run preload"}
              </button>
            </form>
            <p style={{ marginBottom: 8, color: "#d1d5db" }}>{status}</p>
            <pre style={{ whiteSpace: "pre-wrap", border: "1px solid #2b2f3a", borderRadius: 8, padding: 10, background: "#0c0f18", color: "#e5e7eb", maxHeight: 260, overflow: "auto" }}>{output}</pre>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0 }}>Backups</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
              <button type="button" onClick={onDownloadBackup} disabled={selectedSlugs.length === 0} style={buttonStyle}>Download ZIP</button>
              <button type="button" onClick={() => setSelectedSlugs(sites.map((site) => site.slug))} style={buttonStyle}>Select all</button>
              <button type="button" onClick={() => setSelectedSlugs([])} style={buttonStyle}>Clear</button>
              <p style={{ margin: 0, color: "#d1d5db" }}>{sitesStatus}</p>
            </div>
            <form onSubmit={onImportBackup} style={{ display: "grid", gap: 8 }}>
              <input type="file" accept=".zip,application/zip" onChange={(event) => setImportFile(event.target.files?.[0] || null)} />
              <button type="submit" disabled={!importFile} style={buttonStyle}>Upload ZIP restore</button>
            </form>
            <button type="button" onClick={() => void loadSites()} style={{ ...buttonStyle, marginTop: 10 }}>Refresh sites</button>
          </section>
        </div>

        <section style={{ ...card, marginTop: 16 }}>
          <h2 style={{ marginTop: 0 }}>Site Management</h2>
          <div style={{ display: "grid", gap: 12 }}>
            {sites.map((site) => (
              <div key={site.slug} style={{ border: "1px solid #2b2f3a", borderRadius: 8, padding: 12, background: "#0f1320" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={selectedSlugs.includes(site.slug)}
                      onChange={(event) =>
                        setSelectedSlugs((prev) =>
                          event.target.checked
                            ? [...new Set([...prev, site.slug])]
                            : prev.filter((slug) => slug !== site.slug),
                        )
                      }
                    />
                    Select
                  </label>
                  <strong>{site.slug}</strong>
                  <span style={{ opacity: 0.7 }}>({site.totalDocs} docs)</span>
                </div>
                <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 10, color: "#aeb6c2" }}>{site.baseUrl}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button type="button" onClick={() => void onUpdateSite(site.slug)} style={buttonStyle}>Update pages</button>
                  <input
                    type="text"
                    placeholder="new-slug"
                    value={renameDrafts[site.slug] || ""}
                    onChange={(event) =>
                      setRenameDrafts((prev) => ({
                        ...prev,
                        [site.slug]: event.target.value,
                      }))
                    }
                    style={inputStyle}
                  />
                  <button type="button" onClick={() => void onRenameSite(site.slug)} style={buttonStyle}>Rename</button>
                  <button type="button" onClick={() => void onDeleteSite(site.slug)} style={{ ...buttonStyle, border: "1px solid #7f1d1d", background: "#3a1515", color: "#fecaca" }}>Delete</button>
                </div>
              </div>
            ))}
            {sites.length === 0 ? <p>No local sites found.</p> : null}
          </div>
        </section>
      </div>
    </main>
  )
}
