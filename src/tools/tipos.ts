import type { z } from "zod"

export interface ContextoHerramienta { directory: string; sessionId: string }
export interface Herramienta<A extends Record<string, z.ZodType> = Record<string, z.ZodType>> {
  description: string
  args: A
  execute(args: { [K in keyof A]: z.infer<A[K]> }, ctx: ContextoHerramienta): Promise<string>
}
