#Requires -Version 5.1
<#
.SYNOPSIS
  Genera el zip distribuible del MCP (kit de conexion para usuarios nuevos).

.DESCRIPTION
  1. Empaqueta server.mjs + dependencias en UN archivo con esbuild (sin node_modules).
  2. Copia kit/ (instaladores, CLAUDE.md, LEEME.md, kit.json) y skills/.
  3. Sella kit.json con version (package.json) y fecha de build.
  4. Opcional: incluye cloudflared.exe (Windows) para instalaciones sin descarga.
  5. Comprime en dist/tudesancrm-mcp-kit-v<version>.zip y muestra el SHA256.

.EXAMPLE
  npm run build:kit
  pwsh ./build-kit.ps1 -IncludeCloudflared "$env:USERPROFILE\.local\bin\cloudflared.exe"
#>
[CmdletBinding()]
param(
  # Ruta a un cloudflared.exe que se incluira en kit/bin (opcional; +~20 MB comprimido).
  [string]$IncludeCloudflared,
  # URL del CRM que llevara el kit (por defecto la de kit/kit.json).
  [string]$CrmUrl,
  [string]$OutDir = (Join-Path $PSScriptRoot 'dist')
)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$pkg = Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$kitName = 'tudesancrm-mcp-kit'
$stage = Join-Path $OutDir "stage\$kitName"

Write-Host "== Build kit v$version" -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 1. Bundle (esbuild es devDependency; npm install previo).
$esbuild = Join-Path $repo 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "Falta esbuild: ejecuta 'npm install' en $repo" }
$banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
$bundleOut = Join-Path $stage 'server.mjs'
& $esbuild (Join-Path $repo 'server.mjs') --bundle --platform=node --format=esm --target=node18 --log-level=warning `
  "--outfile=$bundleOut" "--banner:js=$banner"
if ($LASTEXITCODE -ne 0) { throw 'esbuild fallo' }
# Smoke: debe compilar con el Node local.
& node --check $bundleOut; if ($LASTEXITCODE -ne 0) { throw 'El bundle no compila' }
Write-Host "   OK  server.mjs empaquetado ($([math]::Round((Get-Item $bundleOut).Length/1KB)) KB)" -ForegroundColor Green

# 2. Archivos del kit + skills.
foreach ($f in @('setup.ps1', 'setup.sh', 'instalar.cmd', 'CLAUDE.md', 'LEEME.md')) {
  Copy-Item -Force (Join-Path $repo "kit\$f") (Join-Path $stage $f)
}
Copy-Item -Recurse -Force (Join-Path $repo 'skills') (Join-Path $stage 'skills')
Get-ChildItem (Join-Path $stage 'skills') -Recurse -Include '__pycache__' -Directory | Remove-Item -Recurse -Force

# 3. kit.json sellado.
$kit = Get-Content (Join-Path $repo 'kit\kit.json') -Raw | ConvertFrom-Json
$kit.version = $version
$kit.builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
if ($CrmUrl) { $kit.crmUrl = $CrmUrl.TrimEnd('/') }
[IO.File]::WriteAllText((Join-Path $stage 'kit.json'), ($kit | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

# 4. cloudflared opcional.
if ($IncludeCloudflared) {
  if (-not (Test-Path $IncludeCloudflared)) { throw "No existe $IncludeCloudflared" }
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'bin') | Out-Null
  Copy-Item -Force $IncludeCloudflared (Join-Path $stage 'bin\cloudflared.exe')
  Write-Host '   OK  cloudflared.exe incluido en bin/' -ForegroundColor Green
}

# 5. Zip.
$zip = Join-Path $OutDir "$kitName-v$version.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
$sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "`nZip:    $zip ($sizeMb MB)" -ForegroundColor White
Write-Host "SHA256: $hash"
Write-Host "`nContenido:"
Get-ChildItem $stage -Recurse -File | ForEach-Object { '   ' + $_.FullName.Substring($stage.Length + 1) }
