# Peel Product Source Archive

This directory preserves the original product materials exactly as they were supplied. These files are evidence, not generated summaries.

## Preserved sources

| Source | Purpose | SHA-256 |
|---|---|---|
| `spatial-thread-workspace-prd-v0-original.md` | Original Spatial Thread Workspace PRD | `e86e8d4d4af6b83e22e2377b1f45ab5def0962f26ebce920be901c28ac9226b6` |
| `peel-demo-v0-original.html` | Original self-contained interactive Demo | `0501a3f17a46d50c4d1bdbd47eb954e9d0353f6a332b81222e8ec33289c89e16` |

## Preservation contract

- Do not edit these two `*-original` files in place.
- A revised PRD or Demo must be added as a new versioned source, so Git history is not the only place where the earlier product artifact can be found.
- The Demo HTML remains one self-contained file so it can be opened and exercised directly.
- VibeHub Context under `.vibehub/rooms/product/` is a structured retrieval and decision layer. It does not replace these source artifacts.
- When the sources and a later explicit human decision disagree, preserve both and treat the later human decision as the active product direction.

## Why both layers exist

The source archive prevents information loss. VibeHub Context makes the current product model, release boundary, and rationale easy to retrieve during planning and implementation. Future work should consult both when fidelity matters.
