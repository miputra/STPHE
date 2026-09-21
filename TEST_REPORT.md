# Prompt Folders 3.2.1 test report

Tested 2026-09-21 against the existing http://127.0.0.1:8000/ instance, SillyTavern 1.18.0, using its default 12-prompt preset. SillyTavern was not restarted. The follow-up below sent generation requests to a temporary local API fixture.

## Results

- 35 automated regression tests passed. Run `node tests/regression.test.mjs` from this directory. Tests use Node's test runner in-process and isolated fixtures, with no added dependencies or user-data mutations.
- All plugin JavaScript files passed `node --check`.
- `git diff --check` passed.
- Live mute/restore of the 12-prompt folder completed in approximately 293/289 ms including browser-tool interaction overhead. The native list reached zero active prompts when muted, then restored its original 11-on/1-off state. The panel reported `aria-busy=false` on completion. These are observations for this preset, not a performance guarantee for larger contexts.
- Temporary test folders, groups, and presets were removed. Original prompt content and intended states were preserved.

## Feature coverage

| Feature | Verification |
| --- | --- |
| Folder mute/restore, nested independent mutes, mixed states | Live root mute/restore; fixture tests for nested and mixed cases |
| Force all on/off and changes inside muted folders | Regression tests of intended and native states |
| Batch loading, no-op, overlapping changes, error cleanup | Deferred native-operation fixtures; live completion checks |
| Folder create, rename, move, delete, prompt assignment | Live create/rename/delete; hierarchy and assignment fixtures |
| Folder dialogs and native prompt editor | Live native input dialog and visible editor; no user content edited |
| New prompt, unique naming, rollback | Isolated native-model fixtures |
| Unlist and permanent deletion | Isolated fixtures checking definitions and all order references; user prompts were not deleted |
| Multi-selection, drag ordering, implied descendants, native order | Regression tests, including preservation of enabled flags and extra native fields |
| Search and clearing search | Live checks and regression test; fixed imported-binding assignment error |
| Individual preview and full enabled-prompt preview | Live checks |
| Panel grow/shrink, side switching, minimize/restore | Live checks |
| XML, word/case, regex, invalid regex, scopes and exclusions | Matching fixtures; live word/no-match and chat-condition checks |
| Manual and chat presets | Live save/run/remove and group assignment; lock/group gating checks |
| Auto rules, ordering, master/group gating, conditions | Live manual rule and group evaluation; serial-order and condition fixtures |
| Chat/send/swipe/edit/delete/change and finish/abort event hooks | Simulated event registration and gating tests |
| Filter groups: nested creation, rename, move, mute, collapse, delete | Live checks plus fixtures; group drag/drop and cycle rejection tested with events |
| Legacy settings migration | Regression tests |
| Full and single-prompt export, append/import/restore, conflicts | Serialization and isolated data fixtures; includes filter/group backup preservation |
| Native list observation | Corrected early return that skipped periodic fallback; syntax and live refresh checks |

## Custom OpenAI-compatible integration follow-up

Used Chat Completion Source **Custom (OpenAI-compatible)**, model `pf-integration-test`, and a loopback endpoint on port 54256 in a temporary chat. This was a real SillyTavern HTTP request/response pipeline with deterministic mock responses, not a real LLM. No API credentials were used. The rule matched `PF_TRIGGER` in the last two messages and controlled Main Prompt.

| Case | Observed result |
| --- | --- |
| Streaming response with trigger | Main Prompt enabled after the response |
| Streaming response without trigger | Main Prompt disabled after the response |
| Non-streaming response | Response rendered and rule state updated |
| Abort during held SSE response | HTTP stream aborted; partial-response trigger evaluated; no stuck loading |
| Intentional HTTP 500 | Generation stopped; no stuck loading or abort control |
| Rule group off/on | Muted group blocked the rule; enabling it applied the trigger |
| Pre-send via Send button | Initially reproduced missing Main Prompt in outgoing payload; passed after fix |
| Pre-send via Enter | Started with Main Prompt off; new trigger enabled it and outgoing payload included it |
| Concurrent filter pass | Regression tests verify pre-send waits for the active pass and rechecks current chat |

The fix replaces the asynchronous click trigger with an awaited `MESSAGE_SENT` listener. SillyTavern emits this after inserting the user's message and awaits it before assembling the completion request. No fixed delay is added.

To run the fixture: `node tests/openai-mock.mjs`. It prints a loopback URL on an available port; use the model above. `PF_TEST_ON` returns the trigger, `PF_TEST_OFF` omits it, `PF_TEST_ABORT` holds a streaming response, and `PF_TEST_ERROR` returns HTTP 500. `/test/status` exposes request flags without storing message bodies or credentials. Stop it after testing. Test rules/groups were removed and connection fields, streaming, pre-send preference, and prompt states restored.

## Limits

Real model output, remote-provider behavior, and large character-chat context calculation were not tested. Destructive flows were tested with isolated data rather than user prompts. File-picker/download dialogs, touch dragging, and every viewport size were not exhaustively exercised. The suite covers the feature families above; it does not prove every possible interaction or third-party extension combination.

The batch integration uses this SillyTavern version's Prompt Manager methods. Unsupported versions show a clear error instead of pretending an operation completed.
