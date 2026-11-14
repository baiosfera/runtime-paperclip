#!/usr/bin/env bash
# ==============================================================================
# Paperclip Autonomous Runtime Entrypoint
# ==============================================================================
set -e

CONFIG_DIR="/mnt/localstorage/paperclip/instances/default"
CONFIG_FILE="${CONFIG_DIR}/config.json"

echo "• [Paperclip] Iniciando verificación de configuración declarativa..."

# 1. Normalizar DATABASE_URL hacia la base de datos 'paperclip'
if [[ "${DATABASE_URL}" == *"/db" ]]; then
    export DATABASE_URL="${DATABASE_URL%/db}/paperclip"
fi

# 2. Seed or reconcile config.json (syncing DATABASE_URL and publicBaseUrl across rebuilds)
mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/logs" "/mnt/localstorage/paperclip/storage" 2>/dev/null || true

normalize_public_url() {
    local val="${1:-}"
    if [[ -z "$val" || "$val" == *'${'* ]]; then
        return 1
    fi
    while [[ "$val" == https://https://* || "$val" == http://http://* || "$val" == https://http://* ]]; do
        val="${val#*://}"
    done
    if [[ "$val" != http://* && "$val" != https://* ]]; then
        val="https://${val}"
    fi
    printf '%s' "${val%/}"
}

PUBLIC_BASE_URL=""
for candidate in "${zeropsSubdomain:-}" "${PAPERCLIP_AUTH_PUBLIC_BASE_URL:-}" "${BETTER_AUTH_URL:-}"; do
    if PUBLIC_BASE_URL=$(normalize_public_url "$candidate"); then
        break
    fi
done
if [[ -z "$PUBLIC_BASE_URL" ]]; then
    PUBLIC_BASE_URL="http://paperclip:${PORT:-3100}"
fi
export PAPERCLIP_AUTH_PUBLIC_BASE_URL="$PUBLIC_BASE_URL"
export BETTER_AUTH_URL="$PUBLIC_BASE_URL"
export BETTER_AUTH_TRUSTED_ORIGINS="$PUBLIC_BASE_URL"
node -e '
  const fs = require("fs");
  const cfgPath = process.argv[1];
  const dbUrl = process.argv[2];
  const publicUrl = process.argv[3];
  const logDir = process.argv[4];
  const now = new Date().toISOString();
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch (_) { cfg = {}; }
  }
  cfg.$meta = { version: 1, updatedAt: now, source: "configure" };
  cfg.database = { ...(cfg.database || {}), mode: "postgres", connectionString: dbUrl };
  cfg.logging = cfg.logging || { mode: "file", logDir };
  cfg.server = {
    deploymentMode: process.env.PAPERCLIP_DEPLOYMENT_MODE || "authenticated",
    exposure: process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE || "public",
    bind: process.env.PAPERCLIP_BIND || "lan",
    host: process.env.HOST || "0.0.0.0",
    port: parseInt(process.env.PORT || "3100", 10),
  };
  cfg.auth = { ...(cfg.auth || {}), baseUrlMode: "explicit", publicBaseUrl: publicUrl, disableSignUp: false };
  cfg.telemetry = { enabled: false };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
' "$CONFIG_FILE" "$DATABASE_URL" "$PUBLIC_BASE_URL" "${CONFIG_DIR}/logs"

# 3. Garantizar symlink canónico ~/.paperclip -> /mnt/localstorage/paperclip en runtime
mkdir -p "$HOME"
ln -sfn /mnt/localstorage/paperclip "$HOME/.paperclip"

# 4. Auto-bootstrap idempotente (admin instance_admin, company y Org Chart inicial en background)
if [ -f "packages/db/dist/bootstrap-org.mjs" ]; then
    node packages/db/dist/bootstrap-org.mjs &
fi

# 5. Iniciar servidor Node.js
echo "• [Paperclip] Ejecutando runtime index.mjs en puerto ${PORT:-3100}..."
exec node server/dist-runtime/index.mjs
