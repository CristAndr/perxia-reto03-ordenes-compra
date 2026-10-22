# Reto 03 — Órdenes de Compra SAP

Agente conversacional independiente con chat Hono/HTML, validación RC1–RC10, evidencia TXT/PDF y SAP simulado. Usa únicamente los fixtures ficticios `fixtures/reto-03` para las compras.

## Arranque local

Node 20+; instala dependencias con `npm install`, copia `.env.example` a `.env`, configura el proveedor y ejecuta `npm run dev`. Abre `http://localhost:3000`. No requiere clave de acceso. `npm start` levanta el mismo front y backend sin watch.

### Groq Cloud

1. Crea una API key en tu cuenta Groq Cloud.
2. En `.env`, conserva `LLM_PROVIDER=groq` y usa un modelo habilitado en tu cuenta; el ejemplo usa `LLM_MODEL=openai/gpt-oss-20b`.
3. Pega la clave solo en `GROQ_API_KEY=`. No la compartas por chat, no la pongas en el frontend y no la subas al repositorio.
4. Ejecuta `npm run dev` y verifica `GET /api/health`: debe responder `available: true`.

La cuota gratuita, modelos disponibles y límites dependen de tu cuenta Groq; verifica esos valores en su consola antes de desplegar. Para Anthropic usa `LLM_PROVIDER=anthropic` y `ANTHROPIC_API_KEY`; para Ollama usa `LLM_PROVIDER=ollama`, un modelo local y `OLLAMA_URL`.

`npm run demo` limpia `out/` y ejecuta seis casos sin modelo, con creación automática del caso normal, idempotencia y confirmación humana para excepciones; `npm run typecheck` comprueba TypeScript strict. `npm run sync-modulo` regenera las piezas del bonus. No ejecutes demo mientras el servidor esté usando `out/`.

## Variables

`LLM_PROVIDER` (`groq`, `anthropic` u `ollama`), `LLM_MODEL`, `GROQ_API_KEY` (solo backend Groq), `ANTHROPIC_API_KEY` (solo backend Anthropic), `OLLAMA_URL` (solo Ollama), `MAX_ITER`, `MAX_TOKENS_SESION`, `RATE_LIMIT_POR_MIN`, `LLM_TIMEOUT_MS`, `PORT`. Ver `.env.example`.

## API

`POST /api/chat` `{ "sessionId": "s-...", "message": "Procesa sol-004" }` → `{ reply, toolCalls, needsConfirmation, casoPendiente, payload }`; `GET /api/sessions/:id` devuelve historial; `DELETE /api/sessions/:id` elimina sesión. `GET /api/health` devuelve proveedor, modelo y disponibilidad, sin secretos. El chat limita peticiones, pasos y tokens por sesión. Los archivos de `out/` y `fixtures/` no se sirven públicamente.

## Demo pública con Render

El repositorio incluye `render.yaml`. En Render crea un Blueprint desde el repositorio, conserva el plan disponible para tu cuenta y agrega manualmente `GROQ_API_KEY` en **Environment**. La clave nunca se guarda en `render.yaml`, `.env.example`, Git ni el frontend. Tras el despliegue, verifica `<URL>/api/health`: debe informar `provider: "groq"` y `available: true`.

El servicio usa filesystem efímero: `out/` y las sesiones se reinician en cada redeploy. Es aceptable para la demo; producción requiere almacenamiento persistente y control de concurrencia.
