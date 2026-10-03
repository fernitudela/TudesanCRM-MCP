#!/usr/bin/env bash
# Instala y registra el MCP de TudesanCRM en este equipo (macOS / Linux).
#
# Idempotente y NO interactivo: no pregunta nada por consola. Lo unico que
# requiere accion humana es el login de Google, que se abre en el navegador.
#
# Pasos: Node.js -> cloudflared -> copiar el kit a una carpeta estable ->
# login de Cloudflare Access -> registrar el MCP (Claude Code y/o Claude Desktop)
# -> instalar skills -> verificar la identidad contra el CRM (/api/me).
#
# La ULTIMA linea de la salida es siempre "RESULTADO: <CODIGO>" (ver CLAUDE.md):
#   OK | OK_SIN_VERIFICAR | LOGIN_PENDIENTE | SIN_PERMISO | SIN_EMPRESA | ERROR_<PASO>
#
# Uso:
#   bash setup.sh                       # instalacion completa
#   bash setup.sh --org-id 3            # fija la empresa por defecto (multi-empresa)
#   bash setup.sh --only-login          # solo login de Access + verificacion
#   bash setup.sh --only-verify         # solo verificacion
#   bash setup.sh --target code|desktop|both|none   (por defecto: auto)
#   bash setup.sh --skip-login --skip-skills --skip-verify
#   bash setup.sh --install-dir /ruta   (por defecto ~/.tudesancrm-mcp)
set -uo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.tudesancrm-mcp"
CRM_URL=""; ORG_ID=""; TARGET="auto"
SKIP_LOGIN=0; SKIP_SKILLS=0; SKIP_VERIFY=0; ONLY_LOGIN=0; ONLY_VERIFY=0
DESKTOP_CFG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --crm-url) CRM_URL="$2"; shift 2;;
    --org-id) ORG_ID="$2"; shift 2;;
    --target) TARGET="$2"; shift 2;;
    --install-dir) INSTALL_DIR="$2"; shift 2;;
    --desktop-config) DESKTOP_CFG="$2"; shift 2;;
    --skip-login) SKIP_LOGIN=1; shift;;
    --skip-skills) SKIP_SKILLS=1; shift;;
    --skip-verify) SKIP_VERIFY=1; shift;;
    --only-login) ONLY_LOGIN=1; shift;;
    --only-verify) ONLY_VERIFY=1; shift;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    *) echo "Opcion desconocida: $1" >&2; echo "RESULTADO: ERROR_ARGS"; exit 1;;
  esac
done

step() { printf '\n\033[36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32mOK\033[0m  %s\n' "$*"; }
info() { printf '       %s\n' "$*"; }
warn() { printf '   \033[33m!!\033[0m  %s\n' "$*"; }
finish() { local code="$1"; shift; [[ $# -gt 0 ]] && printf '\n%s\n' "$*"; printf '\nRESULTADO: %s\n' "$code"; exit 0; }
fail()   { local code="$1"; shift; printf '\n   \033[31mXX\033[0m  %s\n' "$*"; printf '\nRESULTADO: ERROR_%s\n' "$code"; exit 1; }

kit_file() { for root in "$KIT_DIR" "$INSTALL_DIR"; do [[ -f "$root/$1" ]] && { echo "$root/$1"; return 0; }; done; return 1; }

KIT_JSON="$(kit_file kit.json)" || fail KIT "No encuentro kit.json junto a setup.sh ($KIT_DIR). Descomprime el zip entero."
json_get() { # json_get <archivo> <clave>  (valores escalares)
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n1
}
[[ -n "$CRM_URL" ]] || CRM_URL="$(json_get "$KIT_JSON" crmUrl)"
CRM_URL="${CRM_URL%/}"
MCP_NAME="$(json_get "$KIT_JSON" mcpName)"
KIT_VERSION="$(json_get "$KIT_JSON" version)"
SKILLS="$(sed -n 's/.*"skills"[[:space:]]*:[[:space:]]*\[\(.*\)\].*/\1/p' "$KIT_JSON" | tr -d '" ' | tr ',' ' ')"

echo "TudesanCRM MCP kit v${KIT_VERSION}  ->  ${CRM_URL}"
echo "Carpeta de instalacion: ${INSTALL_DIR}"

OS="$(uname -s)"; ARCH="$(uname -m)"

# ----------------------------------------------------------------------------
# cloudflared
# ----------------------------------------------------------------------------
find_cloudflared() {
  for c in "$INSTALL_DIR/bin/cloudflared" "$KIT_DIR/bin/cloudflared" /opt/homebrew/bin/cloudflared /usr/local/bin/cloudflared /usr/bin/cloudflared; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  command -v cloudflared 2>/dev/null && return 0
  return 1
}
ensure_cloudflared() {
  local cf; cf="$(find_cloudflared)" && { ok "cloudflared: $cf" >&2; echo "$cf"; return 0; }
  if [[ "$OS" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    info "Instalando cloudflared con Homebrew..." >&2
    brew install cloudflared >&2 || true
    cf="$(find_cloudflared)" && { ok "cloudflared: $cf" >&2; echo "$cf"; return 0; }
  fi
  mkdir -p "$INSTALL_DIR/bin"
  local base="https://github.com/cloudflare/cloudflared/releases/latest/download"
  local a; case "$ARCH" in arm64|aarch64) a=arm64;; x86_64|amd64) a=amd64;; *) fail CLOUDFLARED "Arquitectura no soportada: $ARCH";; esac
  info "Descargando cloudflared ($OS/$a)..." >&2
  if [[ "$OS" == "Darwin" ]]; then
    curl -fsSL "$base/cloudflared-darwin-$a.tgz" -o "$INSTALL_DIR/bin/cloudflared.tgz" || fail CLOUDFLARED "No pude descargar cloudflared. Alternativa: brew install cloudflared"
    tar -xzf "$INSTALL_DIR/bin/cloudflared.tgz" -C "$INSTALL_DIR/bin" && rm -f "$INSTALL_DIR/bin/cloudflared.tgz"
  else
    curl -fsSL "$base/cloudflared-linux-$a" -o "$INSTALL_DIR/bin/cloudflared" || fail CLOUDFLARED "No pude descargar cloudflared desde $base"
  fi
  chmod +x "$INSTALL_DIR/bin/cloudflared"
  "$INSTALL_DIR/bin/cloudflared" --version >/dev/null 2>&1 || fail CLOUDFLARED "cloudflared descargado pero no arranca"
  ok "cloudflared descargado: $INSTALL_DIR/bin/cloudflared" >&2
  echo "$INSTALL_DIR/bin/cloudflared"
}

# ----------------------------------------------------------------------------
# Sesion de Access
# ----------------------------------------------------------------------------
JWT_RE='^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$'
get_token() { # nunca lo imprime fuera de esta funcion
  local out; out="$("$1" access token "--app=$CRM_URL" 2>/dev/null | tr -d '\r\n')" || return 1
  [[ "$out" =~ $JWT_RE ]] && { echo "$out"; return 0; }
  return 1
}
do_login() {
  info "Se abre el navegador: inicia sesion con la cuenta de Google que te dio de alta el administrador del CRM."
  info "Si el navegador no se abre, copia la URL que imprime cloudflared y pegala en el navegador."
  "$1" access login --quiet "$CRM_URL" || warn "cloudflared access login termino con codigo $?"
}

# ----------------------------------------------------------------------------
# Verificacion contra el CRM
# ----------------------------------------------------------------------------
verify_identity() {
  local cf="$1" jwt status body
  jwt="$(get_token "$cf")" || { VERIFY_CODE=LOGIN_PENDIENTE; VERIFY_MSG="No hay sesion de Cloudflare Access para $CRM_URL. Ejecuta: bash setup.sh --only-login"; return; }
  local hdr=(-H "cf-access-token: $jwt" -H "accept: application/json")
  [[ -n "$ORG_ID" ]] && hdr+=(-H "X-Org-Id: $ORG_ID")
  body="$(curl -sS -o - -w '\n%{http_code}' "${hdr[@]}" "$CRM_URL/api/me" 2>&1)" || { VERIFY_CODE=ERROR_VERIFICACION; VERIFY_MSG="No pude contactar con $CRM_URL: $body"; return; }
  status="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [[ "$status" =~ ^3 ]]; then VERIFY_CODE=LOGIN_PENDIENTE; VERIFY_MSG="Cloudflare Access rechazo la sesion (redireccion a login). Ejecuta: bash setup.sh --only-login"; return; fi
  if [[ "$status" == "403" ]]; then VERIFY_CODE=SIN_PERMISO; VERIFY_MSG="Tu cuenta de Google ha pasado Cloudflare Access pero el CRM no la tiene dada de alta (o esta inactiva). Pide al administrador del CRM que cree tu usuario con ese email."; return; fi
  if [[ "$status" != "200" ]]; then VERIFY_CODE=ERROR_VERIFICACION; VERIFY_MSG="El CRM respondio HTTP $status a /api/me. Cuerpo: $body"; return; fi
  # Resumen legible con node (ya verificado que existe en el flujo completo; en --only-verify se busca igual).
  local node_bin; node_bin="$(command -v node || true)"
  if [[ -z "$node_bin" ]]; then VERIFY_CODE=OK; VERIFY_MSG="$body"; return; fi
  local summary; summary="$(printf '%s' "$body" | "$node_bin" -e '
    const me = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const orgs = me.orgs || [];
    const lines = [`Usuario: ${me.email}`, `Fuente de identidad: ${me.source}`];
    if (orgs.length === 0 && !me.isSuperadmin) { lines.push("El CRM reconoce tu email pero no perteneces a ninguna empresa. Pide al administrador que te asigne a la tuya."); console.log("SIN_EMPRESA"); console.log(lines.join("\n")); process.exit(0); }
    lines.push(`Empresa activa: ${me.activeOrg?.nombre} (id ${me.activeOrg?.id}) con rol '"'"'${me.role}'"'"'`);
    if (orgs.length > 1) { lines.push("Perteneces a VARIAS empresas; para fijar otra por defecto vuelve a ejecutar con --org-id <id>:"); for (const o of orgs) lines.push(`   - id ${o.id}: ${o.nombre} [${o.role}]`); }
    console.log("OK"); console.log(lines.join("\n"));
  ')"
  VERIFY_CODE="${summary%%$'\n'*}"; VERIFY_MSG="${summary#*$'\n'}"
}

# ----------------------------------------------------------------------------
# Modos cortos
# ----------------------------------------------------------------------------
if [[ $ONLY_VERIFY -eq 1 ]]; then
  step "Verificar sesion e identidad"
  cf="$(find_cloudflared)" || fail CLOUDFLARED "No encuentro cloudflared. Ejecuta el setup completo primero."
  verify_identity "$cf"; finish "$VERIFY_CODE" "$VERIFY_MSG"
fi
if [[ $ONLY_LOGIN -eq 1 ]]; then
  step "Login de Cloudflare Access"
  cf="$(find_cloudflared)" || cf="$(ensure_cloudflared)"
  if get_token "$cf" >/dev/null; then ok "Ya hay una sesion valida; no hace falta volver a loguearse."; else do_login "$cf"; fi
  verify_identity "$cf"; finish "$VERIFY_CODE" "$VERIFY_MSG"
fi

# ----------------------------------------------------------------------------
# 1. Node.js
# ----------------------------------------------------------------------------
step "1/6 Node.js (>= 18)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" && "$OS" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
  info "Node.js no esta instalado. Instalando con Homebrew..."
  brew install node || true
  NODE_BIN="$(command -v node || true)"
fi
[[ -n "$NODE_BIN" ]] || fail NODE "Node.js no esta instalado. Instalalo desde https://nodejs.org (version LTS) o con tu gestor de paquetes y vuelve a ejecutar."
NODE_VER="$("$NODE_BIN" --version)"
NODE_MAJOR="${NODE_VER#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" -ge 18 ]] || fail NODE "Node.js $NODE_VER es demasiado antiguo; hace falta 18 o superior."
ok "Node.js $NODE_VER en $NODE_BIN"

# ----------------------------------------------------------------------------
# 2. cloudflared
# ----------------------------------------------------------------------------
step "2/6 cloudflared"
CF="$(ensure_cloudflared)"

# ----------------------------------------------------------------------------
# 3. Copiar el kit
# ----------------------------------------------------------------------------
step "3/6 Copiar el MCP a $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [[ "$(cd "$INSTALL_DIR" && pwd -P)" == "$(cd "$KIT_DIR" && pwd -P)" ]]; then
  info "El script ya se ejecuta desde la carpeta de instalacion; no hay nada que copiar."
else
  for f in server.mjs kit.json setup.ps1 setup.sh instalar.cmd CLAUDE.md LEEME.md; do
    [[ -f "$KIT_DIR/$f" ]] && cp -f "$KIT_DIR/$f" "$INSTALL_DIR/$f"
  done
  if [[ -d "$KIT_DIR/skills" ]]; then rm -rf "$INSTALL_DIR/skills"; cp -R "$KIT_DIR/skills" "$INSTALL_DIR/skills"; fi
fi
SERVER="$INSTALL_DIR/server.mjs"
[[ -f "$SERVER" ]] || fail COPIA "Falta $SERVER. El zip esta incompleto: vuelve a descomprimirlo entero."
"$NODE_BIN" --check "$SERVER" || fail COPIA "server.mjs no compila con Node $NODE_VER"
ok "server.mjs listo en $SERVER"

# ----------------------------------------------------------------------------
# 4. Login de Access
# ----------------------------------------------------------------------------
step "4/6 Sesion de Cloudflare Access (login de Google)"
if [[ $SKIP_LOGIN -eq 1 ]]; then warn "Login omitido (--skip-login): no se comprueba la sesion. Si no la tienes: bash setup.sh --only-login"
elif get_token "$CF" >/dev/null; then ok "Ya existe una sesion valida de Access en este equipo."
else
  do_login "$CF"
  if get_token "$CF" >/dev/null; then ok "Sesion de Access establecida."; else warn "No se obtuvo sesion de Access. Podras repetirlo con: bash setup.sh --only-login"; fi
fi

# ----------------------------------------------------------------------------
# 5. Registrar el MCP
# ----------------------------------------------------------------------------
step "5/6 Registrar el MCP en Claude"
CLAUDE_CLI="$(command -v claude || true)"
if [[ -z "$DESKTOP_CFG" ]]; then
  if [[ "$OS" == "Darwin" ]]; then DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"; else DESKTOP_CFG="$HOME/.config/Claude/claude_desktop_config.json"; fi
fi
DESKTOP_INSTALLED=0; [[ -d "$(dirname "$DESKTOP_CFG")" ]] && DESKTOP_INSTALLED=1
DO_CODE=0; DO_DESKTOP=0
case "$TARGET" in
  auto) [[ -n "$CLAUDE_CLI" ]] && DO_CODE=1; [[ $DESKTOP_INSTALLED -eq 1 ]] && DO_DESKTOP=1;;
  code) DO_CODE=1;; desktop) DO_DESKTOP=1;; both) DO_CODE=1; DO_DESKTOP=1;; none) ;;
  *) fail ARGS "--target debe ser auto|code|desktop|both|none";;
esac
if [[ "$TARGET" == "auto" && $DO_CODE -eq 0 && $DO_DESKTOP -eq 0 ]]; then
  fail REGISTRO "No encuentro ni el CLI 'claude' (Claude Code) ni Claude Desktop. Instala Claude Code (https://claude.com/claude-code) y vuelve a ejecutar."
fi
ENV_ARGS=(-e "CLOUDFLARED_PATH=$CF" -e "TUDESAN_BASE_URL=$CRM_URL")
[[ -n "$ORG_ID" ]] && ENV_ARGS+=(-e "TUDESAN_ORG_ID=$ORG_ID")

if [[ $DO_CODE -eq 1 ]]; then
  [[ -n "$CLAUDE_CLI" ]] || fail REGISTRO "Se pidio registrar en Claude Code pero el CLI 'claude' no esta en el PATH."
  claude mcp remove -s user "$MCP_NAME" >/dev/null 2>&1 || true
  out="$(claude mcp add -s user "$MCP_NAME" "${ENV_ARGS[@]}" -- "$NODE_BIN" "$SERVER" 2>&1)" || fail REGISTRO "claude mcp add fallo: $out"
  ok "Claude Code: MCP '$MCP_NAME' registrado (scope user, disponible en todos tus proyectos)."
fi
if [[ $DO_DESKTOP -eq 1 ]]; then
  mkdir -p "$(dirname "$DESKTOP_CFG")"
  [[ -f "$DESKTOP_CFG" ]] && cp -f "$DESKTOP_CFG" "$DESKTOP_CFG.bak"
  CFG_PATH="$DESKTOP_CFG" MCP_NAME="$MCP_NAME" NODE_BIN="$NODE_BIN" SERVER="$SERVER" CF="$CF" CRM_URL="$CRM_URL" ORG_ID="$ORG_ID" "$NODE_BIN" -e '
    const fs = require("fs"); const p = process.env.CFG_PATH;
    let cfg = {}; try { const raw = fs.readFileSync(p, "utf8"); if (raw.trim()) cfg = JSON.parse(raw); } catch {}
    cfg.mcpServers = cfg.mcpServers || {};
    const env = { CLOUDFLARED_PATH: process.env.CF, TUDESAN_BASE_URL: process.env.CRM_URL };
    if (process.env.ORG_ID) env.TUDESAN_ORG_ID = process.env.ORG_ID;
    cfg.mcpServers[process.env.MCP_NAME] = { command: process.env.NODE_BIN, args: [process.env.SERVER], env };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' || fail REGISTRO "No pude escribir $DESKTOP_CFG"
  ok "Claude Desktop: MCP '$MCP_NAME' escrito en $DESKTOP_CFG (copia previa en .bak)."
fi

# ----------------------------------------------------------------------------
# 6. Skills
# ----------------------------------------------------------------------------
step "6/6 Skills de Claude (expediente, CEE, tasacion)"
if [[ $SKIP_SKILLS -eq 1 ]]; then info "Omitido (--skip-skills)."
else
  mkdir -p "$HOME/.claude/skills"
  for name in $SKILLS; do
    src="$INSTALL_DIR/skills/$name"
    [[ -d "$src" ]] || { warn "Skill '$name' no viene en el kit; se omite."; continue; }
    rm -rf "$HOME/.claude/skills/$name"; cp -R "$src" "$HOME/.claude/skills/$name"
    ok "skill '$name' -> $HOME/.claude/skills/$name"
  done
fi

# ----------------------------------------------------------------------------
# Verificacion final
# ----------------------------------------------------------------------------
step "Verificacion"
printf '\nInstalado en:   %s\nServidor MCP:   %s %s\ncloudflared:    %s\nCRM:            %s\n' "$INSTALL_DIR" "$NODE_BIN" "$SERVER" "$CF" "$CRM_URL"
echo 'Siguiente paso: REINICIA Claude Code / Claude Desktop para que cargue el MCP y pide "usa la tool whoami del CRM".'
[[ $SKIP_VERIFY -eq 1 ]] && finish OK_SIN_VERIFICAR "Verificacion omitida (--skip-verify)."
verify_identity "$CF"; finish "$VERIFY_CODE" "$VERIFY_MSG"
