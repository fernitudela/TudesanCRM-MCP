# Conectar Claude con TudesanCRM — guía rápida

Este kit conecta tu Claude (Claude Code o Claude Desktop) con el CRM para que
pueda consultar tus operaciones, titulares y documentos, y ayudarte a preparar
expedientes, tasaciones y revisiones. **Todo corre en tu ordenador** y entra al
CRM **con tu cuenta de Google**, con los mismos permisos que tienes en la web.

## Antes de empezar

- El administrador del CRM tiene que haberte **dado de alta** (tu email de
  Google, tu rol y tu empresa). Si no, la instalación acabará con
  `SIN_PERMISO` o `SIN_EMPRESA`: pídeselo y vuelve a intentarlo.
- Necesitas **Claude Code** instalado (<https://claude.com/claude-code>) o
  Claude Desktop. El resto (Node.js, cloudflared) lo instala el kit si falta.
- Windows 10/11, macOS o Linux. No hacen falta permisos de administrador.

## Opción A — Que lo haga Claude (recomendada)

1. Descomprime el zip en cualquier carpeta (por ejemplo, el Escritorio).
2. Abre una terminal **dentro de esa carpeta** (en Windows: clic derecho sobre
   la carpeta → «Abrir en Terminal») y escribe `claude`.
3. Cuando Claude esté listo, pégale esto:

   > Conecta Claude con el CRM de Tudesan usando este kit, con mi cuenta.

4. Se abrirá el navegador: inicia sesión con **la cuenta de Google que te dio
   de alta el administrador**. Vuelve a la terminal.
5. Claude te dirá con qué email y rol has quedado conectado y te pedirá que
   reinicies Claude Code. Reinícialo y pídele: «usa whoami del CRM». Si te
   responde con tu email, está todo listo.

Si abriste Claude en otra carpeta, no pasa nada: dile dónde está el kit
(«el kit está en C:\Users\...\tudesancrm-mcp-kit») y seguirá sus instrucciones.

## Opción B — Instalador de doble clic (sin Claude)

- **Windows**: doble clic en `instalar.cmd`. Sigue el login de Google en el
  navegador. Al final verás `RESULTADO: OK` con tu email y rol.
- **macOS / Linux**: en una terminal, `bash setup.sh`.

Después, reinicia Claude Code / Claude Desktop.

## Cuándo volver a ejecutarlo

- **La sesión caduca** (normalmente a las 24 h). Claude te avisará con un
  mensaje de Cloudflare Access. Repite solo el login:
  Windows `pwsh -File setup.ps1 -OnlyLogin` (o pídeselo a Claude);
  macOS/Linux `bash setup.sh --only-login`.
- **Versión nueva del kit**: descomprime el zip nuevo y ejecuta el instalador
  otra vez. Sustituye todo y mantiene tu configuración.

## Qué se instala y dónde

| Qué | Dónde |
|---|---|
| El servidor MCP (un archivo) y este kit | Windows `%LOCALAPPDATA%\TudesanCRM-MCP`; macOS/Linux `~/.tudesancrm-mcp` |
| `cloudflared` (si no lo tenías) | subcarpeta `bin/` de la anterior |
| Registro del MCP `tudesancrm-cloud` | Claude Code (ámbito usuario) y/o Claude Desktop |
| Skills (expediente, CEE, tasación, asesor hipotecario) | `~/.claude/skills/` |

Puedes borrar el zip y la carpeta descomprimida cuando termine.

## Seguridad

- El kit **no contiene contraseñas ni claves**. La identidad la da tu login de
  Google, igual que en la web del CRM.
- Las acciones de escritura (editar un titular, añadir una nota al histórico…)
  siempre te muestran antes qué va a cambiar y requieren tu confirmación.
  Claude no puede crear ni borrar operaciones ni borrar nada.
- Si pierdes el ordenador o cambias de cuenta, pide al administrador que
  desactive tu usuario: el acceso deja de funcionar al instante.
