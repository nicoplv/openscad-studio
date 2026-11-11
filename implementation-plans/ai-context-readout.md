# AI context readout

## Goal

Show the latest request's input tokens and the configured server's active context limit beside the model dropdown in the AI panel.

## Approach

- Use the exact input count reported by each model step and by llama.cpp context overflow errors.
- Read the active limit from the configured server's model properties when available. Display the values the server provides.
- Reset request usage when the model or conversation changes, and keep the readout scoped to OpenAI-compatible providers.

## Checklist

- [x] Wire the readout beside the model dropdown.
- [x] Verify server metadata, request usage, and overflow with focused checks.

The focused agent and AI panel tests, UI type check, and lint passed. Live browser verification is left to the user.
