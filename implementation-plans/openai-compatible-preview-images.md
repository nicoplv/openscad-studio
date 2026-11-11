# Preview images for OpenAI-compatible vision servers

## Goal

Let the copilot inspect previews without sending screenshots as tokenized text or accumulating screenshots in the model's conversation history.

## Approach

- Keep original captures in the transcript and record whether the capture is 2D or 3D.
- Prepare each OpenAI-compatible request with text-only screenshot tool replies and at most one image from the previous step.
- Cap the outgoing image at 800 pixels on the longest edge. Use JPEG at quality 0.82 for opaque 3D previews and PNG for 2D or transparent previews.

## Affected Areas

Built-in copilot tool capture, OpenAI-compatible request preparation, and shared image sizing utilities.

## Checklist

- [x] Add screenshot metadata, image preparation, and provider request handling.
- [x] Verify the actual SDK request format, image preparation, and types with focused checks.
- [ ] Verify the star and heart workflow against the configured vision server and inspect the browser requests.
