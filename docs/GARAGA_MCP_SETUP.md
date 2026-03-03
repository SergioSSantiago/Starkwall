# Garaga MCP Setup

This project includes MCP wiring for Garaga docs and a dedicated skill for Garaga workflows.

## What Was Added

- MCP config: `.cursor/mcp.json`
- Skill: `.cursor/skills/garaga-mcp/SKILL.md`

## Verify MCP Is Loaded

1. Open Cursor MCP settings.
2. Confirm server `garaga-docs` appears.
3. If missing, reload MCP servers or restart Cursor.

## Verify Skill Is Available

1. Ask the agent about Garaga verifier generation.
2. Confirm it follows the `garaga-mcp` skill workflow:
   - `garaga gen`
   - redeploy requirement when verifier changes
   - `garaga verify-onchain` usage

## Operational Notes

- MCP helps with documentation lookup.
- Execution should still follow local project scripts where present.
- Verifier regeneration implies redeploy/migrate before production claims.
