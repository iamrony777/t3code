# Shared project memory

Different agent harnesses keep their own persistent memory. When you switch
harnesses in T3 Code, knowledge you gave one agent — how to reach the production
database, conventions you care about — is normally invisible to the others,
because each harness only knows where its own memory lives.

T3 Code fixes this by telling every agent where the other harnesses' memory for
**this project** lives. Memory sharing is per project: the sources listed for a
thread are the ones that belong to the project that thread is working on.

## How it works

At the start of every thread, T3 Code shows the agent a short list of the memory
locations recorded for that project and when each was last updated. The agent
reads what it needs, on its own, before acting.

T3 Code never reads the contents of your memory. Only locations and update times
are shared with agents, so anything sensitive stays in the files and under each
agent's own permissions.

## Claude Code auto-memory, detected automatically

If you use Claude Code, its auto-memory folders for a project are shared with
your other harnesses automatically — no setup required. Claude Code keeps a
memory folder for each project it works in, under its config directory (for
example the default Claude config directory on your machine, or the config
directory of a Claude profile you enabled in T3 Code). The folder holds the
memories Claude Code records for that project plus an index that lists them.

T3 Code detects these folders for each project on its own:

- Detection is **on by default**. You can switch it off for a project, or
  exclude an individual folder, on the project's settings page.
- Each Claude profile or config directory you use is detected separately, so
  memories from several Claude setups can be shared at once.
- Detection never changes how Claude Code writes its memory — it only finds
  folders that already exist.

## Adding sources yourself

For any harness whose memory T3 Code does not detect on its own, add a source
for the project: a file or folder that harness keeps memory in, for example a
memory file inside the project or in that harness's own area. Each source is
tied to one project. You can add, disable, or remove sources at any time.

## Where the settings live

On the web app, open a project's settings and go to its **Memory** section. The
section is scoped to the checkout you have selected, and shows:

- the Claude auto-memory folders detected for that project, each with a switch
  to include or exclude it, plus a master switch for automatic detection;
- the sources you added for that project yourself.

Memory settings are per environment (the machine running T3 Code), matching the
fact that memory lives on that machine.

## Mobile

The mobile app does not include memory management in this release — there is no
mobile screen for editing memory settings. Mobile threads still benefit from
memory sharing: sharing happens on the server, so whatever sources are
configured for a project apply to threads you run from your phone too.

## What T3 Code does not do

T3 Code does not manage machine-wide memory. Each harness keeps handling its own
personal, cross-project memory — for example a memory file in your home
directory that the harness reads for every conversation. T3 Code only shares the
per-project memory that different harnesses would otherwise lose track of.
