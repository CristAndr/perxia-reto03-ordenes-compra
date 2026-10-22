function entero(nombre: string, predeterminado: number): number {
  const n = Number(process.env[nombre])
  return Number.isSafeInteger(n) && n > 0 ? n : predeterminado
}
const puerto = entero("PORT", 3000)
export const config = {
  proveedor: process.env.LLM_PROVIDER ?? "anthropic",
  modelo: process.env.LLM_MODEL ?? "claude-opus-5",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  maxIter: entero("MAX_ITER", 25),
  maxTokensSesion: entero("MAX_TOKENS_SESION", 150000),
  rateLimitPorMin: entero("RATE_LIMIT_POR_MIN", 10),
  timeoutMs: entero("LLM_TIMEOUT_MS", 60000),
  puerto,
}
