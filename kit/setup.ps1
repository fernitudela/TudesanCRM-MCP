#Requires -Version 5.1
<#
.SYNOPSIS
  Instala y registra el MCP de TudesanCRM en este equipo (Windows).

.DESCRIPTION
  Idempotente y NO interactivo: no hace preguntas por consola. Lo unico que
  requiere accion humana es el login de Google, que se abre en el navegador.

  Pasos: Node.js -> cloudflared -> copiar el kit a una carpeta estable ->
  login de Cloudflare Access -> registrar el MCP (Claude Code y/o Claude Desktop)
  -> instalar skills -> verificar la identidad contra el CRM (/api/me).

  La ULTIMA linea de la salida es siempre "RESULTADO: <CODIGO>" (ver CLAUDE.md):
    OK               todo instalado y verificado (imprime email/rol/empresa)
    OK_SIN_VERIFICAR instalado y registrado; verificacion omitida (-SkipVerify)
    LOGIN_PENDIENTE  instalado y registrado, pero no hay sesion de Access valida
    SIN_PERMISO      sesion valida, pero el CRM no reconoce el email (403)
    SIN_EMPRESA      el CRM reconoce el email pero no pertenece a ninguna empresa
    ERROR_<PASO>     fallo en un paso (KIT, NODE, CLOUDFLARED, COPIA, REGISTRO, VERIFICACION)

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
  pwsh -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -OrgId 3 -SkipLogin -SkipSkills
  pwsh -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -OnlyVerify
#>
[CmdletBinding()]
param(
  # URL del CRM (origen del Worker). Por defecto la de kit.json.
  [string]$CrmUrl,
  # Empresa activa por defecto (solo si perteneces a varias). Numero de whoami.orgs[].id.
  [string]$OrgId,
  # Donde registrar el MCP. Auto = Claude Code si existe el CLI "claude", y Claude Desktop si esta instalado.
  [ValidateSet('Auto', 'Code', 'Desktop', 'Both', 'None')][string]$Target = 'Auto',
  # Carpeta estable donde queda instalado el MCP (el zip se puede borrar despues).
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'TudesanCRM-MCP'),
  [switch]$SkipLogin,
  [switch]$SkipSkills,
  [switch]$SkipVerify,
  # Solo hacer el login de Access (y comprobar la sesion).
  [switch]$OnlyLogin,
  # Solo verificar la sesion y la identidad en el CRM (no instala nada).
  [switch]$OnlyVerify,
  # Ruta alternativa del claude_desktop_config.json (pruebas).
  [string]$DesktopConfigPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

# ----------------------------------------------------------------------------
# Utilidades
# ----------------------------------------------------------------------------
function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "       $msg" }
function Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Finish($code, $msg) {
  if ($msg) { Write-Host "`n$msg" }
  Write-Host "`nRESULTADO: $code"
  exit 0
}
function Fail($code, $msg) {
  Write-Host "`n   XX  $msg" -ForegroundColor Red
  Write-Host "`nRESULTADO: ERROR_$code"
  exit 1
}
function Test-JwtShape([string]$s) {
  return ($null -ne $s) -and ($s.Trim() -match '^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$')
}
function Get-KitFile([string]$relative) {
  # Busca un archivo del kit: primero junto a este script, luego en InstallDir.
  foreach ($root in @($PSScriptRoot, $InstallDir)) {
    $p = Join-Path $root $relative
    if (Test-Path $p) { return $p }
  }
  return $null
}

$kitJsonPath = Get-KitFile 'kit.json'
if (-not $kitJsonPath) { Fail 'KIT' "No encuentro kit.json junto a setup.ps1 ($PSScriptRoot). Descomprime el zip entero." }
$kit = Get-Content $kitJsonPath -Raw | ConvertFrom-Json
if (-not $CrmUrl) { $CrmUrl = $kit.crmUrl }
$CrmUrl = $CrmUrl.TrimEnd('/')
$McpName = $kit.mcpName

Write-Host "TudesanCRM MCP kit v$($kit.version)  ->  $CrmUrl" -ForegroundColor White
Write-Host "Carpeta de instalacion: $InstallDir"

# ----------------------------------------------------------------------------
# cloudflared: localizar (o descargar)
# ----------------------------------------------------------------------------
function Find-Cloudflared {
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $candidates = @(
    (Join-Path $InstallDir 'bin\cloudflared.exe'),
    (Join-Path $PSScriptRoot 'bin\cloudflared.exe'),
    (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
    (Join-Path $env:USERPROFILE '.local\bin\cloudflared.exe')
  )
  if ($pf86) { $candidates += (Join-Path $pf86 'cloudflared\cloudflared.exe') }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path } }
  $cmd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Ensure-Cloudflared {
  $cf = Find-Cloudflared
  if ($cf) { Ok "cloudflared: $cf"; return $cf }
  $binDir = Join-Path $InstallDir 'bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $dst = Join-Path $binDir 'cloudflared.exe'
  $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Info "Descargando cloudflared desde $url ..."
  try {
    Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing
  } catch {
    Fail 'CLOUDFLARED' "No pude descargar cloudflared ($($_.Exception.Message)). Alternativas: 'winget install Cloudflare.cloudflared' o copia cloudflared.exe en $binDir y vuelve a ejecutar."
  }
  $ver = (& $dst --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail 'CLOUDFLARED' "cloudflared descargado pero no arranca: $ver" }
  Ok "cloudflared descargado: $dst ($ver)"
  return $dst
}

# ----------------------------------------------------------------------------
# Sesion de Access
# ----------------------------------------------------------------------------
function Get-AccessToken([string]$cf) {
  # Devuelve el JWT de la sesion actual o $null. Nunca lo imprime.
  try {
    $out = (& $cf access token "--app=$CrmUrl" 2>$null | Out-String).Trim()
  } catch { return $null }
  if (Test-JwtShape $out) { return $out }
  return $null
}

function Do-Login([string]$cf) {
  Info 'Se abre el navegador: inicia sesion con la cuenta de Google que te dio de alta el administrador del CRM.'
  Info 'Si el navegador no se abre, copia la URL que imprime cloudflared y pegala en el navegador.'
  & $cf access login --quiet $CrmUrl
  if ($LASTEXITCODE -ne 0) { Warn "cloudflared access login termino con codigo $LASTEXITCODE" }
}

# ----------------------------------------------------------------------------
# Verificacion contra el CRM
# ----------------------------------------------------------------------------
function Verify-Identity([string]$cf) {
  $jwt = Get-AccessToken $cf
  if (-not $jwt) { return @{ code = 'LOGIN_PENDIENTE'; msg = "No hay sesion de Cloudflare Access para $CrmUrl. Ejecuta: setup.ps1 -OnlyLogin" } }
  $headers = @{ 'cf-access-token' = $jwt; 'accept' = 'application/json' }
  if ($OrgId) { $headers['X-Org-Id'] = "$OrgId" }
  $status = 0; $body = $null
  try {
    $resp = Invoke-WebRequest -Uri "$CrmUrl/api/me" -Headers $headers -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
    $status = [int]$resp.StatusCode; $body = $resp.Content
  } catch {
    $r = $_.Exception.Response
    if ($r) { $status = [int]$r.StatusCode } else { return @{ code = 'ERROR_VERIFICACION'; msg = "No pude contactar con $CrmUrl : $($_.Exception.Message)" } }
    try { $body = $_.ErrorDetails.Message } catch {}
  }
  if ($status -ge 300 -and $status -lt 400) { return @{ code = 'LOGIN_PENDIENTE'; msg = 'Cloudflare Access rechazo la sesion (redireccion a login). Ejecuta: setup.ps1 -OnlyLogin' } }
  if ($status -eq 403) { return @{ code = 'SIN_PERMISO'; msg = 'Tu cuenta de Google ha pasado Cloudflare Access pero el CRM no la tiene dada de alta (o esta inactiva). Pide al administrador del CRM que cree tu usuario con ese email.' } }
  if ($status -ne 200) { return @{ code = 'ERROR_VERIFICACION'; msg = "El CRM respondio HTTP $status a /api/me. Cuerpo: $body" } }
  $me = $body | ConvertFrom-Json
  $orgs = @($me.orgs)
  $lines = @("Usuario: $($me.email)", "Fuente de identidad: $($me.source)")
  if ($orgs.Count -eq 0 -and -not $me.isSuperadmin) {
    return @{ code = 'SIN_EMPRESA'; msg = (($lines + 'El CRM reconoce tu email pero no perteneces a ninguna empresa. Pide al administrador que te asigne a la tuya.') -join "`n") }
  }
  $lines += "Empresa activa: $($me.activeOrg.nombre) (id $($me.activeOrg.id)) con rol '$($me.role)'"
  if ($orgs.Count -gt 1) {
    $lines += 'Perteneces a VARIAS empresas; si quieres fijar otra por defecto, vuelve a ejecutar con -OrgId <id>:'
    foreach ($o in $orgs) { $lines += "   - id $($o.id): $($o.nombre) [$($o.role)]" }
  }
  return @{ code = 'OK'; msg = ($lines -join "`n") }
}

# ----------------------------------------------------------------------------
# Modos cortos
# ----------------------------------------------------------------------------
if ($OnlyVerify) {
  Step 'Verificar sesion e identidad'
  $cf = Find-Cloudflared
  if (-not $cf) { Fail 'CLOUDFLARED' 'No encuentro cloudflared. Ejecuta el setup completo primero.' }
  $v = Verify-Identity $cf
  Finish $v.code $v.msg
}
if ($OnlyLogin) {
  Step 'Login de Cloudflare Access'
  $cf = Find-Cloudflared
  if (-not $cf) { $cf = Ensure-Cloudflared }
  if (Get-AccessToken $cf) { Ok 'Ya hay una sesion valida; no hace falta volver a loguearse.' }
  else { Do-Login $cf }
  $v = Verify-Identity $cf
  Finish $v.code $v.msg
}

# ----------------------------------------------------------------------------
# 1. Node.js
# ----------------------------------------------------------------------------
Step '1/6 Node.js (>= 18)'
function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $p = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $p) { return $p }
  return $null
}
$nodeExe = Find-Node
if (-not $nodeExe) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Info 'Node.js no esta instalado. Instalando Node.js LTS con winget (puede pedir confirmacion de Windows)...'
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Host
    $nodeExe = Find-Node
  }
}
if (-not $nodeExe) { Fail 'NODE' 'Node.js no esta instalado. Instalalo desde https://nodejs.org (version LTS), cierra y abre la terminal y vuelve a ejecutar setup.ps1.' }
$nodeVer = (& $nodeExe --version | Out-String).Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail 'NODE' "Node.js $nodeVer es demasiado antiguo; hace falta 18 o superior (https://nodejs.org)." }
Ok "Node.js $nodeVer en $nodeExe"

# ----------------------------------------------------------------------------
# 2. cloudflared
# ----------------------------------------------------------------------------
Step '2/6 cloudflared'
$cf = Ensure-Cloudflared

# ----------------------------------------------------------------------------
# 3. Copiar el kit a la carpeta estable
# ----------------------------------------------------------------------------
Step "3/6 Copiar el MCP a $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$sameDir = ((Resolve-Path $PSScriptRoot).Path.TrimEnd('\') -ieq (Resolve-Path $InstallDir).Path.TrimEnd('\'))
if ($sameDir) {
  Info 'El script ya se ejecuta desde la carpeta de instalacion; no hay nada que copiar.'
} else {
  foreach ($f in @('server.mjs', 'kit.json', 'setup.ps1', 'setup.sh', 'instalar.cmd', 'CLAUDE.md', 'LEEME.md')) {
    $src = Join-Path $PSScriptRoot $f
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $InstallDir $f) }
  }
  $skillsSrc = Join-Path $PSScriptRoot 'skills'
  if (Test-Path $skillsSrc) {
    $skillsDst = Join-Path $InstallDir 'skills'
    if (Test-Path $skillsDst) { Remove-Item -Recurse -Force $skillsDst }
    Copy-Item -Recurse -Force $skillsSrc $skillsDst
  }
}
$serverPath = Join-Path $InstallDir 'server.mjs'
if (-not (Test-Path $serverPath)) { Fail 'COPIA' "Falta $serverPath. El zip esta incompleto: vuelve a descomprimirlo entero." }
# Comprobacion de sintaxis con el Node que se va a usar (no arranca el servidor).
$check = (& $nodeExe --check $serverPath 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { Fail 'COPIA' "server.mjs no compila con Node $nodeVer : $check" }
Ok "server.mjs listo en $serverPath"

# ----------------------------------------------------------------------------
# 4. Login de Cloudflare Access
# ----------------------------------------------------------------------------
Step '4/6 Sesion de Cloudflare Access (login de Google)'
if ($SkipLogin) { Warn 'Login omitido (-SkipLogin): no se comprueba la sesion. Si no la tienes: setup.ps1 -OnlyLogin' }
elseif (Get-AccessToken $cf) { Ok 'Ya existe una sesion valida de Access en este equipo.' }
else {
  Do-Login $cf
  $hasSession = [bool](Get-AccessToken $cf)
  if ($hasSession) { Ok 'Sesion de Access establecida.' } else { Warn 'No se obtuvo sesion de Access. Podras repetirlo con: setup.ps1 -OnlyLogin' }
}

# ----------------------------------------------------------------------------
# 5. Registrar el MCP en Claude
# ----------------------------------------------------------------------------
Step '5/6 Registrar el MCP en Claude'
$claudeCli = Get-Command claude -ErrorAction SilentlyContinue
$desktopCfg = if ($DesktopConfigPath) { $DesktopConfigPath } else { Join-Path $env:APPDATA 'Claude\claude_desktop_config.json' }
$desktopInstalled = Test-Path (Split-Path $desktopCfg -Parent)

$doCode = $false; $doDesktop = $false
switch ($Target) {
  'Auto'    { $doCode = [bool]$claudeCli; $doDesktop = $desktopInstalled }
  'Code'    { $doCode = $true }
  'Desktop' { $doDesktop = $true }
  'Both'    { $doCode = $true; $doDesktop = $true }
  'None'    { }
}
if ($Target -eq 'Auto' -and -not $doCode -and -not $doDesktop) {
  Fail 'REGISTRO' 'No encuentro ni el CLI "claude" (Claude Code) ni Claude Desktop en este equipo. Instala Claude Code (https://claude.com/claude-code) y vuelve a ejecutar.'
}

$envPairs = @("CLOUDFLARED_PATH=$cf", "TUDESAN_BASE_URL=$CrmUrl")
if ($OrgId) { $envPairs += "TUDESAN_ORG_ID=$OrgId" }

if ($doCode) {
  if (-not $claudeCli) { Fail 'REGISTRO' 'Se pidio registrar en Claude Code pero el CLI "claude" no esta en el PATH.' }
  & claude mcp remove -s user $McpName 2>&1 | Out-Null
  $cliArgs = @('mcp', 'add', '-s', 'user', $McpName)
  foreach ($e in $envPairs) { $cliArgs += @('-e', $e) }
  $cliArgs += @('--', $nodeExe, $serverPath)
  $out = (& claude @cliArgs 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail 'REGISTRO' "claude mcp add fallo: $out" }
  Ok "Claude Code: MCP '$McpName' registrado (scope user, disponible en todos tus proyectos)."
}

if ($doDesktop) {
  New-Item -ItemType Directory -Force -Path (Split-Path $desktopCfg -Parent) | Out-Null
  $cfg = $null
  if (Test-Path $desktopCfg) {
    Copy-Item -Force $desktopCfg "$desktopCfg.bak"
    $raw = Get-Content $desktopCfg -Raw
    if ($raw -and $raw.Trim()) { $cfg = $raw | ConvertFrom-Json }
  }
  if (-not $cfg) { $cfg = [pscustomobject]@{} }
  if (-not ($cfg.PSObject.Properties.Name -contains 'mcpServers') -or -not $cfg.mcpServers) {
    $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $envObj = [ordered]@{}
  foreach ($e in $envPairs) { $k, $v = $e.Split('=', 2); $envObj[$k] = $v }
  $entry = [pscustomobject]@{ command = $nodeExe; args = @($serverPath); env = [pscustomobject]$envObj }
  $cfg.mcpServers | Add-Member -NotePropertyName $McpName -NotePropertyValue $entry -Force
  $json = $cfg | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($desktopCfg, $json, (New-Object Text.UTF8Encoding $false))
  Ok "Claude Desktop: MCP '$McpName' escrito en $desktopCfg (copia previa en .bak)."
}

# ----------------------------------------------------------------------------
# 6. Skills
# ----------------------------------------------------------------------------
Step '6/6 Skills de Claude (expediente, CEE, tasacion, asesor)'
if ($SkipSkills) { Info 'Omitido (-SkipSkills).' }
else {
  $skillsRoot = Join-Path $InstallDir 'skills'
  $dstParent = Join-Path $HOME '.claude\skills'
  New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
  foreach ($name in @($kit.skills)) {
    $src = Join-Path $skillsRoot $name
    if (-not (Test-Path $src)) { Warn "Skill '$name' no viene en el kit; se omite."; continue }
    $dst = Join-Path $dstParent $name
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse -Force $src $dst
    Ok "skill '$name' -> $dst"
  }
}

# ----------------------------------------------------------------------------
# Verificacion final
# ----------------------------------------------------------------------------
Step 'Verificacion'
Write-Host "`nInstalado en:   $InstallDir"
Write-Host "Servidor MCP:   $nodeExe $serverPath"
Write-Host "cloudflared:    $cf"
Write-Host "CRM:            $CrmUrl"
Write-Host 'Siguiente paso: REINICIA Claude Code / Claude Desktop para que cargue el MCP y pide "usa la tool whoami del CRM".'
if ($SkipVerify) { Finish 'OK_SIN_VERIFICAR' 'Verificacion omitida (-SkipVerify).' }
$v = Verify-Identity $cf
Finish $v.code $v.msg
