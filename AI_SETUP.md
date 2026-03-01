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
- Local index file: `docs/STARKNET_DOCS_INDEX.md`

## Agent Context Files

- `AGENTS.md` (project operational context)
- `docs/STARKNET_DOCS_INDEX.md` (Starknet/Starkzap reference index)

## Useful Commands

- Build frontend: `cd client && npm run build`
- Start frontend dev: `cd client && npm run dev`
