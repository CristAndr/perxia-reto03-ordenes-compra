import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { z } from "zod"
import { Aprobacion, Caso, Correo, OrdenCompra, Paquete, Solicitud, type ResultadoValidacion } from "./oc.ts"

const proveedores = z.array(z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string(), condiciones_pago_default: z.string(), indicador_iva_default: z.string(), activo: z.boolean() }))
const centros = z.array(z.object({ centro_costo: z.string(), subareas: z.array(z.string()), aprobadores: z.array(z.object({ email: z.string(), tope: z.number() })) }))
const catalogo = z.array(z.object({ codigo: z.string() }))

export const salida = (raiz: string, caso: string) => path.join(raiz, "out", caso)
const entrada = (raiz: string, caso: string, nombre: string) => path.join(raiz, "fixtures", "reto-03", "solicitudes", caso, nombre)
async function jsonArchivo<T>(ruta: string, schema: { parse: (value: unknown) => T }): Promise<T> {
  return schema.parse(JSON.parse(await readFile(ruta, "utf8")))
}
async function opcional(ruta: string): Promise<string | null> {
  try { return await readFile(ruta, "utf8") } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e }
}
export function casoValido(caso: string): void { Caso.parse(caso) }
export async function leer(raiz: string, caso: string): Promise<Paquete> {
  casoValido(caso)
  const correo = await jsonArchivo(entrada(raiz, caso, "correo.json"), Correo)
  const solicitud = await jsonArchivo(entrada(raiz, caso, "solicitud.json"), Solicitud)
  if (!correo.adjuntos.includes("solicitud.xlsx")) throw new Error("solicitud.xlsx no figura en adjuntos")
  const faltantes: string[] = []
  const cotText = await opcional(entrada(raiz, caso, "cotizacion.txt"))
  const apText = await opcional(entrada(raiz, caso, "aprobacion.json"))
  const facText = await opcional(entrada(raiz, caso, "factura.txt"))
  if (!cotText || !correo.adjuntos.includes("cotizacion.pdf")) faltantes.push("cotizacion.pdf")
  if (!apText || !correo.adjuntos.includes("aprobacion.eml")) faltantes.push("aprobacion.eml")
  if (correo.adjuntos.includes("factura.pdf") && !facText) faltantes.push("factura.pdf")
  const aprobacion = apText && correo.adjuntos.includes("aprobacion.eml") ? Aprobacion.parse(JSON.parse(apText)) : null
  let cotizacion: Paquete["cotizacion"] = null
  if (cotText && correo.adjuntos.includes("cotizacion.pdf")) {
    const total = cotText.match(/^TOTAL[^\n]*?:\s*(?:COP|USD)\s*([\d.,]+)/im)
    const nombre = cotText.match(/^Proveedor:\s*(.+)$/im)
    const moneda = total?.[0].match(/\b(COP|USD)\b/)?.[1]
    if (!total || !nombre || !moneda) throw new Error("cotización incompleta: falta proveedor, moneda o TOTAL")
    const fecha = cotText.match(/^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)?.[1]
    const dias = cotText.match(/Validez de la oferta:\s*(\d+)\s*días/i)?.[1]
    const hasta = fecha && dias ? new Date(Date.parse(`${fecha}T12:00:00Z`) + Number(dias) * 86400000).toISOString().slice(0, 10) : null
    const valor = Number(total[1].replace(/[.,]/g, ""))
    if (!Number.isFinite(valor) || valor <= 0) throw new Error("cotización con monto no numérico")
    cotizacion = { proveedor: nombre[1].trim(), nit: cotText.match(/^NIT:\s*([\d.]+(?:-\d+)?)/im)?.[1] ?? null, total: valor, moneda, validez_hasta: hasta, texto: cotText }
  }
  let factura: Paquete["factura"] = null
  if (facText && correo.adjuntos.includes("factura.pdf")) {
    const numero = facText.match(/No\.\s*([\w-]+)/i)?.[1]
    const fecha = facText.match(/Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
    const total = facText.match(/^TOTAL:\s*(?:COP|USD)\s*([\d.,]+)/im)?.[1]
    if (!numero || !fecha || !total) throw new Error("factura incompleta: falta número, fecha o TOTAL")
    const valor = Number(total.replace(/[.,]/g, ""))
    if (!Number.isFinite(valor) || valor <= 0) throw new Error("factura con monto no numérico")
    factura = { numero, fecha, total: valor }
  }
  return Paquete.parse({ correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha }, solicitud, cotizacion,
    aprobacion: aprobacion ? { de: aprobacion.de, fecha: aprobacion.fecha, aprobado: /\baprobado\b/i.test(aprobacion.cuerpo), texto: aprobacion.cuerpo } : null, factura, faltantes })
}
export async function validar(raiz: string, p: Paquete): Promise<ResultadoValidacion> {
  const s = p.solicitud
  const [ps, cs, ivas, pagos] = await Promise.all([
    jsonArchivo(path.join(raiz, "fixtures/reto-03/maestros/proveedores.json"), proveedores),
    jsonArchivo(path.join(raiz, "fixtures/reto-03/maestros/centros-costo.json"), centros),
    jsonArchivo(path.join(raiz, "fixtures/reto-03/maestros/indicadores-iva.json"), catalogo),
    jsonArchivo(path.join(raiz, "fixtures/reto-03/maestros/condiciones-pago.json"), catalogo),
  ])
  const normal = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "")
  const prov = ps.find((v) => s.proveedor_nit ? normal(v.nit) === normal(s.proveedor_nit) : normal(v.nombre) === normal(s.proveedor_nombre))
  const cc = cs.find((v) => v.centro_costo === s.centro_costo)
  const aprobador = cc?.aprobadores.find((v) => v.email.toLowerCase() === p.aprobacion?.de.toLowerCase())
  const topeCentro = cc ? Math.max(...cc.aprobadores.map((v) => v.tope), 0) : 0
  const topeAplicable = aprobador?.tope ?? topeCentro
  const bloqueos: string[] = [], confirmaciones: string[] = [], derivados: Record<string, string> = {}
  if (!prov || !prov.activo) bloqueos.push("RC1: proveedor inexistente o inactivo; solicitar alta o activación en el maestro")
  if (p.cotizacion && prov && (normal(p.cotizacion.proveedor) !== normal(prov.nombre) || (p.cotizacion.nit && !normal(p.cotizacion.nit).startsWith(normal(prov.nit))))) bloqueos.push("Cotización corresponde a otro proveedor; solicitar cotización correcta")
  if (!p.aprobacion?.aprobado || !aprobador) bloqueos.push("RC2: falta aprobación válida del aprobador del centro de costo; pedir aprobación autorizada")
  if (p.faltantes.includes("factura.pdf")) bloqueos.push("Factura anunciada pero ausente; pedir soporte al solicitante")
  if (cc && s.valor_total > topeAplicable) {
    const detalle = aprobador ? `tope ${aprobador.tope}` : `tope máximo ${topeCentro} del centro`
    bloqueos.push(`RC3: monto ${s.valor_total} excede ${detalle}; escalar a aprobador con autoridad`)
  }
  if (!cc?.subareas.includes(s.subarea)) bloqueos.push("RC4: subárea no pertenece al centro de costo; corregir solicitud")
  if (!p.cotizacion) confirmaciones.push("RC5: no hay cotización; confirmar excepción")
  else {
    if (p.cotizacion.moneda !== s.moneda) bloqueos.push("RC5: moneda de cotización distinta de solicitud; corregir documentos")
    if (s.valor_total > 0 && Math.abs(p.cotizacion.total - s.valor_total) / s.valor_total > .02) confirmaciones.push(`RC5: solicitud ${s.valor_total} ${s.moneda} vs cotización ${p.cotizacion.total} ${p.cotizacion.moneda}; confirmar diferencia`)
  }
  if (!s.indicador_iva) {
    if (prov?.indicador_iva_default) { derivados.indicador_iva = prov.indicador_iva_default; confirmaciones.push(`RC6: IVA ausente; confirmar indicador ${derivados.indicador_iva} del maestro`) }
    else bloqueos.push("RC6: falta indicador IVA y no hay valor maestro; solicitarlo")
  }
  if (!s.condiciones_pago) {
    if (prov?.condiciones_pago_default) derivados.condiciones_pago = prov.condiciones_pago_default
    else bloqueos.push("RC7: faltan condiciones de pago; solicitar dato")
  }
  if (!(ivas.some((v) => v.codigo === (s.indicador_iva ?? derivados.indicador_iva)))) bloqueos.push("Indicador IVA no existe en maestro")
  if (!(pagos.some((v) => v.codigo === (s.condiciones_pago ?? derivados.condiciones_pago)))) bloqueos.push("Condición de pago no existe en maestro")
  const retroactiva = Boolean(p.factura && p.factura.fecha < s.fecha_solicitud)
  if (retroactiva) confirmaciones.push(`RC8: OC retroactiva; factura ${p.factura?.fecha} anterior a solicitud ${s.fecha_solicitud}; confirmar excepción`)
  if (p.aprobacion && p.aprobacion.fecha.slice(0, 10) < s.fecha_solicitud) confirmaciones.push(`RC9: aprobación ${p.aprobacion.fecha} anterior a solicitud ${s.fecha_solicitud}; confirmar`)
  if (Math.abs(s.cantidad * s.valor_unitario - s.valor_total) > 1) bloqueos.push("RC10: cantidad × valor unitario no cuadra con total; corregir solicitud")
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva }
}
export async function evidencia(raiz: string, caso: string): Promise<{ ruta: string; pdf: string; sha256: string }> {
  casoValido(caso)
  const paquete = await leer(raiz, caso)
  if (!paquete.aprobacion) throw new Error("no hay correo de aprobación")
  const a = await jsonArchivo(entrada(raiz, caso, "aprobacion.json"), Aprobacion)
  const texto = `De: ${a.de}\nPara: ${a.para}\nFecha: ${a.fecha}\nAsunto: ${a.asunto}\n\n${a.cuerpo}\n`
  const sha256 = createHash("sha256").update(texto).digest("hex")
  const contenido = `${texto}\nSHA256: ${sha256}\n`
  const carpeta = salida(raiz, caso)
  await mkdir(carpeta, { recursive: true })
  await writeFile(path.join(carpeta, "aprobacion.txt"), contenido)
  const pdf = await PDFDocument.create()
  let pagina = pdf.addPage([595, 842])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  let y = 800
  for (const linea of contenido.split("\n")) {
    for (const fragmento of linea.match(/.{1,80}/gu) ?? [""]) {
      if (y < 35) { pagina = pdf.addPage([595, 842]); y = 800 }
      pagina.drawText(fragmento, { x: 35, y, size: 10, font })
      y -= 15
    }
  }
  await writeFile(path.join(carpeta, "aprobacion.pdf"), await pdf.save())
  return { ruta: `out/${caso}/aprobacion.txt`, pdf: `out/${caso}/aprobacion.pdf`, sha256 }
}
export async function construir(raiz: string, caso: string, p: Paquete, v: ResultadoValidacion): Promise<{ payload: OrdenCompra; trazabilidad: string }> {
  casoValido(caso)
  if (!v.apta || !p.aprobacion) throw new Error("no se puede construir payload: hay bloqueos o falta aprobación")
  const ps = await jsonArchivo(path.join(raiz, "fixtures/reto-03/maestros/proveedores.json"), proveedores)
  const normal = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "")
  const prov = ps.find((x) => p.solicitud.proveedor_nit ? normal(x.nit) === normal(p.solicitud.proveedor_nit) : normal(x.nombre) === normal(p.solicitud.proveedor_nombre))
  if (!prov?.activo) throw new Error("proveedor no válido")
  const e = await evidencia(raiz, caso)
  const s = p.solicitud
  const payload = OrdenCompra.parse({ referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.texto.match(/^COTIZACIÓN\s+([^\s]+)/i)?.[1] ?? null },
    sociedad: "1000", organizacion_compras: "1000", proveedor: { codigo_sap: prov.codigo_sap, nit: prov.nit, nombre: prov.nombre }, moneda: s.moneda,
    condiciones_pago: s.condiciones_pago ?? v.derivados.condiciones_pago, aprobador: { email: p.aprobacion.de, fecha_aprobacion: p.aprobacion.fecha, evidencia_sha256: e.sha256 },
    posiciones: [{ numero: 10, descripcion: s.descripcion.slice(0, 40), cantidad: s.cantidad, unidad: /\bhoras?\b/i.test(s.descripcion) ? "H" : "UN", precio_unitario: s.valor_unitario, centro_costo: s.centro_costo, subarea: s.subarea, indicador_iva: s.indicador_iva ?? v.derivados.indicador_iva }],
    excepciones: v.confirmaciones.map((detalle) => ({ codigo: detalle.split(":")[0], detalle, confirmado_por: null })) })
  const trazas: Record<string, string> = {
    "referencia.solicitud_id": "solicitud", "referencia.correo_id": "correo", "referencia.cotizacion_ref": "cotizacion", sociedad: "derivado", organizacion_compras: "derivado",
    "proveedor.codigo_sap": "maestro.proveedores", "proveedor.nit": "maestro.proveedores", "proveedor.nombre": "maestro.proveedores", moneda: "solicitud",
    condiciones_pago: s.condiciones_pago ? "solicitud" : "maestro.proveedores", "aprobador.email": "aprobacion", "aprobador.fecha_aprobacion": "aprobacion", "aprobador.evidencia_sha256": "derivado.aprobacion",
    "posiciones.0.numero": "derivado", "posiciones.0.descripcion": "solicitud", "posiciones.0.cantidad": "solicitud", "posiciones.0.unidad": "derivado.solicitud", "posiciones.0.precio_unitario": "solicitud", "posiciones.0.centro_costo": "solicitud", "posiciones.0.subarea": "solicitud", "posiciones.0.indicador_iva": s.indicador_iva ? "solicitud" : "maestro.proveedores", excepciones: "derivado.validacion",
  }
  await writeFile(path.join(salida(raiz, caso), "trazabilidad.json"), JSON.stringify(trazas, null, 2))
  return { payload, trazabilidad: `out/${caso}/trazabilidad.json` }
}
