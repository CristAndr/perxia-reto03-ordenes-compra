import Groq from "groq-sdk"
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions"
import { esquemaLimpio, type DefinicionHerramienta, type LlamadaHerramienta, type LlmAdapter, type Mensaje, type RespuestaLlm } from "./adapter.ts"

function convertir(mensajes: Mensaje[]): ChatCompletionMessageParam[] {
  return mensajes.map((mensaje) => {
    if (mensaje.rol === "tool") return { role: "tool", content: mensaje.contenido, tool_call_id: mensaje.id }
    if (mensaje.rol === "assistant") {
      return {
        role: "assistant",
        content: mensaje.texto || null,
        tool_calls: mensaje.llamadas.map((llamada) => ({
          id: llamada.id,
          type: "function",
          function: { name: llamada.nombre, arguments: JSON.stringify(llamada.args ?? {}) },
        })),
      }
    }
    return { role: mensaje.rol, content: mensaje.texto }
  })
}

function argumentos(valor: string): unknown {
  try {
    return JSON.parse(valor) as unknown
  } catch {
    return {}
  }
}

export function crearGroq(modelo: string, timeoutMs: number): LlmAdapter {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error("falta GROQ_API_KEY en el entorno del backend")
  const cliente = new Groq({ apiKey, timeout: timeoutMs, maxRetries: 1 })
  return {
    proveedor: "groq",
    modelo,
    async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLlm> {
      const respuesta = await cliente.chat.completions.create({
        model: modelo,
        messages: convertir(mensajes),
        tools: herramientas.map((herramienta) => ({
          type: "function" as const,
          function: {
            name: herramienta.nombre,
            description: herramienta.descripcion,
            parameters: esquemaLimpio(herramienta.parametros),
          },
        })),
        tool_choice: "auto",
        temperature: 0,
        max_tokens: 2048,
      })
      const mensaje = respuesta.choices[0]?.message
      const llamadas: LlamadaHerramienta[] = (mensaje?.tool_calls ?? []).map((llamada) => ({
        id: llamada.id,
        nombre: llamada.function.name,
        args: argumentos(llamada.function.arguments),
      }))
      return {
        texto: mensaje?.content ?? "",
        llamadas,
        tokens: (respuesta.usage?.prompt_tokens ?? 0) + (respuesta.usage?.completion_tokens ?? 0),
      }
    },
  }
}
