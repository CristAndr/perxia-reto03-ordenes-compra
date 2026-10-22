import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { config } from "../config.ts"
import { aprobar, pendiente } from "../domain/oc-estado.ts"
import { mensajeDeError } from "../domain/resultado.ts"
import type { DefinicionHerramienta, LlamadaHerramienta, LlmAdapter, Mensaje } from "../llm/adapter.ts"
import { buscarHerramienta, herramientas } from "../tools/registro.ts"
import type { Sesion, ToolCallVisible } from "./sesiones.ts"

export interface RespuestaTurno { reply: string; toolCalls: ToolCallVisible[]; needsConfirmation: boolean; casoPendiente?: string; payload?: unknown }
const definiciones: DefinicionHerramienta[] = herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.descripcion, parametros: h.parametros }))
async function systemPrompt(raiz: string): Promise<string> {
  const [prompt, conocimiento] = await Promise.all([readFile(path.join(raiz, "agent/prompt.md"), "utf8"), readFile(path.join(raiz, "src/knowledge/ordenes-compra.md"), "utf8")])
  return `${prompt}\n\n${conocimiento}`
}
function esConfirmacion(texto: string): boolean { return /^(confirmo|sí,? confirmo|si,? confirmo|autorizo|crear la oc|confirmar)$/i.test(texto.trim().replace(/[.!]+$/, "")) }
function cancelar(texto: string): boolean { return /^(cancelar|no|no confirmar|no crear|rechazo)$/i.test(texto.trim().replace(/[.!]+$/, "")) }
function casoSolicitado(texto: string): string | undefined { return texto.match(/\bsol-00[1-6]\b/i)?.[0]?.toLowerCase() }
function respuestaBloqueos(caso: string, visible: ToolCallVisible[]): string {
  const validacion = visible.find((tool) => tool.nombre === "oc_validar")?.resultado as { data?: { bloqueos?: string[]; confirmaciones?: string[]; derivados?: Record<string, string>; retroactiva?: boolean } } | undefined
  const datos = validacion?.data
  if (!datos) return `No se pudo completar la validación de ${caso}. Revisa las herramientas ejecutadas.`
  const partes = [`Resultado para ${caso}: no se creó ninguna OC.`]
  if (datos.bloqueos?.length) partes.push(`Bloqueos:\n${datos.bloqueos.map((bloqueo) => `- ${bloqueo}`).join("\n")}`)
  if (datos.confirmaciones?.length) partes.push(`Confirmaciones pendientes:\n${datos.confirmaciones.map((confirmacion) => `- ${confirmacion}`).join("\n")}`)
  if (Object.keys(datos.derivados ?? {}).length) partes.push(`Valores derivados: ${Object.entries(datos.derivados ?? {}).map(([clave, valor]) => `${clave}=${valor}`).join(", ")}.`)
  if (datos.retroactiva) partes.push("La solicitud está marcada como retroactiva.")
  return partes.join("\n\n")
}
async function ejecutarLlamada(sesion: Sesion, llamada: LlamadaHerramienta, raiz: string): Promise<{ contenido: string; visible: ToolCallVisible }> {
  const tool = buscarHerramienta(llamada.nombre)
  let contenido: string
  try { contenido = tool ? await tool.ejecutar(llamada.args, { directory: raiz, sessionId: sesion.id }) : JSON.stringify({ ok: false, error: "herramienta desconocida" }) }
  catch { contenido = JSON.stringify({ ok: false, error: "error de herramienta; revisar documentos y reintentar" }) }
  let r: { ok: boolean; error?: string; data?: unknown }
  try { r = JSON.parse(contenido) as typeof r } catch { r = { ok: false, error: "respuesta de herramienta inválida" }; contenido = JSON.stringify(r) }
  const caso = (llamada.args as { caso?: unknown } | null)?.caso
  if (llamada.nombre === "oc_construir_payload" && r.ok && typeof caso === "string") {
    const e = pendiente(sesion.id, caso)
    if (e && e.validacion.confirmaciones.length > 0) sesion.pendiente = { caso, digest: e.digest, payload: e.payload, desde: Date.now() }
  }
  const resumen = r.ok ? JSON.stringify(r.data).slice(0, 300) : r.error ?? "error"
  const visible = { nombre: llamada.nombre, args: llamada.args, ok: r.ok, resumen, resultado: r }
  await mkdir(path.join(raiz, "out"), { recursive: true })
  await appendFile(path.join(raiz, "out/log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId: sesion.id, herramienta: llamada.nombre, args: llamada.args, ok: r.ok, resumen }) + "\n")
  return { contenido, visible }
}
export async function ejecutarTurno(sesion: Sesion, texto: string, llm: LlmAdapter, raiz: string): Promise<RespuestaTurno> {
  sesion.historial.push({ rol: "user", texto, ts: new Date().toISOString() })
  const toolCalls: ToolCallVisible[] = []
  let reply = ""
  let autorizado = false
  let creado = false
  let nuevoPendiente: Sesion["pendiente"]
  const previo = sesion.pendiente
  sesion.pendiente = undefined
  if (previo && esConfirmacion(texto) && Date.now() - previo.desde < 600000 && aprobar(sesion.id, previo.caso, previo.digest, true)) {
    autorizado = true
    sesion.mensajes.push({ rol: "user", texto: `Confirmación humana verificada para ${previo.caso}; digest ${previo.digest}. Procesa solamente esa solicitud con oc_crear usando el payload previamente generado y confirmado=true.` })
  } else {
    sesion.mensajes.push({ rol: "user", texto })
    if (previo && cancelar(texto)) reply = `La creación de la OC para ${previo.caso} fue cancelada. No se creó ninguna orden.`
    else if (previo && esConfirmacion(texto)) reply = "La confirmación expiró o el caso cambió. Procesa nuevamente el caso antes de confirmar."
  }
  if (autorizado && previo && sesion.tokens >= config.maxTokensSesion) reply = "La sesión alcanzó el tope de tokens antes de crear la OC; no se ejecutó ninguna acción."
  else if (sesion.tokens >= config.maxTokensSesion) reply = "Tope de tokens de la sesión alcanzado. Abre una sesión nueva."
  const caso = casoSolicitado(texto)
  if (!reply && caso && !autorizado) {
    const secuencia = ["oc_leer_paquete", "oc_validar", "oc_construir_payload"]
    for (const nombre of secuencia) {
      const llamada = { id: `servidor_${nombre}_${Date.now()}`, nombre, args: { caso } }
      const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz)
      sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre, contenido })
      toolCalls.push(visible)
      if (!visible.ok) break
      if (nombre === "oc_validar") {
        const validacion = visible.resultado as { data?: { apta?: boolean } }
        if (!validacion.data?.apta) break
      }
    }
    nuevoPendiente = sesion.pendiente as Sesion["pendiente"] | undefined
    const estadoPreparado = nuevoPendiente as Sesion["pendiente"] | undefined
    if (estadoPreparado) reply = `La OC para ${estadoPreparado.caso} está preparada. Revisa el payload y las excepciones. ¿Confirmas crear esta orden? Responde «Confirmo» o «Cancelar».`
    else {
      const estado = pendiente(sesion.id, caso)
      if (estado?.validacion.apta && estado.validacion.confirmaciones.length === 0) {
        const llamada = { id: `servidor_oc_crear_${Date.now()}`, nombre: "oc_crear", args: { caso } }
        const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz)
        sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
        toolCalls.push(visible)
        creado = visible.ok
      }
      if (!creado && !reply) reply = respuestaBloqueos(caso, toolCalls)
    }
  }
  if (!reply && autorizado && previo) {
    const llamada = { id: `servidor_oc_crear_${Date.now()}`, nombre: "oc_crear", args: { caso: previo.caso, confirmado: true } }
    const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz)
    sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
    toolCalls.push(visible)
    creado = visible.ok
  }
  if (!reply && !creado && !nuevoPendiente) {
    try {
      const system: Mensaje = { rol: "system", texto: await systemPrompt(raiz) }
      for (let i = 0; i < config.maxIter && sesion.tokens < config.maxTokensSesion; i++) {
        const r = await llm.enviar([system, ...sesion.mensajes], definiciones)
        sesion.tokens += r.tokens
        sesion.mensajes.push({ rol: "assistant", texto: r.texto, llamadas: r.llamadas })
        if (!r.llamadas.length) { reply = r.texto; break }
        for (const llamada of r.llamadas) {
          if (llamada.nombre === "oc_crear") {
            const args = llamada.args as { caso?: unknown; confirmado?: unknown }
            const estado = typeof args?.caso === "string" ? pendiente(sesion.id, args.caso) : undefined
            const requiereConfirmacion = Boolean(estado?.validacion.confirmaciones.length)
            if (!estado || (requiereConfirmacion && (!autorizado || !previo || args.caso !== previo.caso || args.confirmado !== true))) {
              const contenido = JSON.stringify({ ok: false, error: requiereConfirmacion ? "acción no autorizada por la confirmación humana de este turno" : "payload sin validación vigente" })
              sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
              toolCalls.push({ nombre: llamada.nombre, args: llamada.args, ok: false, resumen: requiereConfirmacion ? "confirmación requerida" : "validación requerida", resultado: JSON.parse(contenido) })
              continue
            }
          }
          const { contenido, visible } = await ejecutarLlamada(sesion, llamada, raiz)
          sesion.mensajes.push({ rol: "tool", id: llamada.id, nombre: llamada.nombre, contenido })
          toolCalls.push(visible)
          if (llamada.nombre === "oc_crear" && visible.ok) { autorizado = false; creado = true; sesion.pendiente = undefined }
        }
        nuevoPendiente = sesion.pendiente as Sesion["pendiente"] | undefined
        if (nuevoPendiente || creado) break
      }
      const estadoPreparado = nuevoPendiente as Sesion["pendiente"] | undefined
      if (estadoPreparado) reply = `La OC para ${estadoPreparado.caso} está preparada. Revisa el payload y las excepciones. ¿Confirmas crear esta orden? Responde «Confirmo» o «Cancelar».`
      else if (creado) {
        const oc = toolCalls.find((t) => t.nombre === "oc_crear" && t.ok)?.resultado as { data?: { numero_oc?: string; idempotente?: boolean } } | undefined
        reply = `OC ${oc?.data?.numero_oc ?? "creada"}${oc?.data?.idempotente ? " (ya existente)" : ""}. La evidencia y trazabilidad quedaron en out/${previo?.caso}/.`
      } else if (!reply) reply = `Alcancé el tope de ${config.maxIter} pasos o ${config.maxTokensSesion} tokens. Revisa las herramientas ejecutadas y pide continuar.`
    } catch (e) {
      const motivo = e instanceof Error && (e.name.includes("Timeout") || e.name === "AbortError") ? "el modelo tardó demasiado" : mensajeDeError(e)
      reply = `No pude completar la respuesta (${motivo}). La sesión sigue activa; reintenta.`
    }
  }
  if (!reply && creado) {
    const oc = toolCalls.find((tool) => tool.nombre === "oc_crear" && tool.ok)?.resultado as { data?: { numero_oc?: string; idempotente?: boolean } } | undefined
    const casoCreado = previo?.caso ?? caso
    reply = `OC ${oc?.data?.numero_oc ?? "creada"}${oc?.data?.idempotente ? " (ya existente)" : ""}. La evidencia y trazabilidad quedaron en out/${casoCreado}/.`
  }
  const actual: Sesion["pendiente"] = nuevoPendiente
  const result: RespuestaTurno = { reply, toolCalls, needsConfirmation: Boolean(actual), casoPendiente: actual?.caso, payload: actual?.payload }
  sesion.historial.push({ rol: "assistant", texto: reply, ts: new Date().toISOString(), toolCalls, needsConfirmation: result.needsConfirmation, casoPendiente: result.casoPendiente, payload: result.payload })
  return result
}
