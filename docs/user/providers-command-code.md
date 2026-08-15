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

## Manual compaction

For a Command Code thread, the composer slash menu shows **Provider → /compact**. Selecting it sends
the native `compact_conversation` tool and reports the result. This runs the same compaction that
Command Code uses to free context during a long conversation.

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

Command Code supports normal text turns, streamed responses, tool and subagent activity,
cancellation, explicit session resume, model selection, and T3 Code's generated thread titles,
branch names, commit messages, and pull request text. Responses stream in as they arrive, so
Command Code's prose appears between the tool rows it sits between rather than all at once at the
end of the turn.

### Sending a message while a turn is running

Command Code cannot take a new instruction into a turn that is already running. Sending one anyway
is fine: T3 Code holds the message and runs it as its own turn as soon as the current one finishes,
in the order you sent them. To change course immediately, stop the turn first.

### Startup recovery

If a new Command Code headless process does not start promptly, T3 Code ends that process and
retries it once automatically. Normal turns are unchanged. If the retry also fails, the thread is
ready for another message and the error includes any safe diagnostic output the CLI provided.

## Usage reporting

Command Code usage (tokens and cost) is reported on the **Usage** page. T3 Code scans Command
Code's own session transcripts, one set per configured Command Code environment, so usage covers
turns run outside T3 Code too. Cost is taken from the cost Command Code reports per message; when a model has no
reported cost, T3 Code prices it against the same rate table it uses for the other providers.

The Early Access adapter runs Command Code in headless JSON mode. It does not currently include:

- image or file attachments;
- interactive approval or question callbacks;
- steering an active turn (messages sent mid-turn are queued instead);
- Command Code's chain-of-thought in the chat;
- `/compact-mode` UI emulation (Compact Mode is already available through the traits menu);
- Shift+Tab mode emulation;
- arbitrary provider launch arguments;
- a new context meter on mobile; or
- rolling back Command Code's own session history when a T3 Code checkpoint is restored.

T3 Code still restores the workspace checkpoint when requested, but a follow-up Command Code turn
starts from the provider history it already has.
