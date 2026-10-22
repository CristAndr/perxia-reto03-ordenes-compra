import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { OrdenCompra, type OrdenCompra as Orden, type ResultadoValidacion } from "./oc.ts"

export interface EstadoCaso { sessionId: string; caso: string; digest: string; validacion: ResultadoValidacion; payload: Orden; aprobado: boolean; vence: number }
const estados = new Map<string, EstadoCaso>()
const llave = (sessionId: string, caso: string) => `${sessionId}:${caso}`
export function hash(payload: Orden): string { return createHash("sha256").update(JSON.stringify(payload)).digest("hex") }
export function preparar(sessionId: string, caso: string, payload: Orden, validacion: ResultadoValidacion): EstadoCaso {
  const estado = { sessionId, caso, payload, validacion, digest: hash(payload), aprobado: false, vence: Date.now() + 10 * 60_000 }
  estados.set(llave(sessionId, caso), estado)
  return estado
}
export function pendiente(sessionId: string, caso: string): EstadoCaso | undefined {
  const e = estados.get(llave(sessionId, caso))
  if (!e || e.vence <= Date.now()) { estados.delete(llave(sessionId, caso)); return undefined }
  return e
}
export function aprobar(sessionId: string, caso: string, digest: string, humano = false): boolean {
  const e = pendiente(sessionId, caso)
  if (!humano || !e || !e.validacion.apta || e.digest !== digest) return false
  e.aprobado = true
  return true
}
export function consumir(sessionId: string, caso: string): void { estados.delete(llave(sessionId, caso)) }
export function olvidar(sessionId: string): void { for (const e of estados.values()) if (e.sessionId === sessionId) consumir(sessionId, e.caso) }
export async function control(raiz: string, solicitud_id: string, resultado: string, numero_oc: string, retroactiva: boolean, bloqueos: string[], confirmaciones: string[]): Promise<void> {
  const archivo = path.join(raiz, "out", "control.csv")
  await mkdir(path.dirname(archivo), { recursive: true })
  const csv = (v: string) => `"${v.replaceAll('"', '""').replace(/[\r\n]/g, " ")}"`
  let existe = true
  try { await readFile(archivo) } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") existe = false; else throw e }
  if (!existe) await appendFile(archivo, "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n")
  await appendFile(archivo, [solicitud_id, resultado, numero_oc, String(retroactiva), bloqueos.join(" | "), confirmaciones.join(" | "), new Date().toISOString()].map(csv).join(",") + "\n")
}
export function coincide(estado: EstadoCaso, payload: unknown): boolean {
  const parsed = OrdenCompra.safeParse(payload)
  return parsed.success && hash(parsed.data) === estado.digest && JSON.stringify(parsed.data) === JSON.stringify(estado.payload)
}
