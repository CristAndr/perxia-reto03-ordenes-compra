import type { Context } from "hono"

export function ipCliente(c: Context): string {
  if (process.env.RENDER || process.env.NODE_ENV === "production") {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").map((value) => value.trim()).filter(Boolean)
    return c.req.header("cf-connecting-ip") ?? forwarded?.at(-1) ?? "desconocida"
  }
  return "local"
}
