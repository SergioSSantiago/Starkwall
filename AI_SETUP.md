# AI Setup

Use this context to improve AI-assisted development quality in Starkwall.

## Cursor Rules

Project rules are stored in:

- `.cursor/rules/starkwall-core.mdc`
- `.cursor/rules/starkwall-starkzap-product.mdc`

They are configured with `alwaysApply: true`.

## Recommended Indexed Docs

In Cursor: **Settings -> Features -> Docs -> Add new doc**

- `https://docs.starkzap.com/llms-full.txt`
- `https://docs.starknet.io/llms.txt`
- `https://garaga.gitbook.io/garaga`
- Local index file: `docs/STARKNET_DOCS_INDEX.md`

## MCP Servers

Project MCP config is stored at:

- `.cursor/mcp.json`

Included server:

- `garaga-docs` -> `https://garaga.gitbook.io/garaga/~gitbook/mcp`

If Cursor doesn't pick it up automatically:

1. Open Cursor MCP settings.
2. Reload project MCP servers.
3. Restart Cursor window.

## Agent Context Files

- `AGENTS.md` (project operational context)
- `docs/STARKNET_DOCS_INDEX.md` (Starknet/Starkzap reference index)
- `.cursor/skills/garaga-mcp/SKILL.md` (Garaga MCP + CLI workflow)

## Useful Commands

- Build frontend: `cd client && npm run build`
- Start frontend dev: `cd client && npm run dev`
