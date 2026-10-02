---
name: a24-evals-overview
description: Build and show the eval overview page (every eval case in packages/evals with its messages, attachments, pass conditions and the test household), locally and as a shareable claude.ai artifact link. Use when the user asks to see, open, share or refresh the evals overview, the eval cases page, or "what do the evals test".
---

# Show the evals overview

The page is generated from the files on disk by `packages/evals/scripts/overview.ts`; the output `packages/evals/overview.html` is gitignored, so always rebuild before showing it.

## Build

From the repo root:

```sh
npm run evals:overview -w @accountant24/evals
```

It reads every `packages/evals/cases/*/case.json`, the attachments, and the `household` fixture (hledger and pdftotext must be on PATH) and prints the case count. If the cases or the fixture were edited through their generators (`packages/evals/scripts/household/`), run `npm run evals:generate -w @accountant24/evals` instead: it regenerates the ledger, the cases and the documents, then the page.

## Show it

- **On this Mac:** `open packages/evals/overview.html`.
- **As a link (any device):** publish the built file with the Artifact tool to the existing artifact, so the link stays the same: `url` = `https://claude.ai/artifact/YHz6uUiUtczwtgZDKJo8CH`, `file_path` = `packages/evals/overview.html`. It updates in place; read it first with `action: "read"` if the tool asks. The artifact is private to Volo unless shared from its Share menu.

Hand over the link plus a one-line summary (case count, anything that changed since the last version). Don't list the cases in chat; the page is where they live.
