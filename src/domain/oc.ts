import { z } from "zod"

export const Caso = z.string().regex(/^sol-00[1-6]$/)
export const Solicitud = z.object({
  solicitud_id: z.string().min(1), solicitante: z.string().min(1), proveedor_nombre: z.string().min(1), proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1), centro_costo: z.string().min(1), subarea: z.string().min(1), cantidad: z.number().positive().finite(),
  valor_unitario: z.number().nonnegative().finite(), valor_total: z.number().positive().finite(), moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(), condiciones_pago: z.string().optional(), fecha_solicitud: z.iso.date(),
})
export const Correo = z.object({ id: z.string(), de: z.string(), asunto: z.string(), fecha: z.string(), cuerpo: z.string(), adjuntos: z.array(z.string()) })
export const Aprobacion = z.object({ de: z.string(), para: z.string(), fecha: z.iso.datetime({ offset: true }), asunto: z.string(), cuerpo: z.string() })
export const Paquete = z.object({
  correo: Correo.pick({ id: true, de: true, asunto: true, fecha: true }), solicitud: Solicitud,
  cotizacion: z.object({ proveedor: z.string(), nit: z.string().nullable(), total: z.number(), moneda: z.string(), validez_hasta: z.string().nullable(), texto: z.string() }).nullable(),
  aprobacion: z.object({ de: z.string(), fecha: z.string(), aprobado: z.boolean(), texto: z.string() }).nullable(),
  factura: z.object({ numero: z.string(), fecha: z.iso.date(), total: z.number() }).nullable(),
  faltantes: z.array(z.string()),
})
export const OrdenCompra = z.object({
  referencia: z.object({ solicitud_id: z.string().min(1), correo_id: z.string().min(1), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"), organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]), condiciones_pago: z.string().min(1),
  aprobador: z.object({ email: z.email(), fecha_aprobacion: z.string().min(1), evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  posiciones: z.array(z.object({ numero: z.number().int().positive().multipleOf(10), descripcion: z.string().min(1).max(40), cantidad: z.number().positive(), unidad: z.enum(["UN", "H", "MES"]), precio_unitario: z.number().nonnegative(), centro_costo: z.string().min(1), subarea: z.string().min(1), indicador_iva: z.string().min(1) })).min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
export type Paquete = z.infer<typeof Paquete>
export type OrdenCompra = z.infer<typeof OrdenCompra>
export type ResultadoValidacion = { apta: boolean; bloqueos: string[]; confirmaciones: string[]; derivados: Record<string, string>; retroactiva: boolean }
