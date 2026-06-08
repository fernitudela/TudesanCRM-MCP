# Instala la skill "expediente-hipotecario" en tu Claude Code/Desktop personal.
# Copia skills/expediente-hipotecario/ -> ~/.claude/skills/expediente-hipotecario/
#
# Uso (Windows PowerShell), desde la raíz del repo o desde skills/:
#   pwsh ./skills/install-skill.ps1
#   pwsh ./skills/install-skill.ps1 -Force   # sobrescribe si ya existe
[CmdletBinding()]
param([switch]$Force)

$ErrorActionPreference = 'Stop'

# Carpeta de este script -> origen de la skill (junto a este .ps1).
$srcRoot = $PSScriptRoot
$src = Join-Path $srcRoot 'expediente-hipotecario'
if (-not (Test-Path $src)) {
    throw "No encuentro la skill en '$src'. Ejecuta el script desde el repo TudesanCRM-MCP."
}

$dstParent = Join-Path $HOME '.claude/skills'
$dst = Join-Path $dstParent 'expediente-hipotecario'

if (Test-Path $dst) {
    if (-not $Force) {
        Write-Host "Ya existe '$dst'." -ForegroundColor Yellow
        $ans = Read-Host "¿Sobrescribir? (s/N)"
        if ($ans -notin @('s', 'S', 'y', 'Y')) { Write-Host 'Cancelado.'; return }
    }
    Remove-Item -Recurse -Force $dst
}

New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
Copy-Item -Recurse -Force $src $dst

Write-Host "✓ Skill instalada en: $dst" -ForegroundColor Green
Write-Host "Reinicia Claude Code/Desktop para que la cargue." -ForegroundColor Cyan
