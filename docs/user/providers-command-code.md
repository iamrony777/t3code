# Command Code

T3 Code can run the Command Code CLI as an Early Access provider. It uses the account and model
provider credentials already configured in Command Code; T3 Code does not include a Command Code
account or pay for model usage.

## Install and sign in

Install Command Code on the machine running the T3 Code server:

```bash
npm install -g command-code
command-code login
```

T3 Code uses the cross-platform `command-code` binary rather than the shorter `cmd` alias. If the
binary is not on the server's `PATH`, set its full path in **Settings** → **Command Code** →
**Binary path**.

The provider status card shows the installed CLI version and authentication state. Models are read
from the CLI after authentication; custom model entries from T3 Code settings remain available as
fallback choices.

## Current support

Command Code supports normal text turns, streamed reasoning and responses, tool and subagent
activity, cancellation, explicit session resume, model selection, and T3 Code's generated thread
titles, branch names, commit messages, and pull request text.

The Early Access adapter runs Command Code in headless JSON mode. It does not currently support:

- image or file attachments;
- interactive approval or question callbacks;
- steering an active turn; or
- rolling back Command Code's own session history when a T3 Code checkpoint is restored.

T3 Code still restores the workspace checkpoint when requested, but a follow-up Command Code turn
starts from the provider history it already has.

## Permission modes

Because headless Command Code cannot pause for a T3 Code approval response, **Supervised** uses
Command Code's `dont-ask` mode: pre-approved operations run and anything that would prompt is denied.
**Auto-accept edits** and **Auto** use Command Code's `auto-accept` mode. **Full access** uses
`--yolo`, and plan interaction mode uses read-only `--plan`.

Use **Full access** only in a workspace or worktree where unattended commands and edits are
appropriate.
