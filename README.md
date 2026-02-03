# marge_and_ralph

Standalone AI agent orchestrator — combines Ralph's simple loop with GSD's full orchestration.

## Overview

**marge_and_ralph** is a Bun + TypeScript orchestrator that:

- Works with multiple CLI tools: `claude`, `amp`, `codex`, `gemini`
- Auto-detects mode based on project file:
  - `prd.json` → Ralph mode (iterative user story loop)
  - `project.json` → Full orchestration (plan → wave execute → verify → gap closure)
- Uses HTML-comment signals for agent ↔ orchestrator communication
- Runs as a standalone process — no Claude Code slash commands needed

## Requirements

- [Bun](https://bun.sh/) runtime
- One of: `claude`, `amp`, `codex`, or `gemini` CLI tools installed

## Quick Start

### Ralph Mode (Simple Loop)

1. Create `prd.json` (see `prd.json.example`):
   ```json
   {
     "project": "MyApp",
     "branchName": "ralph/feature-name",
     "userStories": [
       { "id": "US-001", "title": "Add login", "passes": false, "priority": 1 }
     ]
   }
   ```

2. Run:
   ```bash
   ./marge.sh --tool claude 20  # 20 iterations
   ```

### Full Orchestration Mode (Coming Soon)

1. Create `project.json`:
   ```json
   {
     "project": "MyApp",
     "phases": [
       { "id": "01", "name": "auth", "goal": "User can register and login" }
     ]
   }
   ```

2. Run:
   ```bash
   ./marge.sh plan --phase 1
   ./marge.sh execute --phase 1
   ./marge.sh verify --phase 1
   ```

## CLI Reference

```bash
# Auto-detect mode
./marge.sh                              # prd.json or project.json

# Ralph-compatible
./marge.sh --tool claude 20             # 20 iterations with Claude
./marge.sh --tool amp                   # use Amp

# Full orchestration (Phase 3+)
./marge.sh init                         # interactive project setup
./marge.sh plan [--phase N]             # plan a phase
./marge.sh execute [--phase N]          # execute (waves + verify)
./marge.sh verify [--phase N]           # verify phase goal
./marge.sh status                       # show progress
./marge.sh debug "description"          # systematic debugging
./marge.sh resume                       # restore session

# Options
--tool <name>        Agent tool: claude, amp, codex, gemini
--model <id>         Model override
--phase <N>          Target phase
--no-research        Skip research phase
--no-verify          Skip verification
--gaps-only          Execute only gap-closure plans
```

## Signal Protocol

Agents communicate with the orchestrator via HTML-comment signals in stdout:

```markdown
<!-- SIGNAL:TASK_COMPLETE task="01" commit="abc123" -->
Implemented user authentication
<!-- /SIGNAL -->

<!-- SIGNAL:CHECKPOINT type="decision" -->
Choose caching strategy:
A) Redis — persistent
B) In-memory — simpler
<!-- /SIGNAL -->

<!-- SIGNAL:COMPLETE -->
All tasks done.
<!-- /SIGNAL -->
```

See `src/agents/signals.ts` for all signal types.

## Project Structure

```
marge_and_ralph/
├── src/
│   ├── cli.ts              # Entry point
│   ├── ralph-mode.ts       # Ralph-compatible loop
│   ├── agents/
│   │   ├── spawn.ts        # Agent process spawning
│   │   ├── signals.ts      # Signal protocol
│   │   ├── monitor.ts      # Real-time output monitoring
│   │   └── adapters/       # Tool-specific adapters
│   ├── planning/           # (Phase 3) Planning system
│   ├── execution/          # (Phase 4) Wave execution
│   ├── verification/       # (Phase 5) Goal verification
│   ├── state/              # (Phase 6) Session management
│   └── prompts/            # Agent prompt templates
├── marge.sh                # Shell wrapper
└── package.json
```

## Development Status

- [x] Phase 1: Skeleton + Ralph parity
- [ ] Phase 2: Signal protocol + real-time monitoring
- [ ] Phase 3: Planning system
- [ ] Phase 4: Wave execution + checkpoints
- [ ] Phase 5: Verification + gap closure
- [ ] Phase 6: Session management + polish

## License

Apache 2.0 — see LICENSE
