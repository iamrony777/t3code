# Command Code

T3 Code can run the Command Code CLI as an Early Access provider. Command Code owns the
subscription, authentication, and model-provider credentials. T3 Code does not include a Command
Code account or pay for model usage.

## Install and sign in

Install Command Code on the machine running the T3 Code server:

```bash
npm install -g command-code
command-code login
```

T3 Code uses the cross-platform `command-code` binary rather than the shorter `cmd` alias. If the
binary is not on the server's `PATH`, set its full path in **Settings** → **Command Code** →
**Binary path**.

The provider status card shows the installed CLI version and authentication state. T3 Code reads
the installed models from the CLI after authentication. Custom model entries from T3 Code settings
remain available as fallback choices.

## Models and context usage

T3 Code enriches the CLI model list with exact matches from Command Code's public model endpoint.
This adds model-specific context limits and reasoning choices without replacing the CLI model
names used to start a turn.

The enriched model data is cached for 24 hours. If Command Code is offline after the cache expires,
T3 Code keeps using the stale cached data while the installed CLI models remain available.

The context meter separates two measurements:

- **Context Window** reads the latest active usage from Command Code's conversation transcript. It
  shows a percentage only when T3 Code knows the exact context limit for the selected model.
- **Total processed** adds the usage reported across completed turns. It can be higher than the
  active context because Command Code may compact or reuse the conversation.

Missing transcript or model data produces a partial meter instead of an estimated percentage.

## Reasoning effort

Reasoning choices depend on the selected model. T3 Code discovers the supported choices from the
installed Command Code CLI and shows **Reasoning** only when that model supports it.

Choose **Default** to let Command Code decide. T3 Code sends no `--effort` argument for that choice.
Other choices send the selected effort for the current thread.

## Compact Mode and Taste Learning

Use the traits menu beside the model picker to change Command Code's native settings:

| Control        | Choices      | Command Code setting                        |
| -------------- | ------------ | ------------------------------------------- |
| Compact Mode   | Normal, Fast | `compact-mode=default`, `compact-mode=fast` |
| Taste Learning | On, Off      | Command Code user-level Taste setting       |

These controls are global. A change applies to the selected Command Code environment outside the
current thread and is visible to the Command Code CLI. If Taste Learning is absent from the native
settings file, T3 Code shows it as **On**.

T3 Code runs Command Code's native setting command, reads the setting back, and updates the control
only after the write is verified. Refresh the provider status to pick up changes made directly with
the CLI.

## Interaction and permission modes

T3 Code remains the authority for interaction mode and runtime access. It maps the existing T3
controls to Command Code as follows:

| T3 Code control                | Command Code behavior        |
| ------------------------------ | ---------------------------- |
| Supervised (approval required) | `--permission-mode dont-ask` |
| Auto-accept edits or Auto      | `--auto-accept`              |
| Full access                    | `--yolo`                     |
| Legacy Plan mode               | `--plan`                     |

Legacy Plan mode remains opt-in through T3 Code's existing legacy setting. T3 Code does not enable
or replace that control. Use **Full access** only in a workspace or worktree where unattended
commands and edits are appropriate.

### Interactive approvals and questions

T3 Code does not yet bridge Command Code's interactive approval prompts or `ask_user_question`
selections. Command Code runs in print mode, so **Approval required** denies an action when it would
need to pause for approval.

For a question with choices, Command Code print mode can continue with its fallback or first option
instead of showing the choices in T3 Code. Do not rely on interactive choice prompts until this
bridge is supported.

## Current support

Command Code supports normal text turns, streamed reasoning and responses, tool and subagent
activity, cancellation, explicit session resume, model selection, and T3 Code's generated thread
titles, branch names, commit messages, and pull request text.

The Early Access adapter runs Command Code in headless JSON mode. It does not currently include:

- image or file attachments;
- interactive approval or question callbacks;
- steering an active turn;
- manual `/compact` or `/compact-mode` UI emulation;
- Shift+Tab mode emulation;
- arbitrary provider launch arguments;
- a new context meter on mobile; or
- rolling back Command Code's own session history when a T3 Code checkpoint is restored.

T3 Code still restores the workspace checkpoint when requested, but a follow-up Command Code turn
starts from the provider history it already has.
