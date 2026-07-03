# TudesanCRM-Cloud — MCP local

Servidor MCP que deja a Claude **leer y editar** TudesanCRM en la nube
(operaciones, clientes, documentos, histórico, bancos, simulaciones, préstamos,
inmuebles) llamando a la API REST del Worker. Corre **en local**; lo lanza
Claude Code/Desktop como subproceso o el agente correspondiente.

La mayoría de tools son de solo lectura. Las 12 tools de escritura
(`create_client`, `update_client`, `update_operation`, `create_operation_update`,
`edit_operation_update`, `create_bank`, `update_bank`, `update_operation_bank`,
`create_loan`, `create_inmueble`, `create_simulation`, `upsert_doc_template`) usan un patrón
**preview / confirm** en dos pasos: sin `confirm: true` la llamada muestra el
diff (o lo que se insertaría) y NO escribe; solo `confirm: true` aplica el
cambio. Esto se suma al *permission prompt* que Claude Code muestra antes de
cada llamada de tool.

> Pensado para uso personal en el propio equipo del usuario (Claude Code / Claude Desktop).
> **No** sirve para Claude.ai ni Cowork (corren en la nube y no pueden lanzar un
> proceso local ni usar tu sesión de `cloudflared`); para eso haría falta una
> variante remota del MCP dentro del Worker, no incluida aquí.

---

## Cómo se autentica (sin secretos en el repo)

El Worker está detrás de **Cloudflare Access**. Este servidor obtiene un JWT de
Access efímero ejecutando `cloudflared access token`, que reutiliza la sesión
SSO de Google que estableces **una vez por máquina** con `cloudflared access
login`. Cloudflare valida el JWT, inyecta tu email y el Worker te resuelve como
**admin** → ves todo.

Consecuencia: **no hay ninguna credencial en este código ni en el repo**. Para
usarlo en un ordenador nuevo solo necesitas que tu email esté en la allowlist de
Access (ya lo está: `fernitudela@gmail.com`) y hacer el login una vez.

---

## Puesta en marcha en un ordenador nuevo (de cero)

### 1. Requisitos

- **Node.js 18+** (`node --version`).
- **`cloudflared`** instalado.
  - Windows: descarga `cloudflared.exe` de
    <https://github.com/cloudflare/cloudflared/releases> (o `winget install
    Cloudflare.cloudflared`). Apúntate dónde queda; si no está en el `PATH`
    necesitarás pasar `CLOUDFLARED_PATH` (paso 4).
  - macOS: `brew install cloudflared`.
  - Linux: paquete `.deb`/`.rpm` de las releases o el gestor de tu distro.
- Tu email en la allowlist de Cloudflare Access del Worker.

### 2. Clonar el repo e instalar dependencias

```bash
git clone https://github.com/fernitudela/TudesanCRM-MCP.git
cd TudesanCRM-MCP
npm install        # usa el package-lock.json versionado (reproducible)
```

`node_modules/` **no** está en git (lo ignora `.gitignore`): siempre hay que
hacer `npm install` en cada máquina.

### 3. Login de Cloudflare Access (una vez por máquina, caduca ~24 h)

```bash
cloudflared access login https://tudesancrm-cloud.fernitudela.workers.dev
```

Se abre el navegador para el SSO de Google. Cuando la sesión caduque (~24 h) y
una tool falle con un mensaje de Access, repite **solo** este comando.

> En la terminal de Claude Code puedes lanzarlo con el prefijo `!`:
> `! cloudflared access login https://tudesancrm-cloud.fernitudela.workers.dev`

### 4. Averigua la ruta absoluta de `server.mjs` (y de `cloudflared`)

El registro del MCP necesita rutas **absolutas**. Para obtenerlas:

```bash
# ruta de server.mjs (estando dentro de la carpeta del repo)
#   Windows PowerShell:
(Resolve-Path .\server.mjs).Path
#   macOS/Linux:
echo "$(pwd)/server.mjs"

# ruta de cloudflared (si no está en el PATH del proceso de Claude)
#   Windows PowerShell:
(Get-Command cloudflared).Source
#   macOS/Linux:
which cloudflared
```

### 5. Registrar el MCP en Claude

**Claude Code** (scope `user` = disponible en todos tus proyectos):

```bash
claude mcp add tudesancrm-cloud -s user \
  -e CLOUDFLARED_PATH=<ruta-a-cloudflared> \
  -- node <ruta-absoluta-a>/server.mjs
```

Ejemplo en Windows:

```bash
claude mcp add tudesancrm-cloud -s user ^
  -e CLOUDFLARED_PATH=C:\Users\TU_USUARIO\.local\bin\cloudflared.exe ^
  -- node C:\Users\TU_USUARIO\repos\tudesancrm-mcp\server.mjs
```

> ⚠️ **Gotcha**: si `cloudflared` no está en el `PATH` que hereda el proceso de
> Claude, **debes** pasar `CLOUDFLARED_PATH`; si no, el MCP da `ENOENT` y
> reporta "no hay sesión" aunque sí estés logueado.

**Claude Desktop / `.mcp.json`** (equivalente):

```json
{
  "mcpServers": {
    "tudesancrm-cloud": {
      "command": "node",
      "args": ["<ruta-absoluta-a>/server.mjs"],
      "env": {
        "CLOUDFLARED_PATH": "<ruta-a-cloudflared>"
      }
    }
  }
}
```

### 6. Verificar

Reinicia Claude Code/Desktop y usa la tool **`whoami`**: debe responder
`role: admin` y tu email con `source: access`. Si responde con un mensaje de
Access, repite el paso 3.

---

## (Opcional) Skill "Expediente Hipotecario"

El repo incluye, en [`skills/expediente-hipotecario/`](skills/), una **skill**
de Claude Code que genera expedientes hipotecarios para el banco usando los
adjuntos del cliente (leídos vía este MCP) como única fuente de la verdad. Es
independiente del MCP pero lo necesita: el MCP aporta los datos, la skill los
redacta.

Para tener **la misma experiencia** (la skill se auto-activa sola al pedir un
expediente), instálala en tu Claude personal. Lo más fácil: abre Claude Code en
este repo y pídeselo —

> «Instala la skill de expediente hipotecario de este repo.»

o ejecuta el script:

```powershell
pwsh ./skills/install-skill.ps1   # Windows
```
```bash
bash ./skills/install-skill.sh    # macOS / Linux
```

Detalles y copia manual en [`skills/README.md`](skills/README.md).

---

## Variables de entorno (todas opcionales)

| Var | Default | Para qué |
|---|---|---|
| `TUDESAN_BASE_URL` | `https://tudesancrm-cloud.fernitudela.workers.dev` | Origen de la API del Worker |
| `TUDESAN_APP_URL` | = `TUDESAN_BASE_URL` | App de Access para `cloudflared` |
| `CLOUDFLARED_PATH` | `cloudflared` (busca en PATH) | Ruta absoluta al binario `cloudflared` |
| `TUDESAN_MAX_FILE_MB` | `25` | Tamaño máx. de adjunto que se carga en contexto |

---

## Tools (29)

### Lectura (17)

| Tool | Qué devuelve |
|---|---|
| `whoami` | Identidad y rol con que accede el MCP (debe ser admin). |
| `health` | Comprueba que el Worker está vivo (no requiere sesión). |
| `list_operations` | Operaciones; filtros `estado` y/o `q` (texto libre). |
| `get_operation` | Una operación completa por id (incluye importes/honorarios). |
| `get_operation_timeline` | Histórico/cronología de una operación. |
| `list_clients` | Titulares (todos, o de una `operationId`). |
| `get_client` | Un titular completo por id. |
| `list_documents` | Metadatos de adjuntos; filtros por operación/cliente/tipo/tag. |
| `get_document` | Metadatos de un documento por id. |
| `read_document_file` | Contenido de un adjunto (PDF e imágenes; Word/Excel → aviso). |
| `list_document_requests` | Solicitudes de documentación al cliente; `fulfilled`=false → pendiente. Filtro `operationId`. |
| `list_operation_banks` | Bancos por operación (estado, ofertas, fechas). |
| `list_simulations` | Simulaciones de financiación (inputs + snapshot). |
| `list_loans` | Préstamos de los titulares (con `clientIds`). |
| `list_inmuebles` | Inmuebles en propiedad de los titulares. |
| `list_banks` | Catálogo de bancos (contactos y condiciones). |
| `list_doc_templates` | Plantillas HTML de documentos configuradas (una por tipo: `contrato`, `proteccion_datos`…), con su `body` y `updatedAt`. |

### Escritura (12, patrón preview / confirm)

Cada una se llama **dos veces**: la primera sin `confirm` para ver qué pasaría
(NO escribe), la segunda con `confirm: true` para aplicar.

| Tool | Qué hace |
|---|---|
| `create_client` | Crea un titular/cliente en una operación. Requeridos `operationId` y `nombre`. El preview avisa de campos desconocidos, requeridos que falten o si la operación no existe. |
| `update_client` | Edita campos de un cliente/titular. Solo se envían al Worker los campos que realmente cambian; campos desconocidos abortan el confirm. |
| `update_operation` | Edita campos de una operación. Mismo patrón que `update_client`. |
| `create_operation_update` | Añade entrada al timeline de una operación (`texto` + `fecha` opcional + flags `interno` y `expuestoReferido`). |
| `edit_operation_update` | Edita o borra (`delete: true`) una entrada existente del timeline. |
| `create_bank` | Crea un banco (`nombre` obligatorio + `condicionesActuales`, `notas`, `contactos`). El preview avisa si el nombre ya existe (el Worker rechaza duplicados con 409). |
| `update_bank` | Edita un banco. `contactos` REEMPLAZA la lista completa (no hace merge). |
| `update_operation_bank` | Edita un vínculo operación-banco (estado, contacto usado, fechas y oferta: `tipoBonificado`, `pctFinanciacion`, `comisionApertura`, `bonificaciones`, `notas`). `id` = `operation_banks.id` (de `list_operation_banks`). No cambia operationId/bankId. |
| `create_loan` | Crea un préstamo existente de los titulares. Requeridos `operationId` y `cuota`; opcionales `importePendiente`, `anosRestantes`, `descripcion` y `clientIds` (array de IDs de titular a los que se asigna). |
| `create_inmueble` | Crea un inmueble en propiedad de los titulares (`descripcion` libre). Requeridos `operationId` y `descripcion`. |
| `create_simulation` | Crea una simulación de financiación; el Worker recalcula y guarda el `snapshot` automáticamente. Requerido `operationId`. |
| `upsert_doc_template` | Crea o reemplaza la plantilla HTML de un tipo de documento (`contrato`, `proteccion_datos`…). El preview muestra longitud actual vs propuesta y un extracto; reemplaza el cuerpo entero. El Worker valida los `%placeholders%` obligatorios. Solo admin. |

**Campos editables** (mirror exacto de los `UPDATABLE*` del Worker — sync
manual; si el Worker añade un campo nuevo, hay que añadirlo también en
`server.mjs`):

- `update_client` → `operationId`, `isTitularPrincipal`, `isAvalista`,
  `nombre`, `dni`, `fechaNacimiento`, `estadoCivil`, `telefono`, `email`,
  `direccionActual`, `regimenViviendaActual`, `profesion`, `empresa`,
  `tipoContrato`, `fechaAltaEmpresa`, `salarioNeto`,
  `numPagas`, `otrosIngresos`, `otrosIngresosDescripcion`, `deudasMensuales`,
  `otrosPrestamosDetalle`, `notas`.
- `update_operation` → `tipo`, `estado`, `titulo`, `valorCompraventa`,
  `direccionInmueble`, `arras`, `financiacionPctSolicitada`,
  `ahorrosDisponibles`, `numHijosACargo`, `fechaInicio`, `fechaCierre`,
  `folderPath`, `honorariosInmobiliaria`, `honorariosInmobiliariaPct`,
  `honorariosTudesanAcordadoA`, `honorariosTudesanAcordadoB`, `referidoDe`,
  `referidoId`, `importeReferidoA`, `importeReferidoB`,
  `simUsarHonorariosAcordados`, `simIncluirImporteReferido`, `expedienteHtml`,
  `notas`.
- `create_operation_update` / `edit_operation_update` → `texto`, `fecha`
  (YYYY-MM-DD), `interno`, `expuestoReferido`.
- `create_bank` / `update_bank` → `nombre`, `condicionesActuales`, `notas`,
  `contactos` (array de `{nombre*, cargo?, email?, telefono?, notas?}`).
- `update_operation_bank` → `contactoUsado`, `estado`, `fechaEnvio`,
  `fechaRespuesta`, `tipoBonificado`, `pctFinanciacion`, `comisionApertura`,
  `bonificaciones`, `notas`.
- `create_client` → mismos campos que `update_client` (requeridos `operationId`
  y `nombre`).
- `create_loan` → `operationId`*, `cuota`*, `importePendiente`, `anosRestantes`,
  `descripcion`, `clientIds` (array de IDs de titular).
- `create_inmueble` → `operationId`*, `descripcion`*.
- `create_simulation` → `operationId`*, `nombre`, `valorInmueble`,
  `financiacionPct`, `interesAnual`, `plazoAnos`, `ingresosTitular1Neto`,
  `pagasTitular1`, `ingresosTitular2Neto`, `pagasTitular2`, `deudasMensuales`,
  `otrosIngresos`, `incluirOtrosIngresos`, `honorariosInmobiliaria`,
  `honorariosInmobiliariaPct`, `itpPct`, `comisionAperturaPct`,
  `expuestoCliente`. El `snapshot` lo calcula el Worker (no se pasa). (* = requerido)

**No expuesto a propósito**: crear/borrar operaciones, y cualquier DELETE
(clientes/titulares, préstamos, inmuebles, simulaciones, documentos, bancos).
Los bloqueos los hace el MCP (no la API): la API admite estas operaciones para la
web del CRM.

#### Ejemplo de uso

```text
# Paso 1 — preview (no escribe)
update_client({ id: 97, fields: { nombre: "Marta Peñalver Mas", fechaNacimiento: "1999-03-12" } })
# → { mode: "preview", changes: { nombre: { from: "Prometida …", to: "Marta …" }, … } }

# Paso 2 — confirmar
update_client({ id: 97, fields: { nombre: "Marta Peñalver Mas", fechaNacimiento: "1999-03-12" }, confirm: true })
# → { mode: "applied", applied: { … }, result: { …cliente actualizado… } }
```

---

## Resolución de problemas

| Síntoma | Causa / arreglo |
|---|---|
| Una tool da error de Access o "redirección a login" | Sesión SSO caducada (~24 h). Repite el paso 3. |
| `ENOENT` / "cloudflared falló" pero sí hiciste login | `cloudflared` no está en el PATH del proceso de Claude. Pasa `CLOUDFLARED_PATH` con la ruta absoluta (paso 5). |
| `whoami` no responde admin | Tu email no está en la allowlist de Access, o estás logueado con otra cuenta Google. |
| Cambios en `server.mjs` no se ven | Reinicia Claude Code/Desktop (el MCP se lanza al arrancar). |
| Adjunto Word/Excel no se lee | Por diseño: `read_document_file` solo interpreta PDF e imágenes. Conviértelo a PDF o usa `get_document` para los metadatos. |

---

## Notas

- **Escritura siempre con confirmación**: las 11 tools de escritura exigen dos
  llamadas (preview → confirm). Además Claude Code pide su propio permission
  prompt antes de cada llamada. No hay forma de escribir sin que tú lo veas.
- Es un wrapper fino sobre la API REST del Worker; **nunca** toca D1/R2
  directamente. La RBAC, validaciones y limpieza viven en el Worker.
- `read_document_file` solo interpreta PDF e imágenes (decisión inicial). Leer
  Word/Excel requeriría extracción de texto en el servidor (mejora futura).
