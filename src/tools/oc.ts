import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { construir, evidencia, leer, validar as validarReglas } from "../domain/oc-proceso.ts"
import { coincide, consumir, control, pendiente, preparar } from "../domain/oc-estado.ts"
import { Caso } from "../domain/oc.ts"
import { SapMock } from "../sap/mock.ts"
import type { ContextoHerramienta } from "./tipos.ts"

const caso = Caso.describe("Carpeta sol-001 a sol-006 dentro de fixtures/reto-03/solicitudes")
const resultado = (data: unknown) => JSON.stringify({ ok: true, data })
const fallo = (error: string) => JSON.stringify({ ok: false, error })
function seguro<A>(nombre: string, fn: (args: A, ctx: ContextoHerramienta) => Promise<unknown>) {
  return async (args: A, ctx: ContextoHerramienta): Promise<string> => {
    try {
      const data = await fn(args, ctx)
      await mkdir(path.join(ctx.directory, "out"), { recursive: true })
      await appendFile(path.join(ctx.directory, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, herramienta: `oc_${nombre}`, ok: true, resumen: nombre }) + "\n")
      return resultado(data)
    } catch (e) {
      const error = e instanceof z.ZodError ? `datos inválidos: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` : e instanceof SyntaxError ? "JSON malformado: pedir al solicitante un archivo corregido" : e instanceof Error && e.message.includes("ENOENT") ? "paquete incompleto: pedir el archivo faltante al solicitante" : e instanceof Error && /paquete no coincide|derivados no coinciden|confirmación|bloqueada|proveedor|cotización|factura/.test(e.message) ? e.message : "no se pudo procesar el caso; revisar los documentos y maestros"
      await mkdir(path.join(ctx.directory, "out"), { recursive: true })
      await appendFile(path.join(ctx.directory, "out", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), sessionId: ctx.sessionId, herramienta: `oc_${nombre}`, ok: false, resumen: error }) + "\n")
      return fallo(error)
    }
  }
}
export const leer_paquete = {
  description: "Lee y normaliza el correo y los documentos de una solicitud de OC.", args: { caso },
  execute: seguro<{ caso: string }>("leer_paquete", async ({ caso }, ctx) => leer(ctx.directory, caso)),
}
export const validar_paquete = async (caso: string, ctx: ContextoHerramienta) => validarReglas(ctx.directory, await leer(ctx.directory, caso))
export const validar_oc = async (caso: string, ctx: ContextoHerramienta) => validar_paquete(caso, ctx)
export const validar = {
  description: "Verifica RC1-RC10 con maestros y devuelve bloqueos, confirmaciones y derivados del caso.", args: { caso },
  execute: seguro<{ caso: string }>("validar", async ({ caso }, ctx) => validar_oc(caso, ctx)),
}
export const construir_payload = {
  description: "Reconstruye la OC desde fuentes confiables, guarda trazabilidad y la deja preparada para crear.", args: { caso },
  execute: seguro<{ caso: string }>("construir_payload", async ({ caso }, ctx) => {
    const real = await leer(ctx.directory, caso)
    const v = await validar_oc(caso, ctx)
    const r = await construir(ctx.directory, caso, real, v)
    preparar(ctx.sessionId, caso, r.payload, v)
    return r
  }),
}
export const generar_evidencia = {
  description: "Escribe el correo de aprobación con SHA256 en TXT y PDF.", args: { caso },
  execute: seguro<{ caso: string }>("generar_evidencia", async ({ caso }, ctx) => evidencia(ctx.directory, caso)),
}
export const crear = {
  description: "Crea la OC en SAP simulado tras revalidar y comprobar confirmación humana de la sesión.",
  args: { caso, confirmado: z.boolean().optional().describe("Indicar true solo tras confirmación humana explícita") },
  execute: seguro<{ caso: string; confirmado?: boolean }>("crear", async ({ caso, confirmado }, ctx) => {
    Caso.parse(caso)
    const p = await leer(ctx.directory, caso)
    const v = await validar_oc(caso, ctx)
    const id = p.solicitud.solicitud_id
    const sap = new SapMock(ctx.directory)
    const anterior = await sap.obtenerOrdenPorReferencia(id)
    if (anterior) {
      await control(ctx.directory, id, "idempotente", anterior.numero_oc, v.retroactiva, v.bloqueos, v.confirmaciones)
      return { numero_oc: anterior.numero_oc, fecha: anterior.fecha, idempotente: true }
    }
    const estado = pendiente(ctx.sessionId, caso)
    if (!v.apta || !estado || JSON.stringify(estado.validacion) !== JSON.stringify(v)) {
      await control(ctx.directory, id, "bloqueado", "", v.retroactiva, v.bloqueos.length ? v.bloqueos : ["payload sin validación vigente o alterado"], v.confirmaciones)
      throw new Error("creación bloqueada")
    }
    if (v.confirmaciones.length > 0 && (!estado.aprobado || confirmado !== true)) {
      await control(ctx.directory, id, "pendiente", "", v.retroactiva, [], v.confirmaciones)
      throw new Error("requiere confirmación humana")
    }
    const firmado = structuredClone(estado.payload)
    if (v.confirmaciones.length) firmado.excepciones = firmado.excepciones.map((e) => ({ ...e, confirmado_por: ctx.sessionId }))
    const creado = await sap.crearOrden(firmado)
    consumir(ctx.sessionId, caso)
    await control(ctx.directory, id, "creado", creado.numero_oc, v.retroactiva, [], v.confirmaciones)
    return { ...creado, idempotente: false }
  }),
}
