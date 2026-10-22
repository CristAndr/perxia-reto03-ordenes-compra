import { z } from "zod"
import * as oc from "./oc.ts"
import type { ContextoHerramienta } from "./tipos.ts"

export interface HerramientaRegistrada {
  nombre: string
  descripcion: string
  parametros: Record<string, unknown>
  ejecutar(args: unknown, ctx: ContextoHerramienta): Promise<string>
}
interface Definicion {
  description: string
  args: Record<string, z.ZodType>
  execute(args: never, ctx: ContextoHerramienta): Promise<string>
}
export const herramientas: HerramientaRegistrada[] = Object.entries(oc).filter(([, v]) => typeof v === "object" && v !== null && "args" in v).map(([nombre, valor]) => {
  const def = valor as Definicion
  const schema = z.object(def.args).strict()
  return {
    nombre: `oc_${nombre}`, descripcion: def.description, parametros: z.toJSONSchema(schema) as Record<string, unknown>,
    async ejecutar(args: unknown, ctx: ContextoHerramienta) {
      const validado = schema.safeParse(args)
      if (!validado.success) return JSON.stringify({ ok: false, error: `argumentos inválidos: ${validado.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}` })
      return (def.execute as (a: unknown, c: ContextoHerramienta) => Promise<string>)(validado.data, ctx)
    },
  }
})
export const buscarHerramienta = (nombre: string) => herramientas.find((h) => h.nombre === nombre)
