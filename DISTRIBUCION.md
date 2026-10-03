# Distribuir el MCP a usuarios nuevos (guía del administrador)

El objetivo es que una persona que empieza a usar el CRM reciba **un zip**, se
lo entregue a su Claude con la frase «conecta Claude con el CRM de Tudesan
usando este kit, con mi cuenta» y quede conectada sin saber configurar nada.
El zip no contiene secretos: la identidad la da el login de Google de cada uno.

## 1. Alta del usuario (antes de enviar el kit)

Sin estos dos pasos la instalación acaba en `SIN_PERMISO` o `SIN_EMPRESA`.

1. **Cloudflare Access**: su email de Google debe estar permitido en la
   política *Allow* de la aplicación Access del CRM (Zero Trust → Access →
   Applications → la app del Worker). Es el mismo permiso que necesita para
   entrar a la web.
2. **Usuario en el CRM**: crear el usuario con ese email, su rol
   (admin / colaborador / referido) y su empresa, desde la administración de
   usuarios del CRM. Si pertenece a varias empresas, dile cuál es su ID por
   defecto (o déjale elegir: el instalador las lista).

## 2. Generar el zip

```powershell
cd repos\tudesancrm-mcp
npm install            # una vez (instala esbuild como devDependency)
npm run build:kit      # -> dist\tudesancrm-mcp-kit-v<version>.zip + SHA256
```

Opcional, para equipos sin descarga de GitHub (añade ~20 MB):

```powershell
pwsh ./build-kit.ps1 -IncludeCloudflared "$env:USERPROFILE\.local\bin\cloudflared.exe"
```

Qué lleva el zip: `server.mjs` (un solo archivo, sin `node_modules`),
`setup.ps1` / `setup.sh` / `instalar.cmd`, `CLAUDE.md` (runbook que sigue el
Claude del usuario), `LEEME.md` (guía humana), `kit.json` y `skills/`.

**Versionar**: sube `version` en `package.json` antes de construir; el nombre
del zip y `kit.json` la heredan. Un kit nuevo se instala encima del anterior
ejecutando el mismo instalador.

## 3. Enviar

Manda el zip junto con este texto (o enlaza `LEEME.md`):

> Descomprime el zip, abre una terminal en esa carpeta, escribe `claude` y
> pégale: «Conecta Claude con el CRM de Tudesan usando este kit, con mi
> cuenta». Se abrirá el navegador para entrar con tu Google. Cuando Claude te
> lo diga, reinicia Claude Code y pídele «usa whoami del CRM».

Si la persona no tiene Claude Code, puede instalarlo desde
<https://claude.com/claude-code>. Con solo Claude Desktop también funciona:
el instalador escribe la configuración de Desktop si lo detecta.

## 4. Qué hace el instalador en su equipo

1. Comprueba Node.js ≥ 18 (en Windows intenta instalarlo con `winget` si falta).
2. Localiza `cloudflared` o lo descarga de las releases oficiales a la carpeta
   del kit.
3. Copia el kit a una carpeta estable (`%LOCALAPPDATA%\TudesanCRM-MCP` o
   `~/.tudesancrm-mcp`).
4. `cloudflared access login <URL del CRM>` (abre el navegador; sesión ~24 h).
5. Registra el MCP `tudesancrm-cloud` con `claude mcp add -s user` y/o en
   `claude_desktop_config.json`, con rutas absolutas y `CLOUDFLARED_PATH`.
6. Copia las skills a `~/.claude/skills/`.
7. Verifica llamando a `/api/me` con el JWT y termina con una línea
   `RESULTADO: <código>` que el Claude del usuario interpreta (tabla en
   `kit/CLAUDE.md`).

## 5. Soporte: códigos que te pueden reportar

| Código | Qué significa para ti |
|---|---|
| `SIN_PERMISO` | Pasó Access pero el CRM no conoce el email: falta crear el usuario (o está inactivo). |
| `SIN_EMPRESA` | Usuario creado sin empresa asignada. |
| `LOGIN_PENDIENTE` | No completó el login de Google (o entró con otra cuenta, o no está en la política de Access). |
| `ERROR_*` | Problema técnico local (Node, red, Claude no instalado). El mensaje del script lo detalla. |

## 6. Mantenimiento

- Si cambia la URL del CRM (dominio propio), cambia `crmUrl` en `kit/kit.json`
  (o pasa `-CrmUrl` a `build-kit.ps1`) y reparte un kit nuevo.
- Si añades tools al MCP, solo hay que reconstruir el kit; el instalador del
  usuario sustituye `server.mjs` al re-ejecutarlo.
- La página de onboarding del CRM (`OnboardingPage.tsx` en `tudesancrm-cloud`)
  hoy enlaza al README de GitHub y propone un prompt de «clona el repo»; cuando
  el kit sea el camino oficial conviene cambiarla para enlazar el zip y el
  prompt del apartado 3 (requiere deploy del Worker).
