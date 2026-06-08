# Skill: Expediente Hipotecario

Esta carpeta contiene la skill **`expediente-hipotecario`** que acompaña al MCP
`tudesancrm-cloud`. Genera expedientes hipotecarios para el banco usando los
adjuntos del cliente (leídos vía el MCP) como única fuente de la verdad.

> **Requisito previo:** la skill llama a las tools del MCP `tudesancrm-cloud`.
> Instala y registra primero el MCP siguiendo el [README principal](../README.md).
> Sin el MCP, la skill no tiene de dónde leer los datos.

---

## Instalación

La skill es **personal**: se copia a `~/.claude/skills/expediente-hipotecario/`
y, a partir de ahí, Claude Code/Desktop la **auto-activa** sola cuando pides
"prepara el expediente de …". Hay tres formas:

### A) Pídeselo a Claude (lo más simple)

Abre Claude Code dentro de este repo y dile, por ejemplo:

> «Instala la skill de expediente hipotecario de este repo en mi Claude.»

Claude seguirá las instrucciones de la sección **"Para el agente"** de abajo.

### B) Script de instalación

```powershell
# Windows (PowerShell)
pwsh ./skills/install-skill.ps1
```
```bash
# macOS / Linux
bash ./skills/install-skill.sh
```
Añade `-Force` / `--force` para sobrescribir una instalación previa.

### C) Copia manual

Copia la carpeta `skills/expediente-hipotecario/` (con su subcarpeta `scripts/`)
a `~/.claude/skills/expediente-hipotecario/`. En Windows, `~` es `%USERPROFILE%`.

Tras cualquiera de las tres, **reinicia Claude Code/Desktop** para que la cargue.
Verifica con `/expediente-hipotecario` o pidiendo un expediente de prueba.

---

## Para el agente (instrucciones de instalación)

Si el usuario te pide instalar esta skill, haz **exactamente** esto:

1. Localiza la carpeta `skills/expediente-hipotecario/` dentro de este repo
   (contiene `SKILL.md` y `scripts/`).
2. Cópiala **entera** (incluyendo `scripts/`) a la carpeta de skills personales
   del usuario: `~/.claude/skills/expediente-hipotecario/`
   (en Windows: `%USERPROFILE%\.claude\skills\expediente-hipotecario\`).
   Crea `~/.claude/skills/` si no existe.
3. Si la skill ya existía ahí, **pregunta** antes de sobrescribir.
4. Equivalente: ejecutar el script `install-skill.ps1` (Windows) o
   `install-skill.sh` (macOS/Linux) de esta carpeta.
5. Avisa al usuario de que **reinicie Claude Code/Desktop** y de que la skill
   necesita el MCP `tudesancrm-cloud` registrado (ver README principal).

No modifiques el contenido de `SKILL.md` ni de los `scripts/` al copiarlos:
deben quedar idénticos para reproducir la misma experiencia.
