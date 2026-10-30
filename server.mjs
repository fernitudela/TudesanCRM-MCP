#!/usr/bin/env node
// TudesanCRM-Cloud — local read-only MCP server.
//
// Exposes the cloud CRM (operations, clients, documents, timeline, banks,
// simulations) to Claude as MCP tools. It is a thin wrapper over the existing
// REST API of the Worker at TUDESAN_BASE_URL; it never touches D1/R2 directly.
//
// Auth: the Worker sits behind Cloudflare Access. This server obtains a short
// lived Access JWT by shelling out to `cloudflared access token` (which uses
// the Google SSO session you established once with `cloudflared access login`)
// and sends it as the `cf-access-token` header on every request. Cloudflare
// Access validates it and injects `Cf-Access-Authenticated-User-Email`, so the
// Worker resolves you as admin and the RBAC layer returns everything.
//
// Most tools are GET-only (including list_doc_templates, which reads the org's
// configured HTML document templates). The write tools (create_client,
// update_client, update_operation, create_operation_update, edit_operation_update,
// create_bank, update_bank, create_operation_bank, update_operation_bank,
// delete_operation_bank, create_loan, create_inmueble, create_simulation,
// create_document_request, upsert_doc_template, rename_document) follow a two-step
// preview/confirm pattern: called without `confirm: true` they return the
// diff that WOULD be applied and write nothing; only `confirm: true` actually
// hits the Worker. This is on top of Claude Code's per-call permission prompt.
// Still intentionally NOT exposed: creating/deleting operations and any other
// DELETE (clients, loans, inmuebles, simulations, banks, documents). The only
// deletes are delete_operation_bank and edit_operation_update(delete:true).
//
// Env vars (all optional, sensible defaults):
//   TUDESAN_BASE_URL    API origin (default https://tudesancrm-cloud.fernitudela.workers.dev)
//   TUDESAN_APP_URL     Access app URL for cloudflared (default = TUDESAN_BASE_URL)
//   CLOUDFLARED_PATH    path to cloudflared binary (default "cloudflared" on PATH)
//   TUDESAN_MAX_FILE_MB max attachment size to inline, MB (default 25)
//   TUDESAN_ORG_ID      empresa activa por defecto (multi-empresa). Si se omite y
//                       perteneces a varias, el backend usa tu primera empresa;
//                       cámbiala con la tool select_company.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const execFileP = promisify(execFile);

const BASE_URL = (process.env.TUDESAN_BASE_URL ||
  'https://tudesancrm-cloud.fernitudela.workers.dev').replace(/\/+$/, '');
const APP_URL = (process.env.TUDESAN_APP_URL || BASE_URL).replace(/\/+$/, '');
const CLOUDFLARED = process.env.CLOUDFLARED_PATH || 'cloudflared';
const MAX_FILE_BYTES =
  (Number(process.env.TUDESAN_MAX_FILE_MB) || 25) * 1024 * 1024;

// Empresa activa (multi-empresa). Viaja como cabecera X-Org-Id, que el backend
// trata como SOLICITUD y verifica contra las memberships del email de Access:
// nunca da acceso a empresas a las que el usuario no pertenece. Cambiable en
// caliente con la tool select_company.
let activeOrgId = Number.isInteger(Number(process.env.TUDESAN_ORG_ID))
  ? Number(process.env.TUDESAN_ORG_ID)
  : null;

function orgHeader() {
  return activeOrgId != null ? { 'X-Org-Id': String(activeOrgId) } : {};
}

// --- Access token handling ---------------------------------------------------

let cachedToken = null; // { jwt, expEpochSec }

const LOGIN_HINT =
  `No hay sesión válida de Cloudflare Access. Ejecuta UNA vez en tu terminal:\n` +
  `  cloudflared access login ${APP_URL}\n` +
  `Se abrirá el navegador para el SSO de Google. Cuando la sesión caduque ` +
  `(~24 h) repite ese mismo comando.`;

function looksLikeJwt(s) {
  return typeof s === 'string' && s.split('.').length === 3 && s.length > 40;
}

function jwtExp(jwt) {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')
    );
    return typeof payload.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expEpochSec - 60 > now) {
    return cachedToken.jwt;
  }
  let stdout = '';
  try {
    const res = await execFileP(
      CLOUDFLARED,
      ['access', 'token', `--app=${APP_URL}`],
      { timeout: 20000, windowsHide: true }
    );
    stdout = (res.stdout || '').trim();
  } catch (err) {
    throw new Error(
      `cloudflared falló (${err.code || err.message}). ${LOGIN_HINT}`
    );
  }
  // When not logged in, cloudflared prints a login URL / message instead of a
  // JWT. Detect that explicitly so the error is actionable.
  if (!looksLikeJwt(stdout)) {
    throw new Error(LOGIN_HINT);
  }
  cachedToken = { jwt: stdout, expEpochSec: jwtExp(stdout) || now + 600 };
  return cachedToken.jwt;
}

// --- API client --------------------------------------------------------------

async function apiFetch(path, { query } = {}) {
  const token = await getAccessToken();
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'cf-access-token': token, accept: '*/*', ...orgHeader() },
    redirect: 'manual',
  });
  // A 3xx to the Access login page means the JWT was rejected/stale.
  if (resp.status >= 300 && resp.status < 400) {
    cachedToken = null;
    throw new Error(
      `Cloudflare Access rechazó la petición (redirección a login). ${LOGIN_HINT}`
    );
  }
  return resp;
}

async function apiJson(path, query) {
  const resp = await apiFetch(path, { query });
  const text = await resp.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!resp.ok) {
    const msg =
      body && typeof body === 'object' && body.error ? body.error : resp.statusText;
    throw new Error(`API ${resp.status}: ${msg}`);
  }
  return body;
}

// Same as apiFetch but for write methods (POST/PUT/DELETE). Mirrors apiJson's
// error-shaping. body is sent as application/json if provided.
async function apiSend(method, path, body) {
  const token = await getAccessToken();
  const url = new URL(BASE_URL + path);
  const init = {
    method,
    headers: { 'cf-access-token': token, accept: '*/*', ...orgHeader() },
    redirect: 'manual',
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const resp = await fetch(url, init);
  if (resp.status >= 300 && resp.status < 400) {
    cachedToken = null;
    throw new Error(
      `Cloudflare Access rechazó la petición (redirección a login). ${LOGIN_HINT}`
    );
  }
  const text = await resp.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!resp.ok) {
    const msg =
      parsed && typeof parsed === 'object' && parsed.error
        ? parsed.error
        : resp.statusText;
    throw new Error(`API ${resp.status}: ${msg}`);
  }
  return parsed;
}

// --- Write helpers ----------------------------------------------------------

// Allowed field sets — mirror of the Worker's UPDATABLE maps so we can flag
// unknown fields in the preview instead of silently dropping them. If the
// Worker adds an editable field, also add it here (and in the README).
//   clients.ts  → UPDATABLE
//   operations.ts → UPDATABLE_COLS
const CLIENT_FIELDS = new Set([
  'operationId',
  'isTitularPrincipal',
  'isAvalista',
  'nombre',
  'dni',
  'fechaNacimiento',
  'estadoCivil',
  'regimenEconomico',
  'telefono',
  'email',
  'direccionActual',
  'regimenViviendaActual',
  'profesion',
  'empresa',
  'tipoContrato',
  'fechaAltaEmpresa',
  'salarioNeto',
  'numPagas',
  'otrosIngresos',
  'otrosIngresosDescripcion',
  'deudasMensuales',
  'otrosPrestamosDetalle',
  'notas',
]);
const OPERATION_FIELDS = new Set([
  'tipo',
  'estado',
  'titulo',
  'valorCompraventa',
  'direccionInmueble',
  'arras',
  'financiacionPctSolicitada',
  'ahorrosDisponibles',
  'numHijosACargo',
  'fechaInicio',
  'fechaCierre',
  // Plazos FEIN (ISO YYYY-MM-DD). fechaMaxFein es DERIVADA: la devuelve el
  // Worker, nunca se escribe.
  'fechaMaxOfertaBancaria',
  'fechaMaxArras',
  'folderPath',
  'honorariosInmobiliaria',
  'honorariosInmobiliariaPct',
  'honorariosTudesanAcordadoA',
  'honorariosTudesanAcordadoB',
  'referidoDe',
  'referidoId',
  'importeReferidoA',
  'importeReferidoB',
  'simUsarHonorariosAcordados',
  'simIncluirImporteReferido',
  'expedienteHtml',
  'notas',
]);
const TIMELINE_FIELDS = new Set(['texto', 'fecha', 'interno', 'expuestoReferido']);
//   banks.ts → UPDATABLE
const BANK_FIELDS = new Set(['nombre', 'contactos', 'condicionesActuales', 'notas']);
//   operationBanks.ts → UPDATABLE (sin operationId/bankId: identifican el vínculo)
const OPERATION_BANK_FIELDS = new Set([
  'contactoUsado', 'estado', 'fechaEnvio', 'fechaRespuesta', 'fechaMaxOferta',
  'tipoBonificado', 'pctFinanciacion', 'comisionApertura', 'bonificaciones', 'notas',
]);
//   loans.ts → UPDATABLE (+ clientIds = titulares asignados, relación N:N)
const LOAN_FIELDS = new Set([
  'operationId', 'cuota', 'importePendiente', 'anosRestantes', 'descripcion', 'clientIds',
]);
//   simulations.ts → UPDATABLE (snapshotJson lo calcula el Worker, no se pasa)
const SIMULATION_FIELDS = new Set([
  'operationId', 'nombre', 'modo', 'valorInmueble', 'financiacionPct', 'interesAnual', 'plazoAnos',
  'ingresosTitular1Neto', 'pagasTitular1', 'ingresosTitular2Neto', 'pagasTitular2',
  'deudasMensuales', 'otrosIngresos', 'incluirOtrosIngresos',
  'honorariosInmobiliaria', 'honorariosInmobiliariaPct', 'itpPct',
  'comisionAperturaPct', 'expuestoCliente',
  // rehipoteca inputs
  'rhCapitalPendiente', 'rhInteresOriginal', 'rhPlazoRestanteAnos', 'rhComisionCancelacionPct',
  'rhCancelacionRegistral', 'rhCancelacionRegistralCoste', 'rhTasacion',
  'rhImporteNuevo', 'rhInteresNuevo', 'rhPlazoNuevoAnos',
  'rhPfActiva', 'rhPfIrsOrigen', 'rhPfIrsActual', 'rhDiferencial',
]);

// Treat null and '' as the same "empty" value so renaming "" -> null doesn't
// look like a change. Numbers are compared as numbers; booleans as booleans;
// arrays/objects (e.g. contactos) by structural JSON equality.
function valuesEqual(a, b) {
  if (a === b) return true;
  if ((a === null || a === '') && (b === null || b === '')) return true;
  if (typeof a === 'number' && typeof b === 'string') return String(a) === b;
  if (typeof b === 'number' && typeof a === 'string') return a === String(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

// Build {changes, unchanged, unknown} comparing `incoming` vs `current` row.
// `allowed` is the Set of camelCase fields the Worker accepts.
function diffFields(current, incoming, allowed) {
  const changes = {};
  const unchanged = [];
  const unknown = [];
  for (const [k, v] of Object.entries(incoming)) {
    if (!allowed.has(k)) {
      unknown.push(k);
      continue;
    }
    const prev = current ? current[k] : undefined;
    if (valuesEqual(prev, v)) unchanged.push(k);
    else changes[k] = { from: prev ?? null, to: v };
  }
  return { changes, unchanged, unknown };
}

// Build the insert payload for a create tool: keep only allowed camelCase keys,
// list unknown ones, and report which required keys are missing/empty. Mirrors
// the Worker's required-field checks so the preview catches mistakes pre-write.
// 0 and false count as present; only undefined/null/'' are "missing".
function buildCreateEntry(fields, allowed, required) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('`fields` debe ser un objeto con los campos a crear.');
  }
  const entry = {};
  const unknown = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.has(k)) entry[k] = v;
    else unknown.push(k);
  }
  const isEmpty = (v) => v === undefined || v === null || v === '';
  const missing = required.filter((k) => isEmpty(entry[k]));
  return { entry, unknown, missing };
}

const PREVIEW_HINT =
  'Vuelve a llamar la MISMA tool con los MISMOS argumentos + `confirm: true` para aplicar el cambio.';

const jsonResult = (data) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const errResult = (e) => ({
  isError: true,
  content: [{ type: 'text', text: `Error: ${e.message || String(e)}` }],
});

// Wrap a handler so thrown errors become MCP error results, not crashes.
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return errResult(e);
  }
};

// Resolve+validate the parent operation of a to-be-created record so we never
// insert an orphan under a typo'd operationId, and so the preview/result carry
// a readable label. On 404/other error returns { op: null, error }.
async function resolveOperation(operationId) {
  if (operationId == null) return { op: null, label: 'operación (sin operationId)' };
  try {
    const op = await apiJson(`/api/operations/${operationId}`);
    return { op, label: `operation #${operationId} — ${op.titulo ?? '(sin título)'}` };
  } catch (e) {
    return { op: null, label: `operation #${operationId}`, error: e.message };
  }
}

// Factory for create tools that take a camelCase `fields` record. Validates it
// against allowed/required, checks the parent operation exists, and POSTs to
// `path` on confirm. (The {operationId, descripcion} tools use
// makeDescripcionCreateTool instead — too few fields to bother.)
function makeCreateTool({ allowed, required, path }) {
  return tool(async ({ fields, confirm }) => {
    const { entry, unknown, missing } = buildCreateEntry(fields, allowed, required);
    if (entry.clientIds !== undefined) {
      if (!Array.isArray(entry.clientIds) ||
          !entry.clientIds.every((n) => Number.isInteger(n) && n > 0)) {
        throw new Error('`clientIds` debe ser un array de IDs de titular (enteros positivos).');
      }
    }
    const { op, label, error } = await resolveOperation(entry.operationId);
    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        operationExists: !!op,
        wouldInsert: entry,
        unknown,
        missing,
        instructions:
          unknown.length
            ? `Campos desconocidos: ${unknown.join(', ')}. Quítalos antes de aplicar. ${PREVIEW_HINT}`
            : missing.length
              ? `Faltan campos requeridos: ${missing.join(', ')}. ${PREVIEW_HINT}`
              : !op
                ? `Operación ${entry.operationId} no encontrada${error ? ` (${error})` : ''}. Corrige operationId antes de aplicar. ${PREVIEW_HINT}`
                : PREVIEW_HINT,
      });
    }
    if (unknown.length) throw new Error(`Hay campos desconocidos: ${unknown.join(', ')}. No se crea nada.`);
    if (missing.length) throw new Error(`Faltan campos requeridos: ${missing.join(', ')}. No se crea nada.`);
    if (!op) throw new Error(`Operación ${entry.operationId} no encontrada${error ? ` (${error})` : ''}. No se crea nada.`);
    const result = await apiSend('POST', path, entry);
    return jsonResult({ mode: 'applied', resource: label, created: result });
  });
}

// Factory for the create tools whose payload is just {operationId, descripcion}
// (inmuebles, solicitudes de documentación): validates the parent operation and
// POSTs to `path` on confirm.
function makeDescripcionCreateTool(path) {
  return tool(async ({ operationId, descripcion, confirm }) => {
    const { op, label, error } = await resolveOperation(operationId);
    const entry = { operationId, descripcion: descripcion.trim() };
    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        operationExists: !!op,
        wouldInsert: entry,
        instructions: !op
          ? `Operación ${operationId} no encontrada${error ? ` (${error})` : ''}. Corrige operationId antes de aplicar. ${PREVIEW_HINT}`
          : PREVIEW_HINT,
      });
    }
    if (!op) throw new Error(`Operación ${operationId} no encontrada${error ? ` (${error})` : ''}. No se crea nada.`);
    const result = await apiSend('POST', path, entry);
    return jsonResult({ mode: 'applied', resource: label, created: result });
  });
}

// --- Server ------------------------------------------------------------------

const server = new McpServer({
  name: 'tudesancrm-cloud',
  version: '0.5.0',
});

server.tool(
  'whoami',
  'Devuelve la identidad, la empresa activa (activeOrg: id, nombre, slug y brandColor = color corporativo #rrggbb configurado en Ajustes → Marca, para generar documentos con la marca de la empresa) y las empresas a las que perteneces (orgs[]) con tu rol en cada una. Útil para verificar la sesión de Cloudflare Access y saber con qué empresa estás operando (multi-empresa). Usa select_company para cambiarla.',
  {},
  tool(async () => jsonResult(await apiJson('/api/me')))
);

server.tool(
  'select_company',
  'Fija la empresa activa (multi-empresa) con la que el MCP accede al CRM. Llama antes a whoami para ver las empresas disponibles (campo orgs[].id). Sólo puedes activar empresas a las que perteneces; el backend lo verifica y rechaza el resto. Necesario si perteneces a más de una empresa y no hay TUDESAN_ORG_ID configurado.',
  { orgId: z.number().int().positive().describe('ID de la empresa a activar (de whoami.orgs[].id).') },
  tool(async ({ orgId }) => {
    const prev = activeOrgId;
    activeOrgId = orgId;
    let me;
    try {
      me = await apiJson('/api/me');
    } catch (e) {
      activeOrgId = prev; // revertir si no perteneces a esa empresa (403)
      throw new Error(`No puedes activar la empresa ${orgId}: ${e.message}`);
    }
    return jsonResult({ activeOrg: me.activeOrg, role: me.role, orgs: me.orgs });
  })
);

server.tool(
  'health',
  'Comprueba que el Worker del CRM está vivo (no requiere sesión).',
  {},
  tool(async () => jsonResult(await apiJson('/api/health')))
);

server.tool(
  'list_operations',
  'Lista operaciones (expedientes) del CRM. Filtros opcionales: estado exacto y/o búsqueda de texto libre en título, dirección del inmueble y notas.',
  {
    estado: z.string().optional().describe('Filtra por estado exacto, p.ej. "En estudio".'),
    q: z.string().optional().describe('Búsqueda libre en título / dirección / notas.'),
  },
  tool(async ({ estado, q }) =>
    jsonResult(await apiJson('/api/operations', { estado, q }))
  )
);

server.tool(
  'get_operation',
  'Devuelve una operación completa por id (incluye importes/honorarios al acceder como admin). ' +
    'Plazos FEIN: `fechaMaxOfertaBancaria` (hasta cuándo el banco elegido mantiene las condiciones), ' +
    '`fechaMaxArras` (límite del contrato de arras) y `fechaMaxFein` (DERIVADA, solo lectura = ' +
    'min(fechaMaxOfertaBancaria, fechaMaxArras − 11 días); null si faltan las dos). Cuando el usuario ' +
    'pregunte por plazos o por "hasta cuándo", comunica estas tres fechas y los días que quedan.',
  { id: z.number().int().positive().describe('ID de la operación.') },
  tool(async ({ id }) => jsonResult(await apiJson(`/api/operations/${id}`)))
);

server.tool(
  'get_operation_timeline',
  'Devuelve el histórico/cronología (operation_updates) de una operación, más reciente primero.',
  { id: z.number().int().positive().describe('ID de la operación.') },
  tool(async ({ id }) =>
    jsonResult(await apiJson(`/api/operations/${id}/updates`))
  )
);

server.tool(
  'list_clients',
  'Lista clientes/titulares. Sin operationId devuelve todos (acceso admin); con operationId solo los de esa operación.',
  {
    operationId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Limita a los clientes de esta operación.'),
  },
  tool(async ({ operationId }) =>
    jsonResult(await apiJson('/api/clients', { operationId }))
  )
);

server.tool(
  'get_client',
  'Devuelve un cliente/titular completo por id (datos personales, laborales y económicos).',
  { id: z.number().int().positive().describe('ID del cliente.') },
  tool(async ({ id }) => jsonResult(await apiJson(`/api/clients/${id}`)))
);

server.tool(
  'list_documents',
  'Lista metadatos de documentos adjuntos. Filtros opcionales por operación, cliente, tipo de documento o etiqueta.',
  {
    operationId: z.number().int().positive().optional(),
    clientId: z.number().int().positive().optional(),
    tipoDoc: z.string().optional().describe('Tipo de documento exacto.'),
    tag: z.string().optional().describe('Etiqueta exacta presente en el documento.'),
  },
  tool(async (args) => jsonResult(await apiJson('/api/documents', args)))
);

server.tool(
  'get_document',
  'Devuelve los metadatos de un documento por id (nombre, tipo, etiquetas, operación, etc.).',
  { id: z.number().int().positive().describe('ID del documento.') },
  tool(async ({ id }) => jsonResult(await apiJson(`/api/documents/${id}`)))
);

server.tool(
  'read_document_file',
  'Descarga y devuelve el CONTENIDO de un documento adjunto para que Claude lo lea. Solo PDF e imágenes; otros formatos (Word/Excel) devuelven un aviso con sus metadatos.',
  { id: z.number().int().positive().describe('ID del documento a leer.') },
  tool(async ({ id }) => {
    const resp = await apiFetch(`/api/documents/${id}/open`);
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`API ${resp.status}: ${t || resp.statusText}`);
    }
    const ctype = (resp.headers.get('content-type') || '').split(';')[0].trim();
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > MAX_FILE_BYTES) {
      return {
        content: [
          {
            type: 'text',
            text: `El archivo (${(buf.byteLength / 1048576).toFixed(
              1
            )} MB, ${ctype}) supera el límite de ${(
              MAX_FILE_BYTES / 1048576
            ).toFixed(0)} MB y no se ha cargado. Sube TUDESAN_MAX_FILE_MB si lo necesitas.`,
          },
        ],
      };
    }
    const b64 = buf.toString('base64');
    if (ctype.startsWith('image/')) {
      return { content: [{ type: 'image', data: b64, mimeType: ctype }] };
    }
    if (ctype === 'application/pdf') {
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `tudesancrm://documents/${id}`,
              mimeType: 'application/pdf',
              blob: b64,
            },
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `Documento ${id}: tipo "${ctype}" no soportado para lectura directa ` +
            `(solo PDF e imágenes por ahora). Usa get_document para sus metadatos ` +
            `o ábrelo en la app.`,
        },
      ],
    };
  })
);

server.tool(
  'list_document_requests',
  'Lista las solicitudes de documentación pedidas al cliente (checklist del broker). Cada solicitud incluye "fulfilled" (true si ya hay >=1 documento enlazado), "docCount" y "docNames". Una solicitud PENDIENTE es la que tiene fulfilled=false. Filtra por operación con operationId.',
  { operationId: z.number().int().positive().optional() },
  tool(async ({ operationId }) =>
    jsonResult(await apiJson('/api/document-requests', { operationId }))
  )
);

server.tool(
  'list_operation_banks',
  'Lista los bancos asociados a operaciones (estado por banco, ofertas, fechas). Filtra por operación con operationId.',
  { operationId: z.number().int().positive().optional() },
  tool(async ({ operationId }) =>
    jsonResult(await apiJson('/api/operation-banks', { operationId }))
  )
);

server.tool(
  'list_simulations',
  'Lista simulaciones de financiación (inputs + snapshot calculado). Filtra por operación con operationId.',
  { operationId: z.number().int().positive().optional() },
  tool(async ({ operationId }) =>
    jsonResult(await apiJson('/api/simulations', { operationId }))
  )
);

server.tool(
  'list_loans',
  'Lista préstamos existentes de los titulares (cuota, importe pendiente, años restantes, descripción) con clientIds = titulares asignados. Filtra por operación con operationId.',
  { operationId: z.number().int().positive().optional() },
  tool(async ({ operationId }) =>
    jsonResult(await apiJson('/api/loans', { operationId }))
  )
);

server.tool(
  'list_inmuebles',
  'Lista inmuebles en propiedad de los titulares (descripción libre). Filtra por operación con operationId.',
  { operationId: z.number().int().positive().optional() },
  tool(async ({ operationId }) =>
    jsonResult(await apiJson('/api/inmuebles', { operationId }))
  )
);

server.tool(
  'list_banks',
  'Lista el catálogo de bancos (contactos y condiciones actuales).',
  {},
  tool(async () => jsonResult(await apiJson('/api/banks')))
);

server.tool(
  'bank_history',
  'Historial GLOBAL de bancos de la empresa activa en UNA llamada: qué ha hecho cada banco en las operaciones visibles (todos los vínculos operación-banco con el contexto de su operación: título, estado, tipo, fechas, valor y % solicitado, perfil de contrato de los titulares) más un `summary` por banco (total, porEstado, conOferta, aprobadas, contraofertas, denegadas, último envío/respuesta, tipo bonificado min/medio/max, % financiación max/medio, comisión media, días de respuesta medios, perfilesAceptados, operationIds). Cada fila trae `tieneOferta` (tipo o % rellenos, aunque el estado siga en "enviado"), `diasRespuesta` y `cuentaComoAprobada` (estado aprobado, o oferta en una operación aprobada/firmada/cobrada). Úsala para recomendar banco por experiencia real antes que por el catálogo. Filtros opcionales: bankId, bank (nombre, subcadena), estado del vínculo, since (YYYY-MM-DD, por fecha de envío) y limit (500 por defecto, máx. 2000). Solo lectura. Si el CRM responde 404, el Worker es anterior a esta tool: recorre list_operations + list_operation_banks por operación.',
  {
    bankId: z.number().int().positive().optional().describe('Solo este banco (id de list_banks).'),
    bank: z.string().optional().describe('Nombre del banco (subcadena, sin distinguir mayúsculas), p.ej. "sabadell".'),
    estado: z
      .enum(['no_enviado', 'enviado', 'en_estudio', 'contraoferta', 'aprobado', 'denegado', 'retirado'])
      .optional()
      .describe('Solo vínculos en este estado.'),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Solo vínculos enviados (o creados) a partir de esta fecha, YYYY-MM-DD. P.ej. los últimos 12 meses.'),
    limit: z.number().int().positive().max(2000).optional().describe('Máximo de filas (defecto 500).'),
  },
  tool(async (args) => jsonResult(await apiJson('/api/bank-history', args)))
);

// --- Write tools (preview / confirm) ----------------------------------------

server.tool(
  'update_client',
  'Edita campos de un cliente/titular. Patrón en DOS pasos: (1) llama SIN `confirm` para ver el diff (valores actuales → propuestos) sin escribir nada; (2) repite la llamada con `confirm: true` para aplicar. Solo se envían al Worker los campos que realmente cambian; los que no cambian se ignoran. Campos desconocidos (fuera del esquema editable) se listan en `unknown` y se RECHAZAN con error en confirm.',
  {
    id: z.number().int().positive().describe('ID del cliente.'),
    fields: z
      .record(z.any())
      .describe(
        'Objeto camelCase con los campos a actualizar. Permitidos: ' +
          [...CLIENT_FIELDS].join(', ') +
          '.'
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Sin este flag (o `false`) la llamada es PREVIEW y no escribe. Pásalo `true` para aplicar.'),
  },
  { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  tool(async ({ id, fields, confirm }) => {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('`fields` debe ser un objeto con los campos a actualizar.');
    }
    if (Object.keys(fields).length === 0) {
      throw new Error('`fields` está vacío: no hay nada que actualizar.');
    }
    const current = await apiJson(`/api/clients/${id}`);
    const label = `client #${id} — ${current.nombre ?? '(sin nombre)'}`;
    const { changes, unchanged, unknown } = diffFields(current, fields, CLIENT_FIELDS);

    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        changes,
        unchanged,
        unknown,
        instructions:
          unknown.length > 0
            ? `Campos desconocidos: ${unknown.join(', ')}. Quítalos o corrige el nombre antes de aplicar. ${PREVIEW_HINT}`
            : Object.keys(changes).length === 0
              ? 'No hay cambios efectivos respecto al estado actual. No se aplicará nada.'
              : PREVIEW_HINT,
      });
    }
    if (unknown.length > 0) {
      throw new Error(
        `Hay campos desconocidos: ${unknown.join(', ')}. No se aplica nada. Quítalos o usa los nombres correctos.`
      );
    }
    if (Object.keys(changes).length === 0) {
      return jsonResult({
        mode: 'applied',
        resource: label,
        applied: {},
        note: 'Sin cambios efectivos; no se ha escrito nada.',
      });
    }
    const body = {};
    for (const k of Object.keys(changes)) body[k] = changes[k].to;
    const result = await apiSend('PUT', `/api/clients/${id}`, body);
    return jsonResult({ mode: 'applied', resource: label, applied: body, result });
  })
);

server.tool(
  'update_operation',
  'Edita campos de una operación. Mismo patrón preview/confirm que update_client: sin `confirm` muestra el diff; con `confirm: true` aplica. Solo se envían los campos que cambian. Campos desconocidos abortan el confirm. ' +
    'Plazos FEIN (fechas ISO YYYY-MM-DD, null para vaciar): `fechaMaxArras` sale del contrato de arras ' +
    '(fecha límite para firmar la compraventa); `fechaMaxOfertaBancaria` sale de la oferta vinculante / FEIN ' +
    'del banco ELEGIDO (fecha hasta la que mantiene condiciones). Si las lees en un adjunto con read_document_file, ' +
    'propón rellenarlas con este tool citando el documento. `fechaMaxFein` NO se escribe: la calcula el CRM ' +
    '(min(oferta bancaria, arras − 11 días)). La fecha por banco va en update_operation_bank (`fechaMaxOferta`).',
  {
    id: z.number().int().positive().describe('ID de la operación.'),
    fields: z
      .record(z.any())
      .describe(
        'Objeto camelCase con los campos a actualizar. Permitidos: ' +
          [...OPERATION_FIELDS].join(', ') +
          '.'
      ),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  tool(async ({ id, fields, confirm }) => {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('`fields` debe ser un objeto con los campos a actualizar.');
    }
    if (Object.keys(fields).length === 0) {
      throw new Error('`fields` está vacío: no hay nada que actualizar.');
    }
    const current = await apiJson(`/api/operations/${id}`);
    const label = `operation #${id} — ${current.titulo ?? '(sin título)'}`;
    const { changes, unchanged, unknown } = diffFields(current, fields, OPERATION_FIELDS);

    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        changes,
        unchanged,
        unknown,
        instructions:
          unknown.length > 0
            ? `Campos desconocidos: ${unknown.join(', ')}. Quítalos o corrige el nombre antes de aplicar. ${PREVIEW_HINT}`
            : Object.keys(changes).length === 0
              ? 'No hay cambios efectivos respecto al estado actual. No se aplicará nada.'
              : PREVIEW_HINT,
      });
    }
    if (unknown.length > 0) {
      throw new Error(
        `Hay campos desconocidos: ${unknown.join(', ')}. No se aplica nada. Quítalos o usa los nombres correctos.`
      );
    }
    if (Object.keys(changes).length === 0) {
      return jsonResult({
        mode: 'applied',
        resource: label,
        applied: {},
        note: 'Sin cambios efectivos; no se ha escrito nada.',
      });
    }
    const body = {};
    for (const k of Object.keys(changes)) body[k] = changes[k].to;
    const result = await apiSend('PUT', `/api/operations/${id}`, body);
    return jsonResult({ mode: 'applied', resource: label, applied: body, result });
  })
);

server.tool(
  'create_operation_update',
  'Añade una entrada nueva al timeline (operation_updates) de una operación. Mismo patrón preview/confirm. `interno=true` la oculta del portal del cliente; `expuestoReferido=true` la hace visible al portal de referidos (por defecto: ambos false). `fecha` opcional (YYYY-MM-DD), default = hoy.',
  {
    operationId: z.number().int().positive(),
    texto: z.string().min(1, 'texto no puede estar vacío'),
    fecha: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha debe ser YYYY-MM-DD')
      .optional(),
    interno: z.boolean().optional(),
    expuestoReferido: z.boolean().optional(),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  tool(async ({ operationId, texto, fecha, interno, expuestoReferido, confirm }) => {
    const op = await apiJson(`/api/operations/${operationId}`);
    const label = `operation #${operationId} — ${op.titulo ?? '(sin título)'}`;
    const entry = {
      texto,
      fecha: fecha ?? new Date().toISOString().slice(0, 10),
      interno: !!interno,
      expuestoReferido: !!expuestoReferido,
    };
    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        wouldInsert: entry,
        instructions: PREVIEW_HINT,
      });
    }
    const result = await apiSend('POST', `/api/operations/${operationId}/updates`, {
      texto,
      fecha,
      interno: !!interno,
      expuestoReferido: !!expuestoReferido,
    });
    return jsonResult({ mode: 'applied', resource: label, inserted: result });
  })
);

server.tool(
  'edit_operation_update',
  'Edita o borra una entrada concreta del timeline. Mismo patrón preview/confirm. Campos editables: ' +
    [...TIMELINE_FIELDS].join(', ') +
    '. Si pasas `delete: true` la entrada se borrará en confirm (preview lo indica). Si pasas `fields` Y `delete: true` a la vez es error.',
  {
    operationId: z.number().int().positive(),
    updateId: z.number().int().positive(),
    fields: z.record(z.any()).optional(),
    delete: z.boolean().optional(),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  tool(async ({ operationId, updateId, fields, delete: doDelete, confirm }) => {
    const wantsEdit = !!(fields && Object.keys(fields).length > 0);
    if (doDelete && wantsEdit) {
      throw new Error('Pasa o `fields` o `delete: true`, no los dos.');
    }
    if (!doDelete && !wantsEdit) {
      throw new Error('Nada que hacer: pasa `fields` con al menos un campo o `delete: true`.');
    }
    // Find the target update by listing the operation's timeline. The Worker
    // doesn't expose GET /:id/updates/:updateId so this is the natural lookup.
    const list = await apiJson(`/api/operations/${operationId}/updates`);
    const target = Array.isArray(list)
      ? list.find((u) => Number(u.id) === Number(updateId))
      : null;
    if (!target) {
      throw new Error(
        `Entrada de timeline ${updateId} no encontrada en operación ${operationId}.`
      );
    }
    const label = `operation #${operationId} timeline entry #${updateId}`;

    if (doDelete) {
      if (!confirm) {
        return jsonResult({
          mode: 'preview',
          resource: label,
          wouldDelete: target,
          instructions: PREVIEW_HINT,
        });
      }
      await apiSend('DELETE', `/api/operations/${operationId}/updates/${updateId}`);
      return jsonResult({ mode: 'applied', resource: label, deleted: target });
    }

    const { changes, unchanged, unknown } = diffFields(target, fields, TIMELINE_FIELDS);
    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        changes,
        unchanged,
        unknown,
        instructions:
          unknown.length > 0
            ? `Campos desconocidos: ${unknown.join(', ')}. Quítalos antes de aplicar. ${PREVIEW_HINT}`
            : Object.keys(changes).length === 0
              ? 'No hay cambios efectivos. No se aplicará nada.'
              : PREVIEW_HINT,
      });
    }
    if (unknown.length > 0) {
      throw new Error(`Hay campos desconocidos: ${unknown.join(', ')}. No se aplica nada.`);
    }
    if (Object.keys(changes).length === 0) {
      return jsonResult({
        mode: 'applied',
        resource: label,
        applied: {},
        note: 'Sin cambios efectivos; no se ha escrito nada.',
      });
    }
    const body = {};
    for (const k of Object.keys(changes)) body[k] = changes[k].to;
    const result = await apiSend(
      'PUT',
      `/api/operations/${operationId}/updates/${updateId}`,
      body
    );
    return jsonResult({ mode: 'applied', resource: label, applied: body, result });
  })
);

// Contacto de banco: nombre obligatorio, el resto opcional. Campos desconocidos
// se descartan (zod strip) para no romper el JSON que guarda el Worker.
const contactSchema = z.object({
  nombre: z.string().min(1, 'el contacto necesita nombre'),
  cargo: z.string().optional(),
  email: z.string().optional(),
  telefono: z.string().optional(),
  notas: z.string().optional(),
});

server.tool(
  'create_bank',
  'Crea un banco nuevo en el catálogo. Patrón preview/confirm: sin `confirm` muestra lo que se insertaría y avisa si ya existe un banco con ese nombre (el Worker rechaza nombres duplicados con 409); con `confirm: true` lo crea. Campos: nombre (obligatorio), condicionesActuales, notas, contactos (array de {nombre*, cargo?, email?, telefono?, notas?}).',
  {
    nombre: z.string().min(1, 'nombre es obligatorio'),
    condicionesActuales: z.string().optional(),
    notas: z.string().optional(),
    contactos: z.array(contactSchema).optional(),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  tool(async ({ nombre, condicionesActuales, notas, contactos, confirm }) => {
    const existing = await apiJson('/api/banks');
    const clash = Array.isArray(existing)
      ? existing.find(
          (b) => (b.nombre || '').trim().toLowerCase() === nombre.trim().toLowerCase()
        )
      : null;
    const entry = { nombre: nombre.trim() };
    if (condicionesActuales !== undefined) entry.condicionesActuales = condicionesActuales;
    if (notas !== undefined) entry.notas = notas;
    if (contactos !== undefined) entry.contactos = contactos;

    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        wouldInsert: entry,
        nameClash: clash ? { id: clash.id, nombre: clash.nombre } : null,
        instructions: clash
          ? `Ya existe un banco "${clash.nombre}" (id ${clash.id}). Si el nombre es idéntico el Worker devolverá 409; quizá quieras update_bank id ${clash.id}. ${PREVIEW_HINT}`
          : PREVIEW_HINT,
      });
    }
    const result = await apiSend('POST', '/api/banks', entry);
    return jsonResult({ mode: 'applied', created: result });
  })
);

server.tool(
  'update_bank',
  'Edita un banco existente. Mismo patrón preview/confirm que update_client: sin `confirm` muestra el diff; con `confirm: true` aplica. Campos permitidos: ' +
    [...BANK_FIELDS].join(', ') +
    '. OJO: `contactos` REEMPLAZA la lista completa (no hace merge): para añadir uno, pasa todos los contactos. Campos desconocidos abortan el confirm.',
  {
    id: z.number().int().positive().describe('ID del banco.'),
    fields: z
      .record(z.any())
      .describe('Objeto camelCase. Permitidos: ' + [...BANK_FIELDS].join(', ') + '.'),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  tool(async ({ id, fields, confirm }) => {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('`fields` debe ser un objeto con los campos a actualizar.');
    }
    if (Object.keys(fields).length === 0) {
      throw new Error('`fields` está vacío: no hay nada que actualizar.');
    }
    const current = await apiJson(`/api/banks/${id}`);
    const label = `bank #${id} — ${current.nombre ?? '(sin nombre)'}`;
    const { changes, unchanged, unknown } = diffFields(current, fields, BANK_FIELDS);

    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        changes,
        unchanged,
        unknown,
        instructions:
          unknown.length > 0
            ? `Campos desconocidos: ${unknown.join(', ')}. Quítalos o corrige el nombre antes de aplicar. ${PREVIEW_HINT}`
            : Object.keys(changes).length === 0
              ? 'No hay cambios efectivos respecto al estado actual. No se aplicará nada.'
              : PREVIEW_HINT,
      });
    }
    if (unknown.length > 0) {
      throw new Error(
        `Hay campos desconocidos: ${unknown.join(', ')}. No se aplica nada. Quítalos o usa los nombres correctos.`
      );
    }
    if (Object.keys(changes).length === 0) {
      return jsonResult({
        mode: 'applied',
        resource: label,
        applied: {},
        note: 'Sin cambios efectivos; no se ha escrito nada.',
      });
    }
    const body = {};
    for (const k of Object.keys(changes)) body[k] = changes[k].to;
    const result = await apiSend('PUT', `/api/banks/${id}`, body);
    return jsonResult({ mode: 'applied', resource: label, applied: body, result });
  })
);

server.tool(
  'update_operation_bank',
  'Edita el registro de un banco vinculado a una operación (operation_banks): estado, contacto usado, fechas y la oferta recibida (tipoBonificado, pctFinanciacion, comisionApertura, bonificaciones, notas). Mismo patrón preview/confirm que update_client. OJO: `id` es el del VÍNCULO operación-banco (operation_banks.id, sale de list_operation_banks), NO el de la operación ni el del banco. No se pueden cambiar operationId ni bankId. ' +
    '`fechaMaxOferta` (ISO YYYY-MM-DD) = validez de la oferta de ESE banco. Regla del CRM: cuando el vínculo está ' +
    'en estado `aprobado` y tiene `fechaMaxOferta`, la operación hereda esa fecha como `fechaMaxOfertaBancaria` ' +
    'solo si allí estaba vacía (nunca pisa una ya escrita).',
  {
    id: z.number().int().positive().describe('ID del vínculo operación-banco (operation_banks.id).'),
    fields: z
      .record(z.any())
      .describe('Objeto camelCase. Permitidos: ' + [...OPERATION_BANK_FIELDS].join(', ') + '.'),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  tool(async ({ id, fields, confirm }) => {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('`fields` debe ser un objeto con los campos a actualizar.');
    }
    if (Object.keys(fields).length === 0) {
      throw new Error('`fields` está vacío: no hay nada que actualizar.');
    }
    const current = await apiJson(`/api/operation-banks/${id}`);
    const label = `operation-bank #${id} — ${current.bankNombre ?? 'banco'} (op ${current.operationId})`;
    const { changes, unchanged, unknown } = diffFields(current, fields, OPERATION_BANK_FIELDS);

    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        changes,
        unchanged,
        unknown,
        instructions:
          unknown.length > 0
            ? `Campos desconocidos: ${unknown.join(', ')}. Quítalos o corrige el nombre antes de aplicar. ${PREVIEW_HINT}`
            : Object.keys(changes).length === 0
              ? 'No hay cambios efectivos respecto al estado actual. No se aplicará nada.'
              : PREVIEW_HINT,
      });
    }
    if (unknown.length > 0) {
      throw new Error(
        `Hay campos desconocidos: ${unknown.join(', ')}. No se aplica nada. Quítalos o usa los nombres correctos.`
      );
    }
    if (Object.keys(changes).length === 0) {
      return jsonResult({
        mode: 'applied',
        resource: label,
        applied: {},
        note: 'Sin cambios efectivos; no se ha escrito nada.',
      });
    }
    const body = {};
    for (const k of Object.keys(changes)) body[k] = changes[k].to;
    const result = await apiSend('PUT', `/api/operation-banks/${id}`, body);
    return jsonResult({ mode: 'applied', resource: label, applied: body, result });
  })
);

// --- Vínculos operación-banco: alta y baja ----------------------------------
// El Worker ya exponía POST/DELETE /api/operation-banks (la SPA los usa desde la
// pestaña Bancos); aquí solo se envuelven con el patrón preview/confirm.
const OPERATION_BANK_CREATE_FIELDS = new Set(['operationId', 'bankId', ...OPERATION_BANK_FIELDS]);
const OPERATION_BANK_ESTADOS = [
  'no_enviado', 'enviado', 'en_estudio', 'contraoferta', 'aprobado', 'denegado', 'retirado',
];

server.tool(
  'create_operation_bank',
  'Vincula un banco del catálogo a una operación (crea la fila de operation_banks: a qué banco se ha enviado o se va a enviar el expediente, con qué contacto, en qué estado y con qué oferta). Patrón preview/confirm. Requeridos: operationId y bankId (id de list_banks). Opcionales: contactoUsado (nombre del gestor; idealmente uno de los `contactos` del banco), estado (' +
    OPERATION_BANK_ESTADOS.join(' | ') +
    '; por defecto no_enviado), fechaEnvio, fechaRespuesta, fechaMaxOferta (ISO YYYY-MM-DD), tipoBonificado, pctFinanciacion, comisionApertura, bonificaciones, notas. El preview comprueba que existan la operación y el banco, avisa si el contacto no está en la ficha del banco y si ese banco YA está vinculado a la operación (el Worker lo rechaza con 409: entonces usa update_operation_bank sobre el vínculo existente). Si se crea en estado aprobado con fechaMaxOferta, la operación hereda fechaMaxOfertaBancaria si la tenía vacía.',
  {
    fields: z
      .record(z.any())
      .describe(
        'Objeto camelCase. Requeridos operationId y bankId. Permitidos: ' +
          [...OPERATION_BANK_CREATE_FIELDS].join(', ') + '.'
      ),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  tool(async ({ fields, confirm }) => {
    const { entry, unknown, missing } = buildCreateEntry(
      fields, OPERATION_BANK_CREATE_FIELDS, ['operationId', 'bankId']
    );
    const problems = [];
    if (unknown.length) problems.push(`Campos desconocidos: ${unknown.join(', ')}.`);
    if (missing.length) problems.push(`Faltan campos requeridos: ${missing.join(', ')}.`);
    if (entry.estado !== undefined && !OPERATION_BANK_ESTADOS.includes(entry.estado)) {
      problems.push(`estado "${entry.estado}" no válido; usa uno de: ${OPERATION_BANK_ESTADOS.join(', ')}.`);
    }
    const { op, label: opLabel, error: opError } = await resolveOperation(entry.operationId);
    if (entry.operationId != null && !op) {
      problems.push(`Operación ${entry.operationId} no encontrada${opError ? ` (${opError})` : ''}.`);
    }
    let bank = null;
    if (!missing.includes('bankId')) {
      try {
        bank = await apiJson(`/api/banks/${entry.bankId}`);
      } catch (e) {
        problems.push(`Banco ${entry.bankId} no encontrado (${e.message}).`);
      }
    }
    let alreadyLinked = null;
    if (op && bank) {
      const links = await apiJson('/api/operation-banks', { operationId: entry.operationId });
      alreadyLinked = links.find((l) => Number(l.bankId) === Number(entry.bankId)) || null;
      if (alreadyLinked) {
        problems.push(
          `El banco "${bank.nombre}" ya está vinculado a esta operación (vínculo #${alreadyLinked.id}, estado ${alreadyLinked.estado}). Usa update_operation_bank en vez de crear otro.`
        );
      }
    }
    let contactoHint = null;
    if (bank && entry.contactoUsado) {
      const names = (bank.contactos || []).map((ct) => ct && ct.nombre).filter(Boolean);
      const wanted = String(entry.contactoUsado).trim().toLowerCase();
      if (names.length && !names.some((n) => n.trim().toLowerCase() === wanted)) {
        contactoHint =
          `contactoUsado "${entry.contactoUsado}" no coincide con ningún contacto de la ficha del banco ` +
          `(${names.join(' | ')}). Se guarda tal cual; revísalo.`;
      }
    }
    const label = `${opLabel} ↔ ${bank ? bank.nombre : `bank #${entry.bankId}`}`;
    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        operationExists: !!op,
        bankExists: !!bank,
        alreadyLinked,
        wouldInsert: entry,
        unknown,
        missing,
        contactoHint,
        instructions: problems.length
          ? `${problems.join(' ')} Corrige antes de aplicar. ${PREVIEW_HINT}`
          : PREVIEW_HINT,
      });
    }
    if (problems.length) throw new Error(`${problems.join(' ')} No se crea nada.`);
    const result = await apiSend('POST', '/api/operation-banks', entry);
    return jsonResult({ mode: 'applied', resource: label, created: result, contactoHint });
  })
);

server.tool(
  'delete_operation_bank',
  'Elimina el vínculo entre un banco y una operación (borra la fila de operation_banks: estado, contacto, fechas y oferta de ESE banco en ESA operación). No toca el banco del catálogo ni la operación. Patrón preview/confirm: sin `confirm` muestra qué vínculo se borraría; con `confirm: true` lo borra (IRREVERSIBLE). `id` = operation_banks.id (de list_operation_banks), NO el id del banco ni el de la operación. Si el vínculo ya tiene oferta o respuesta del banco, el preview avisa: normalmente es mejor pasarlo a `retirado` con update_operation_bank para conservar el historial (bank_history). Ojo: si la operación heredó `fechaMaxOfertaBancaria` de este vínculo, esa fecha NO se deshace; revísala con get_operation / update_operation.',
  {
    id: z.number().int().positive().describe('ID del vínculo operación-banco (operation_banks.id).'),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  tool(async ({ id, confirm }) => {
    const current = await apiJson(`/api/operation-banks/${id}`);
    const label = `operation-bank #${id} — ${current.bankNombre ?? 'banco'} (op ${current.operationId})`;
    const summary = {
      id: current.id,
      operationId: current.operationId,
      bankId: current.bankId,
      bankNombre: current.bankNombre,
      contactoUsado: current.contactoUsado,
      estado: current.estado,
      fechaEnvio: current.fechaEnvio,
      fechaRespuesta: current.fechaRespuesta,
      fechaMaxOferta: current.fechaMaxOferta,
      tipoBonificado: current.tipoBonificado,
      pctFinanciacion: current.pctFinanciacion,
      comisionApertura: current.comisionApertura,
    };
    const tieneHistorial =
      current.tipoBonificado != null ||
      current.pctFinanciacion != null ||
      current.comisionApertura != null ||
      !!current.fechaRespuesta ||
      ['en_estudio', 'contraoferta', 'aprobado', 'denegado'].includes(current.estado);
    const warning = tieneHistorial
      ? 'Este vínculo tiene oferta/respuesta del banco: borrarlo pierde ese historial (bank_history). Si solo quieres cerrarlo, cambia `estado` a retirado con update_operation_bank.'
      : null;
    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        wouldDelete: summary,
        warning,
        instructions: `Borrado IRREVERSIBLE. ${PREVIEW_HINT}`,
      });
    }
    await apiSend('DELETE', `/api/operation-banks/${id}`);
    return jsonResult({ mode: 'applied', resource: label, deleted: summary });
  })
);

// --- Documentos: renombrado ---------------------------------------------------
// Solo cambia `fileName` (nombre visible en Documentos y en el portal); el objeto
// de R2 no se mueve. Misma regla que la SPA: la extensión original se conserva.
const splitExt = (name) => {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? { base: m[1], ext: m[2] } : { base: name || '', ext: '' };
};

server.tool(
  'rename_document',
  'Renombra un documento adjunto de una operación: solo cambia `fileName`, el nombre visible en la pestaña Documentos y en el portal del cliente (el archivo en R2 no se mueve; el id no cambia). Patrón preview/confirm. La EXTENSIÓN original se conserva siempre: si el nuevo nombre no la lleva (o lleva otra) se le pone la original. Se limpian separadores de ruta y caracteres no válidos. Úsalo para dar nombres claros y homogéneos, p. ej. "Nómina 2026-09 — Jesús Alfonso.pdf", "DNI — Jesús Alfonso.pdf", "IRPF 2025 — Jesús Alfonso.pdf", "Extractos CaixaBank abr–oct 2026.pdf". Antes de proponer nombres, mira el contenido con read_document_file si el nombre actual no lo deja claro. Para varios documentos, llama una vez por documento (primero todos los previews, luego los confirms).',
  {
    id: z.number().int().positive().describe('ID del documento (de list_documents).'),
    fileName: z
      .string()
      .min(1, 'fileName es obligatorio')
      .describe('Nuevo nombre visible. La extensión original se conserva aunque no la pongas.'),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  tool(async ({ id, fileName, confirm }) => {
    const doc = await apiJson(`/api/documents/${id}`);
    const current = doc.fileName || '';
    const { ext } = splitExt(current);
    let cleaned = String(fileName)
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) throw new Error('El nuevo nombre queda vacío tras limpiar caracteres no válidos.');
    const proposed = splitExt(cleaned);
    let extNote = null;
    if (ext && proposed.ext.toLowerCase() !== ext.toLowerCase()) {
      extNote = proposed.ext
        ? `La extensión "${proposed.ext}" se ha sustituido por la original "${ext}".`
        : `Se ha añadido la extensión original "${ext}".`;
      cleaned = (proposed.ext ? proposed.base : cleaned).trim() + ext;
    } else if (ext) {
      cleaned = proposed.base.trim() + ext;
    }
    const label = `document #${id} (op ${doc.operationId})`;
    if (cleaned === current) {
      return jsonResult({
        mode: confirm ? 'applied' : 'preview',
        resource: label,
        from: current,
        to: cleaned,
        note: 'El nombre ya es ese; no hay nada que cambiar.',
      });
    }
    if (!confirm) {
      return jsonResult({ mode: 'preview', resource: label, from: current, to: cleaned, extNote, instructions: PREVIEW_HINT });
    }
    const result = await apiSend('PUT', `/api/documents/${id}`, { fileName: cleaned });
    return jsonResult({ mode: 'applied', resource: label, from: current, to: result.fileName, extNote });
  })
);

server.tool(
  'create_client',
  'Crea un titular/cliente nuevo en una operación. Patrón preview/confirm: sin `confirm` muestra lo que se insertaría (y avisa de campos desconocidos, requeridos que falten o si la operación no existe); con `confirm: true` lo crea. Requeridos: operationId, nombre. Resto opcional: ' +
    [...CLIENT_FIELDS].filter((f) => f !== 'operationId' && f !== 'nombre').join(', ') +
    '. Marca isTitularPrincipal:true para el titular principal e isAvalista:true si es avalista.',
  {
    fields: z
      .record(z.any())
      .describe(
        'Objeto camelCase con los datos del titular. Requeridos operationId y nombre. Permitidos: ' +
          [...CLIENT_FIELDS].join(', ') + '.'
      ),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  makeCreateTool({ allowed: CLIENT_FIELDS, required: ['operationId', 'nombre'], path: '/api/clients' })
);

server.tool(
  'create_loan',
  'Crea un préstamo existente de los titulares en una operación. Patrón preview/confirm. Requeridos: operationId, cuota. Opcionales: importePendiente, anosRestantes, descripcion y clientIds (array de IDs de titular a los que se asigna el préstamo, relación N:N).',
  {
    fields: z
      .record(z.any())
      .describe(
        'Objeto camelCase. Requeridos operationId y cuota. Permitidos: ' +
          [...LOAN_FIELDS].join(', ') + '.'
      ),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  makeCreateTool({ allowed: LOAN_FIELDS, required: ['operationId', 'cuota'], path: '/api/loans' })
);

server.tool(
  'create_simulation',
  'Crea una simulación de financiación en una operación. El Worker recalcula y guarda el snapshot automáticamente (no se pasa snapshotJson). Patrón preview/confirm. Requerido: operationId. Para que los ratios salgan, conviene pasar valorInmueble, financiacionPct, interesAnual, plazoAnos e ingresos/pagas de los titulares. Resto opcional: ' +
    [...SIMULATION_FIELDS].filter((f) => f !== 'operationId').join(', ') + '.',
  {
    fields: z
      .record(z.any())
      .describe(
        'Objeto camelCase. Requerido operationId. Permitidos: ' +
          [...SIMULATION_FIELDS].join(', ') + '.'
      ),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  makeCreateTool({ allowed: SIMULATION_FIELDS, required: ['operationId'], path: '/api/simulations' })
);

server.tool(
  'create_inmueble',
  'Crea un inmueble en propiedad de los titulares (descripción libre) en una operación. Patrón preview/confirm. Requeridos: operationId, descripcion.',
  {
    operationId: z.number().int().positive().describe('ID de la operación.'),
    descripcion: z.string().min(1, 'descripcion es obligatoria'),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  makeDescripcionCreateTool('/api/inmuebles')
);

server.tool(
  'create_document_request',
  'Crea una solicitud de documentación en el checklist de una operación (lo que el cliente ve como documento pendiente de subir en el portal). Patrón preview/confirm. Requeridos: operationId, descripcion. Nace pendiente (fulfilled=false) y pasa a cumplida cuando se enlaza al menos un documento subido.',
  {
    operationId: z.number().int().positive().describe('ID de la operación.'),
    descripcion: z.string().min(1, 'descripcion es obligatoria').describe('Qué documento se pide (p. ej. "Certificado de empadronamiento histórico — Dayana").'),
    confirm: z.boolean().optional(),
  },
  { destructiveHint: false, idempotentHint: false, openWorldHint: false },
  makeDescripcionCreateTool('/api/document-requests')
);

// --- Plantillas de documentos (Ajustes → Plantillas) ------------------------
// Una plantilla HTML por tipo de documento y empresa (contrato, protección de
// datos…). El registro de tipos vive en el código del Worker
// (shared/docTemplates.ts); estas keys son su espejo.
const DOC_TEMPLATE_KEYS = ['contrato', 'proteccion_datos'];

server.tool(
  'list_doc_templates',
  'Lista las plantillas de documentos configuradas de la empresa activa (una por tipo: contrato, protección de datos…). Devuelve { key, body (HTML completo), updatedAt }. Úsalo para LEER el HTML actual antes de editarlo con upsert_doc_template, o para reutilizar una sección (p. ej. extraer la cláusula de protección de datos del contrato).',
  {},
  tool(async () => jsonResult(await apiJson('/api/doc-templates')))
);

server.tool(
  'upsert_doc_template',
  'Crea o reemplaza la plantilla HTML de un tipo de documento de la empresa activa (equivale a Ajustes → Plantillas de documentos). Patrón en DOS pasos: SIN `confirm` devuelve una PREVIEW (si ya existe: longitud actual vs propuesta + un extracto del cuerpo propuesto), sin escribir nada; con `confirm: true` aplica (PUT). El cuerpo es HTML completo y puede usar %placeholders% (p. ej. %InfoTitulares%, %Direccion%, %Honorarios%, %Fecha%). El Worker valida que estén los placeholders OBLIGATORIOS del tipo y rechaza un cuerpo vacío; reemplaza por completo el cuerpo anterior. Solo admin.',
  {
    key: z
      .enum(DOC_TEMPLATE_KEYS)
      .describe('Tipo de documento. Debe existir en el registro del código (shared/docTemplates.ts).'),
    body: z.string().describe('Cuerpo HTML completo de la plantilla (reemplaza al anterior).'),
    confirm: z
      .boolean()
      .optional()
      .describe('Sin este flag (o `false`) la llamada es PREVIEW y no escribe. Pásalo `true` para aplicar.'),
  },
  { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  tool(async ({ key, body, confirm }) => {
    const proposed = String(body ?? '').trim();
    if (!proposed) throw new Error('`body` está vacío: la plantilla no puede quedar vacía.');
    const existing = (await apiJson('/api/doc-templates')).find((t) => t.key === key) || null;
    const label = `doc_template "${key}"`;
    const excerpt = (s) =>
      s.length > 600 ? `${s.slice(0, 600)}… (+${s.length - 600} caracteres)` : s;

    if (!confirm) {
      return jsonResult({
        mode: 'preview',
        resource: label,
        exists: !!existing,
        currentLength: existing ? existing.body.length : 0,
        proposedLength: proposed.length,
        proposedExcerpt: excerpt(proposed),
        instructions: existing
          ? `Esto REEMPLAZA por completo la plantilla actual de "${key}". ${PREVIEW_HINT}`
          : PREVIEW_HINT,
      });
    }
    const result = await apiSend('PUT', `/api/doc-templates/${encodeURIComponent(key)}`, {
      body: proposed,
    });
    return jsonResult({
      mode: 'applied',
      resource: label,
      appliedLength: proposed.length,
      result: { key: result?.key, updatedAt: result?.updatedAt },
    });
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
