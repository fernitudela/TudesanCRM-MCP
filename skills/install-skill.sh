#!/usr/bin/env bash
# Instala la skill "expediente-hipotecario" en tu Claude Code/Desktop personal.
# Copia skills/expediente-hipotecario/ -> ~/.claude/skills/expediente-hipotecario/
#
# Uso (macOS/Linux), desde la raíz del repo o desde skills/:
#   bash ./skills/install-skill.sh
#   bash ./skills/install-skill.sh --force   # sobrescribe si ya existe
set -euo pipefail

force=0
[[ "${1:-}" == "--force" || "${1:-}" == "-f" ]] && force=1

src_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$src_root/expediente-hipotecario"
[[ -d "$src" ]] || { echo "No encuentro la skill en '$src'. Ejecuta el script desde el repo TudesanCRM-MCP." >&2; exit 1; }

dst_parent="$HOME/.claude/skills"
dst="$dst_parent/expediente-hipotecario"

if [[ -d "$dst" ]]; then
  if [[ "$force" -ne 1 ]]; then
    read -r -p "Ya existe '$dst'. ¿Sobrescribir? (s/N) " ans
    case "$ans" in s|S|y|Y) ;; *) echo "Cancelado."; exit 0;; esac
  fi
  rm -rf "$dst"
fi

mkdir -p "$dst_parent"
cp -R "$src" "$dst"

echo "✓ Skill instalada en: $dst"
echo "Reinicia Claude Code/Desktop para que la cargue."
