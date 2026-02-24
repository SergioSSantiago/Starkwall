---
name: dojo-starknet-dev
description: Helps with Dojo and Starknet development using Cairo—ECS models and systems, Sozo/Katana/Torii tooling, Scarb. Use when building or debugging Dojo games, Starknet contracts, or when the user mentions Dojo, Sozo, Katana, Torii, or Cairo.
---

# Dojo & Starknet Development

## Toolchain

- **Scarb**: Cairo package manager and compiler. Match `cairo-version` in Scarb.toml (e.g. `2.12.2`).
- **Sozo**: Dojo CLI — build, migrate (deploy), execute. Use same major/alpha as `dojo` dependency.
- **Katana**: Local Starknet sequencer for dev. Run with a config (e.g. `katana --config katana.toml`).
- **Torii**: Indexer; exposes GraphQL/gRPC for world state. Run after migration with config pointing at `world_address`.

Version alignment: Pin Scarb, Sozo, Katana (and optionally Torii) in `.tool-versions` (asdf) or docs so all use compatible versions.

## Project layout (typical)

```
contracts/
├── Scarb.toml
├── dojo_dev.toml    # world name, namespace, env (rpc, account, world_address), writers
├── katana.toml
├── torii.toml       # or torii_dev.toml — world_address, server
├── src/
│   ├── lib.cairo    # pub mod models; pub mod systems { pub mod actions; }
│   ├── models.cairo # Dojo models (components)
│   └── systems/
│       └── actions.cairo # Dojo contract (systems)
```

## Dojo models (components)

- Use `#[dojo::model]` on a struct. Mark the entity key with `#[key]` (e.g. `player: ContractAddress`).
- Derive `Copy, Drop, Serde` (and `Default` if needed). Use `Introspect` when required by the framework.
- Keep model logic in impls (e.g. `PositionImpl` with `apply_direction`).

```cairo
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct Position {
    #[key]
    pub player: ContractAddress,
    pub x: u32,
    pub y: u32,
}
```

## Dojo systems (contract)

- Mark the system module with `#[dojo::contract]`.
- Implement the external interface with `#[abi(embed_v0)]` and `impl ... of IActions<ContractState>`.
- Access the world via `self.world_default()` (or `self.world(@"namespace")`). Use `world.read_model(key)` and `world.write_model(@model)`.
- Get caller: `starknet::get_caller_address()`.
- In `dojo_dev.toml`, list system contract names under `[writers]` for the namespace (e.g. `"di" = ["di-actions"]`).

## Scarb.toml

- Dependencies: `dojo` and `dojo_macros` from git (same tag), `starknet` matching cairo-version.
- For Dojo world contract: `[[target.starknet-contract]]` with `build-external-contracts = ["dojo::world::world_contract::world"]`.
- Scripts: e.g. `migrate = "sozo build && sozo migrate"`, `spawn = "sozo execute dojo_starter-actions spawn --wait"`.

## Common commands

```bash
# Terminal 1 — sequencer
katana --config katana.toml

# Terminal 2 — build and deploy
cd contracts && sozo build && sozo migrate

# Terminal 3 — indexer
torii --config torii_dev.toml

# Run Scarb script
scarb run migrate
scarb run spawn
```

Execute a system: `sozo execute <contract-name> <entrypoint> [args] --wait`.

## Starknet / Cairo notes

- Use `ContractAddress` and `starknet::get_caller_address()` for auth and keys.
- External calls: use the interface trait and a dispatcher (e.g. `IVrfProviderDispatcher { contract_address }`).
- Prefer `saturating_sub` / `saturating_add` for unsigned math to avoid panics.
- Interfaces: `#[starknet::interface]` with `trait IName<T> { fn ...(ref self: T); }`; implement with `impl ImplName of IName<ContractState>`.

## Debugging

- Ensure Katana is running and `dojo_dev.toml` `rpc_url` matches (e.g. `http://localhost:5050/`).
- After changing models or world layout, run `sozo build && sozo migrate` and restart Torii if used.
- Check `[writers]` in `dojo_dev.toml` so the system contract is allowed to write to the namespace.
