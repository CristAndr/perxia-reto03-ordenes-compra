import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as oc from "./src/tools/oc.ts"
import { hash, aprobar } from "./src/domain/oc-estado.ts"
import { OrdenCompra, type Paquete, type ResultadoValidacion } from "./src/domain/oc.ts"
import { SapMock } from "./src/sap/mock.ts"
import { contenidoModulo } from "./scripts/sync-modulo.ts"
import * as modulo from "./modulo/tools/oc.ts"

const raiz = path.dirname(fileURLToPath(import.meta.url))
interface Respuesta<T> { ok: boolean; data: T; error?: string }
const parse = <T>(value: string): Respuesta<T> => JSON.parse(value) as Respuesta<T>
async function main() {
  await rm(path.join(raiz, "out"), { recursive: true, force: true })
  const ctx = { directory: raiz, sessionId: "demo-oc" }
  const casos = (await readdir(path.join(raiz, "fixtures/reto-03/solicitudes"))).sort()
  assert.deepEqual(casos, ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"])
  const esperado: Record<string, { apta: boolean; confirmar: boolean; retro: boolean }> = {
    "sol-001": { apta: true, confirmar: false, retro: false }, "sol-002": { apta: false, confirmar: false, retro: false },
    "sol-003": { apta: false, confirmar: false, retro: false }, "sol-004": { apta: true, confirmar: true, retro: false },
    "sol-005": { apta: true, confirmar: true, retro: true }, "sol-006": { apta: true, confirmar: true, retro: false },
  }
  for (const caso of casos) {
    const p = parse<Paquete>(await oc.leer_paquete.execute({ caso }, ctx))
    assert.equal(p.ok, true, `${caso} leer`)
    const v = parse<ResultadoValidacion>(await oc.validar.execute({ caso }, ctx))
    assert.equal(v.ok, true, `${caso} validar`)
    assert.equal(v.data.apta, esperado[caso].apta, `${caso} apta`)
    assert.equal(v.data.confirmaciones.length > 0, esperado[caso].confirmar, `${caso} confirmaciones`)
    assert.equal(v.data.retroactiva, esperado[caso].retro, `${caso} retroactiva`)
    if (caso === "sol-002") assert.ok(v.data.bloqueos.some((b) => b.startsWith("RC1:")), "sol-002 bloquea RC1")
    if (caso === "sol-003") {
      assert.ok(v.data.bloqueos.some((b) => b.startsWith("RC2:")), "sol-003 bloquea RC2")
      assert.ok(v.data.bloqueos.some((b) => b.startsWith("RC3:")), "sol-003 bloquea RC3 aunque el remitente no esté autorizado")
    }
    if (caso === "sol-004") assert.ok(v.data.confirmaciones.some((c) => c.startsWith("RC5:")), "sol-004 confirma RC5")
    if (caso === "sol-005") assert.ok(v.data.confirmaciones.some((c) => c.startsWith("RC8:")), "sol-005 confirma RC8")
    if (caso === "sol-006") assert.ok(v.data.confirmaciones.some((c) => c.startsWith("RC6:")), "sol-006 confirma RC6")
    let detalle = v.data.bloqueos.join(" | ") || v.data.confirmaciones.join(" | ") || "sin excepciones"
    let numero = "-"
    if (v.data.apta) {
      const construido = parse<{ payload: OrdenCompra; trazabilidad: string }>(await oc.construir_payload.execute({ caso }, ctx))
      assert.equal(construido.ok, true, `${caso} payload`)
      OrdenCompra.parse(construido.data.payload)
      const prueba = parse(await oc.crear.execute({ caso, confirmado: true }, ctx))
      if (v.data.confirmaciones.length) {
        assert.equal(prueba.ok, false, `${caso} sin confirmación humana`)
        if (caso === "sol-004" || caso === "sol-005" || caso === "sol-006") {
          assert.equal(aprobar(ctx.sessionId, caso, hash(construido.data.payload), true), true)
          const creado = parse<{ numero_oc: string }>(await oc.crear.execute({ caso, confirmado: true }, ctx))
          assert.equal(creado.ok, true, `${caso} confirmado`)
          numero = creado.data.numero_oc
        }
      } else {
        assert.equal(prueba.ok, true, `${caso} creación automática sin excepciones`)
        numero = (prueba.data as { numero_oc: string }).numero_oc
        const repetido = parse<{ numero_oc: string; idempotente: boolean }>(await oc.crear.execute({ caso }, ctx))
        assert.equal(repetido.data.numero_oc, numero, "sol-001 idempotencia: mismo número")
        assert.equal(repetido.data.idempotente, true, "sol-001 idempotencia sin segunda OC")
      }
      const evidencia = parse<{ ruta: string; pdf: string }>(await oc.generar_evidencia.execute({ caso }, ctx))
      assert.equal(evidencia.ok, true)
      assert.match(await readFile(path.join(raiz, evidencia.data.ruta), "utf8"), /SHA256: [a-f0-9]{64}/)
      assert.equal((await readFile(path.join(raiz, evidencia.data.pdf))).subarray(0, 4).toString(), "%PDF")
    } else {
      const bloqueo = parse(await oc.crear.execute({ caso }, ctx))
      assert.equal(bloqueo.ok, false, `${caso} bloqueado`)
    }
    console.log(`${caso}: apta=${v.data.apta}; bloqueos=${v.data.bloqueos.length}; confirmaciones=${v.data.confirmaciones.length}; retroactiva=${v.data.retroactiva}; OC=${numero}; ${detalle}`)
  }
  const lineas = (await readFile(path.join(raiz, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n")
  assert.equal(lineas.length, 4, "cuatro OC únicas")
  assert.deepEqual(lineas.map((l) => JSON.parse(l) as { numero_oc: string }).map((x) => x.numero_oc), ["4500000001", "4500000002", "4500000003", "4500000004"])
  const control = await readFile(path.join(raiz, "out/control.csv"), "utf8")
  assert.equal(control.trim().split("\n").length, 11, "cabecera y diez intentos")
  assert.match(control, /SOL-2026-005.*true/)
  const sap = new SapMock(raiz)
  assert.equal((await sap.buscarOrdenPorReferencia("SOL-2026-001"))?.numero_oc, "4500000001")
  assert.equal(modulo.crear, oc.crear)
  for (const [ruta, contenido] of Object.entries(await contenidoModulo())) assert.equal(await readFile(path.join(raiz, ruta), "utf8"), contenido)
  const temp = await mkdtemp(path.join(os.tmpdir(), "oc-reto03-"))
  try {
    const invalido = parse(await oc.leer_paquete.execute({ caso: "../sol-001" }, { directory: temp, sessionId: "demo" }))
    assert.equal(invalido.ok, false)
  } finally { await rm(temp, { recursive: true, force: true }) }
  console.log("Demo: 6 casos, idempotencia, confirmación, TXT/PDF, trazabilidad, controles y módulo OK")
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
