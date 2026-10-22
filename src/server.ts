import path from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono, type Context, type Next } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { buscarSesion, eliminarSesion, obtenerSesion, PATRON_SESION } from "./agent/sesiones.ts"
import { config } from "./config.ts"
import { olvidar } from "./domain/oc-estado.ts"
import type { LlmAdapter } from "./llm/adapter.ts"
import { crearAdaptador } from "./llm/index.ts"
import { ipCliente } from "./http/auth.ts"

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const app = new Hono()
let llm: LlmAdapter | undefined
try { llm = crearAdaptador() } catch { console.error("Adaptador LLM no configurado") }
app.use("*", async (c, next) => {
  await next()
  c.header("X-Content-Type-Options", "nosniff")
  c.header("Referrer-Policy", "no-referrer")
  c.header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'")
})
app.get("/api/health", (c) => c.json({ ok: true, provider: config.proveedor, model: config.modelo, available: Boolean(llm) }))
function limitador(max: number) {
  const ventanas = new Map<string, { inicio: number; cuenta: number }>()
  return async (c: Context, next: Next) => {
    const key = ipCliente(c), ahora = Date.now(), actual = ventanas.get(key)
    if (!actual || ahora - actual.inicio > 60000) ventanas.set(key, { inicio: ahora, cuenta: 1 })
    else if (++actual.cuenta > max) return c.json({ ok: false, error: "Demasiadas peticiones." }, 429)
    await next()
  }
}
app.use("/api/chat", limitador(config.rateLimitPorMin), bodyLimit({ maxSize: 16384, onError: (c) => c.json({ ok: false, error: "Mensaje demasiado largo." }, 413) }))
app.use("/api/sessions/*", limitador(config.rateLimitPorMin * 3))
const CuerpoChat = z.object({ sessionId: z.string().regex(PATRON_SESION), message: z.string().trim().min(1).max(4000) })
const enCurso = new Set<string>()
app.post("/api/chat", async (c) => {
  const parsed = CuerpoChat.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ ok: false, error: "Se espera { sessionId, message }." }, 400)
  if (!llm) return c.json({ ok: false, error: "Modelo no configurado; consulta README y .env.example." }, 503)
  const { sessionId, message } = parsed.data
  if (enCurso.has(sessionId)) return c.json({ ok: false, error: "Ya hay un mensaje en curso." }, 409)
  enCurso.add(sessionId)
  try { return c.json(await ejecutarTurno(obtenerSesion(sessionId), message, llm, raiz)) }
  finally { enCurso.delete(sessionId) }
})
app.get("/api/sessions/:id", (c) => {
  const id = c.req.param("id"), sesion = PATRON_SESION.test(id) ? buscarSesion(id) : undefined
  return sesion ? c.json({ id, historial: sesion.historial, tokens: sesion.tokens, needsConfirmation: Boolean(sesion.pendiente), casoPendiente: sesion.pendiente?.caso, payload: sesion.pendiente?.payload }) : c.json({ ok: false, error: "Sesión no encontrada." }, 404)
})
app.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id")
  if (!PATRON_SESION.test(id)) return c.json({ ok: false, error: "ID inválido." }, 400)
  if (enCurso.has(id)) return c.json({ ok: false, error: "Sesión ocupada." }, 409)
  eliminarSesion(id)
  olvidar(id)
  return c.body(null, 204)
})
app.notFound((c) => c.req.path.startsWith("/api/") ? c.json({ ok: false, error: "Ruta no encontrada." }, 404) : c.text("No encontrado", 404))
app.onError((_e, c) => { console.error("Error interno de API"); return c.json({ ok: false, error: "Error interno. La sesión sigue activa." }, 500) })
app.use("/*", serveStatic({ root: path.relative(process.cwd(), path.join(raiz, "web")) || "." }))
serve({ fetch: app.fetch, port: config.puerto, hostname: "0.0.0.0" }, (info) => console.log(`Agente OC listo en puerto ${info.port}`))
