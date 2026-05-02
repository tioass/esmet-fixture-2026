#!/bin/bash
# Servidor estático para iterar localmente.
# Uso: ./dev.sh   →   abrir http://localhost:8765/dev.html
cd "$(dirname "$0")"
PORT=${1:-8765}
echo ""
echo "  ESMET Fixture dev"
echo "  → http://localhost:$PORT/dev.html"
echo ""
python3 -m http.server "$PORT"
