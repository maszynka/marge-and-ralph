#!/bin/bash
# marge_and_ralph — AI Agent Orchestrator
# Usage: ./marge.sh [command] [options]
#
# Auto-detects mode:
#   prd.json → ralph-compatible loop
#   project.json → full orchestration
#
# See ./marge.sh --help for details.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/src/cli.ts" "$@"
