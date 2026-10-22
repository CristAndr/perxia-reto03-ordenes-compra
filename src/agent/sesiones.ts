import type { Mensaje } from "../llm/adapter.ts"

export interface ToolCallVisible { nombre: string; args: unknown; ok: boolean; resumen: string; resultado: unknown }
export interface EntradaHistorial { rol: "user" | "assistant"; texto: string; ts: string; toolCalls?: ToolCallVisible[]; needsConfirmation?: boolean; casoPendiente?: string; payload?: unknown }
export interface Sesion {
  id: string
  mensajes: Mensaje[]
  historial: EntradaHistorial[]
  tokens: number
  pendiente?: { caso: string; digest: string; payload: unknown; desde: number }
}
export const PATRON_SESION = /^[A-Za-z0-9_-]{8,64}$/
const sesiones = new Map<string, Sesion>()
export function obtenerSesion(id: string): Sesion {
  let s = sesiones.get(id)
  if (!s) {
    if (sesiones.size >= 500) { const primera = sesiones.keys().next().value; if (primera) sesiones.delete(primera) }
    s = { id, mensajes: [], historial: [], tokens: 0 }
    sesiones.set(id, s)
  }
  return s
}
export function eliminarSesion(id: string): void { sesiones.delete(id) }
export function buscarSesion(id: string): Sesion | undefined { return sesiones.get(id) }
