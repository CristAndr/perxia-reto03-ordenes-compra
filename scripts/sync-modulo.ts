import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export async function contenidoModulo(): Promise<Record<string, string>> {
  const prompt = await readFile(path.join(raiz, "agent/prompt.md"), "utf8")
  const conocimiento = await readFile(path.join(raiz, "src/knowledge/ordenes-compra.md"), "utf8")
  return {
    "modulo/agent.md": `---\ndescription: Agente de órdenes de compra SAP simulado.\nmode: primary\npermission:\n  edit: deny\n  bash: deny\n---\n\n${prompt}`,
    "modulo/skill/ordenes-compra/SKILL.md": `---\nname: ordenes-compra\ndescription: Controles RC1-RC10 y conocimiento del proceso de órdenes de compra.\n---\n\n${conocimiento}`,
  }
}
async function main() {
  for (const [relativa, contenido] of Object.entries(await contenidoModulo())) {
    const destino = path.join(raiz, relativa)
    await mkdir(path.dirname(destino), { recursive: true })
    await writeFile(destino, contenido, "utf8")
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
