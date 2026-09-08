# Skills

Esta carpeta contiene las skills que acompañan al MCP `tudesancrm-cloud`.
Todas leen datos vía las tools del MCP (algunas también escriben, ver tabla).

> **Requisito previo:** las skills llaman a las tools del MCP `tudesancrm-cloud`.
> Instala y registra primero el MCP siguiendo el [README principal](../README.md).
> Sin el MCP, las skills no tienen de dónde leer los datos.

| Skill | Qué hace | CRM |
|---|---|---|
| `expediente-hipotecario` | Genera expedientes hipotecarios para el banco a partir de los adjuntos del cliente | solo lectura |
| `cee` | Comprueba si el Certificado de Eficiencia Energética de un cliente basta para la tasación | solo lectura |
| `tasacion` | Redacta el correo de solicitud de tasación de una operación | solo lectura |

---

## Instalación

Las skills son **personales**: se copian a `~/.claude/skills/<nombre>/` y, a
partir de ahí, Claude Code/Desktop las **auto-activa** solas según el contexto
(p. ej. "prepara el expediente de …", "¿vale este CEE?", "pide tasación para …").
Hay tres formas:

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

Copia la carpeta de la skill (`skills/expediente-hipotecario/` con su
subcarpeta `scripts/`, o `skills/cee/` / `skills/tasacion/`, que son solo
`SKILL.md`) a `~/.claude/skills/<nombre>/`. En Windows, `~` es `%USERPROFILE%`.

Tras cualquiera de las tres, **reinicia Claude Code/Desktop** para que la cargue.
Verifica con `/<nombre-skill>` o pidiendo una tarea de prueba.

---

## Para el agente (instrucciones de instalación)

Si el usuario te pide instalar una de estas skills, haz **exactamente** esto:

1. Localiza la carpeta `skills/<nombre>/` dentro de este repo (contiene
   `SKILL.md` y, solo en `expediente-hipotecario`, también `scripts/`).
2. Cópiala **entera** a la carpeta de skills personales del usuario:
   `~/.claude/skills/<nombre>/`
   (en Windows: `%USERPROFILE%\.claude\skills\<nombre>\`).
   Crea `~/.claude/skills/` si no existe.
3. Si la skill ya existía ahí, **pregunta** antes de sobrescribir.
4. Equivalente para `expediente-hipotecario`: ejecutar el script
   `install-skill.ps1` (Windows) o `install-skill.sh` (macOS/Linux) de esta
   carpeta.
5. Avisa al usuario de que **reinicie Claude Code/Desktop** y de que la skill
   necesita el MCP `tudesancrm-cloud` registrado (ver README principal).

No modifiques el contenido de `SKILL.md` ni de los `scripts/` al copiarlos:
deben quedar idénticos para reproducir la misma experiencia.
