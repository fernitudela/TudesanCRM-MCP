# Kit de conexión de Claude con TudesanCRM (MCP) — instrucciones para el agente

Este directorio es un **kit autocontenido** para conectar Claude (Claude Code o
Claude Desktop) con el CRM hipotecario TudesanCRM mediante un servidor MCP que
corre en el ordenador del usuario. Si el usuario te pide algo como «conecta
Claude con el CRM», «instala el MCP del CRM», «usa este kit» o «conéctate a
TudesanCRM con mi cuenta», sigue este documento **al pie de la letra**. No
improvises otro método (no clones repos, no hagas `npm install`, no edites
`~/.claude.json` a mano, no busques guías en Internet): todo lo necesario está
aquí.

## Qué hay en el kit

| Archivo | Para qué |
|---|---|
| `server.mjs` | El servidor MCP, un único archivo ya empaquetado (sin dependencias). |
| `kit.json` | Configuración: URL del CRM, nombre del MCP (`tudesancrm-cloud`), versión. |
| `setup.ps1` | Instalador para **Windows**. Hace TODO el proceso. |
| `setup.sh` | Instalador para **macOS / Linux**. Hace TODO el proceso. |
| `instalar.cmd` | Doble clic en Windows = `setup.ps1` (para humanos sin Claude). |
| `skills/` | Skills opcionales (expediente hipotecario, CEE, tasación, asesor hipotecario) que usan el MCP. |
| `LEEME.md` | Guía corta para el usuario humano. |

## Cómo funciona la autenticación (para que puedas explicarlo)

El CRM está detrás de **Cloudflare Access** con login de Google. El MCP no
guarda contraseñas ni tokens en ningún archivo del kit: obtiene un JWT efímero
con `cloudflared access token`, que reutiliza la sesión de Google que el usuario
abre **una vez por equipo** con `cloudflared access login` (se abre el navegador).
El CRM identifica al usuario por su **email de Google** y le aplica su rol y su
empresa, exactamente igual que en la web. La sesión caduca al cabo de un tiempo
(típicamente 24 h) y entonces solo hay que repetir el login.

Consecuencia: **tú no puedes elegir la cuenta**. La elige el usuario en el
navegador. Si te dice «con mi cuenta/usuario», significa: que inicie sesión con
la cuenta de Google que el administrador del CRM dio de alta. Comprueba después
que el email que devuelve la verificación es el que esperaba.

## Procedimiento (ejecútalo tú; no se lo mandes al usuario salvo que falle)

### Paso 0 — Sitúate

1. Identifica el sistema operativo y la **ruta absoluta de esta carpeta** (la
   que contiene este `CLAUDE.md`). Llámala `<KIT>`.
2. Comprueba que existen `<KIT>/server.mjs`, `<KIT>/kit.json` y el instalador
   de su sistema. Si falta alguno, el zip está incompleto: pide al usuario que
   lo descomprima entero y vuelva a empezar. No intentes reconstruir nada.
3. Si el usuario ya ha indicado un **ID de empresa** (solo tiene sentido si
   pertenece a varias empresas del CRM), anótalo para pasarlo como `-OrgId` /
   `--org-id`. Si no lo ha dicho, **no preguntes**: la verificación final
   dirá si hace falta.

### Paso 1 — Ejecuta el instalador (un solo comando)

El instalador es idempotente y no hace preguntas por consola; se puede repetir
sin romper nada. Lo único interactivo es el login de Google, que **abre el
navegador** y espera. Por eso: usa un **timeout largo (10 minutos)** y avisa
antes al usuario con una frase: «Se te va a abrir el navegador para iniciar
sesión con tu cuenta de Google del CRM; hazlo y vuelve aquí».

Windows (usa `pwsh` si existe; si no, `powershell`):

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "<KIT>\setup.ps1"
```

macOS / Linux:

```bash
bash "<KIT>/setup.sh"
```

Opciones que puedes añadir **solo si procede**: `-OrgId 3` / `--org-id 3`
(empresa por defecto), `-Target Code|Desktop|Both` / `--target code|desktop|both`
(si el usuario quiere registrarlo en un cliente concreto; por defecto detecta
Claude Code y Claude Desktop automáticamente), `-SkipSkills` / `--skip-skills`
(si el usuario no quiere las skills).

Si la herramienta de ejecución te deniega el comando (por ejemplo por la
política de permisos de tu sesión), **no busques rodeos**: pide al usuario que
lo ejecute él. En Claude Code basta con que escriba en el prompt, con el
prefijo `!`:

```
! pwsh -NoProfile -ExecutionPolicy Bypass -File "<KIT>\setup.ps1"
```

o que haga doble clic en `instalar.cmd` (Windows). Luego pídele que te pegue la
última línea de la salida (`RESULTADO: …`).

### Paso 2 — Interpreta la ÚLTIMA línea de la salida: `RESULTADO: <CÓDIGO>`

| Código | Significado | Qué haces |
|---|---|---|
| `OK` | Instalado, registrado y verificado. La salida incluye email, rol y empresa. | Ve al Paso 3. Dile al usuario con qué email y rol ha quedado conectado. Si la salida lista **varias empresas**, pregúntale cuál quiere por defecto y vuelve a ejecutar el instalador con `-OrgId <id>` / `--org-id <id>` añadiendo `-SkipLogin -SkipSkills` / `--skip-login --skip-skills`. |
| `OK_SIN_VERIFICAR` | Instalado, pero se omitió la verificación. | Ejecuta `setup.ps1 -OnlyVerify` / `setup.sh --only-verify` y vuelve a esta tabla. |
| `LOGIN_PENDIENTE` | Todo instalado, pero no hay sesión de Access (el login no se completó, caducó, o se cerró el navegador). | Ejecuta `setup.ps1 -OnlyLogin` / `setup.sh --only-login` (abre el navegador otra vez; timeout largo). Si vuelve a fallar, pide al usuario que lo lance él con `!` y que compruebe en el navegador que entra con la cuenta correcta. |
| `SIN_PERMISO` | La cuenta de Google ha pasado Access, pero el CRM **no tiene dado de alta ese email** (o está inactivo). | No es un problema técnico tuyo. Dile al usuario que el **administrador del CRM** tiene que crear su usuario con ese email y asignarle rol y empresa. Cuando lo haga, basta `setup.ps1 -OnlyVerify` / `--only-verify`. |
| `SIN_EMPRESA` | El CRM conoce el email pero no pertenece a ninguna empresa. | Igual que `SIN_PERMISO`: el administrador debe asignarle una empresa. |
| `ERROR_NODE` | Falta Node.js ≥ 18 y no se pudo instalar automáticamente. | Pide al usuario que instale Node.js LTS desde <https://nodejs.org>, cierre y abra la terminal, y repite el Paso 1. |
| `ERROR_CLOUDFLARED` | No se pudo descargar/ejecutar `cloudflared`. | Repite una vez (puede ser red). Si persiste: Windows `winget install Cloudflare.cloudflared`, macOS `brew install cloudflared`; luego repite el Paso 1. |
| `ERROR_REGISTRO` | No hay Claude Code (CLI `claude`) ni Claude Desktop, o falló `claude mcp add`. | Lee el mensaje. Si falta Claude Code, el usuario debe instalarlo (<https://claude.com/claude-code>) y repetir. Si el error es de `claude mcp add`, muéstraselo literal al usuario. |
| `ERROR_COPIA` / `ERROR_KIT` | El zip está incompleto o `server.mjs` no compila con su Node. | Pide que descomprima el zip entero de nuevo. Si su Node es < 18, es `ERROR_NODE`. |
| `ERROR_VERIFICACION` | No se pudo contactar con el CRM o respondió algo inesperado. | Comprueba conectividad (abre la URL del CRM de `kit.json` en el navegador). Reintenta `-OnlyVerify`. Si persiste, muestra el mensaje literal al usuario. |

Si la salida **no termina** en `RESULTADO: …`, el script se cortó (timeout o
cierre del navegador). Vuelve a ejecutarlo: es seguro repetirlo.

### Paso 3 — Cierre: reinicio y prueba real

El MCP se carga **al arrancar** Claude, así que la sesión actual no lo ve
todavía (salvo que ya estuviera instalado antes). Dile al usuario, literalmente:

> Ya está instalado y verificado como **<email>** con rol **<rol>** en
> **<empresa>**. Reinicia Claude Code (cierra y vuelve a abrir, o `/exit` y
> `claude`) y, en la nueva sesión, pídeme: «usa whoami del CRM». Si te
> respondo con tu email, está todo conectado.

En esa nueva sesión, cuando te lo pida, llama a la tool `whoami` del servidor
`tudesancrm-cloud` (`mcp__tudesancrm-cloud__whoami`) y confirma email, rol y
empresa. Si la tool no existe en tu lista, el cliente no se reinició o el
registro falló: comprueba con `claude mcp list` que aparece `tudesancrm-cloud`
como *Connected*; si no, repite el Paso 1.

## Reglas que debes respetar

- **Nunca imprimas ni copies tokens/JWT.** El instalador ya se encarga de no
  mostrarlos. No ejecutes `cloudflared access token` tú mismo para "comprobar".
- **No modifiques** `server.mjs`, `kit.json` ni las skills. Si algo no cuadra,
  es un problema para el administrador del CRM, no para arreglar en local.
- **No registres el MCP a mano** (editando `~/.claude.json`,
  `claude_desktop_config.json` o un `.mcp.json`): el instalador lo hace con las
  rutas absolutas correctas y de forma idempotente. Si quieres cambiar algo
  (empresa por defecto, destino), vuelve a ejecutar el instalador con opciones.
- **No elijas la cuenta de Google por el usuario** ni le pidas su contraseña.
  La identidad la decide él en el navegador; tú solo verificas el email que
  devuelve el CRM.
- **Carpeta estable**: el instalador copia el kit a
  `%LOCALAPPDATA%\TudesanCRM-MCP` (Windows) o `~/.tudesancrm-mcp` (macOS/Linux)
  y registra el MCP desde ahí, de modo que el usuario puede borrar el zip y
  esta carpeta descomprimida. Avísale.
- Para **actualizar** a una versión nueva del kit: descomprimir el zip nuevo y
  ejecutar el mismo instalador. Sustituye los archivos y re-registra. No hay
  nada más que hacer.
- Para **desinstalar**: `claude mcp remove -s user tudesancrm-cloud`, borrar la
  carpeta estable y, si lo quiere, `~/.claude/skills/{expediente-hipotecario,cee,tasacion,asesor-hipotecario}`.
  La sesión de Access vive en `~/.cloudflared/` y caduca sola.

## Qué puede hacer el usuario cuando esté conectado (para orientarle)

El MCP expone 35 tools sobre el CRM: lectura de operaciones, titulares,
adjuntos (PDF e imágenes), histórico, bancos (catálogo e historial global), simulaciones, préstamos,
inmuebles y plantillas, y 16 tools de escritura con patrón **preview →
confirm** (nunca escriben sin una segunda llamada con `confirm: true`): entre
ellas vincular/editar/desvincular bancos de una operación y renombrar adjuntos
(desde v0.5.0). No puede crear ni borrar operaciones, ni borrar titulares,
documentos, préstamos o bancos del catálogo. Siempre ve exactamente lo que su
rol le permite ver en la web. Las skills instaladas se activan solas al pedir
«prepara el expediente de…», «¿vale este CEE?», «pide tasación para…» o «¿qué banco le va bien a…?».

**Plazos FEIN (desde v0.4.0).** Cada operación tiene tres fechas: `fechaMaxArras`
(límite del contrato de arras), `fechaMaxOfertaBancaria` (hasta cuándo el banco
elegido mantiene las condiciones) y `fechaMaxFein`, que el CRM calcula solo como
la menor entre la oferta bancaria y las arras − 11 días. El usuario puede pedirte
dos cosas: (a) **comunicarlas** («¿hasta cuándo tengo para la FEIN de…?» →
`get_operation` y responde con las tres fechas y los días que quedan) y
(b) **rellenarlas desde la documentación** («saca las fechas del contrato de
arras / de la oferta de X» → `list_documents` + `read_document_file`, localiza la
fecha en el texto, y propón `update_operation` con `fechaMaxArras` /
`fechaMaxOfertaBancaria` en formato `YYYY-MM-DD` citando el documento; aplica
solo tras el `confirm`). La validez de la oferta de cada banco concreto va en
`update_operation_bank` (`fechaMaxOferta`); al aprobar ese banco, el CRM copia
la fecha a la operación si allí estaba vacía.
