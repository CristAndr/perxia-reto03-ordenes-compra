import { appendFile, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { OrdenCompra, type OrdenCompra as Orden } from "../domain/oc.ts"
import type { SapAdapter } from "./adapter.ts"

const Registro = z.object({ numero_oc: z.string(), fecha: z.string(), orden: OrdenCompra })
const RegistroProveedor = z.array(z.object({ codigo_sap: z.string(), nit: z.string(), activo: z.boolean() }))

export class SapMock implements SapAdapter {
  constructor(private readonly raiz: string) {}
  private archivo() { return path.join(this.raiz, "out", "sap", "ordenes.jsonl") }
  private async registros() {
    const texto = await readFile(this.archivo(), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return ""; throw e })
    return texto.trim() ? texto.trim().split("\n").map((linea) => Registro.parse(JSON.parse(linea))) : []
  }
  async consultarProveedor(nit: string) {
    const ps = RegistroProveedor.parse(JSON.parse(await readFile(path.join(this.raiz, "fixtures/reto-03/maestros/proveedores.json"), "utf8")))
    const p = ps.find((v) => v.nit === nit)
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }
  async obtenerOrdenPorReferencia(solicitud_id: string) {
    return (await this.registros()).find((v) => v.orden.referencia.solicitud_id === solicitud_id) ?? null
  }
  async buscarOrdenPorReferencia(solicitud_id: string) {
    const e = await this.obtenerOrdenPorReferencia(solicitud_id)
    return e ? { numero_oc: e.numero_oc } : null
  }
  async crearOrden(orden: Orden): Promise<{ numero_oc: string; fecha: string }> {
    const valida = OrdenCompra.parse(orden)
    const proveedor = await this.consultarProveedor(valida.proveedor.nit)
    if (!proveedor?.activo || proveedor.codigo_sap !== valida.proveedor.codigo_sap) throw new Error("proveedor SAP inválido")
    const registros = await this.registros()
    const anterior = registros.find((v) => v.orden.referencia.solicitud_id === valida.referencia.solicitud_id)
    if (anterior) return { numero_oc: anterior.numero_oc, fecha: anterior.fecha }
    const numero_oc = String(Math.max(4500000000, ...registros.map((v) => Number(v.numero_oc))) + 1)
    const fecha = new Date().toISOString()
    await mkdir(path.dirname(this.archivo()), { recursive: true })
    await appendFile(this.archivo(), JSON.stringify({ numero_oc, fecha, orden: valida }) + "\n")
    return { numero_oc, fecha }
  }
}
