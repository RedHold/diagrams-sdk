#!/usr/bin/env bash
# Refresh the vendored OpenAPI spec from a running API, then let the drift-guard
# tests tell you if the SDKs need new methods. Commit the result.
#   BASE=https://api.diagrams.so ./scripts/sync-spec.sh
set -euo pipefail
BASE="${BASE:-https://api.diagrams.so}"
curl -fsSL "$BASE/api/v2/openapi.json" -o spec/openapi-v2.json
echo "updated spec/openapi-v2.json from $BASE — now run the tests:"
echo "  (cd python && pytest -q) && (cd typescript && npm test)"
