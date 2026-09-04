# Shared agent memory

Different agent harnesses keep their own persistent memory files. When you switch
harnesses in T3 Code, knowledge you gave one agent — how to reach the production
database, conventions you care about — is normally invisible to the others.

T3 Code fixes this by telling every agent where the other harnesses' memory lives.

## How it works

Add each harness's memory file as a memory source in
**Settings → Memory sources**. At the start of every thread, T3 Code shows the
agent a short list of those files and when they were last updated. The agent reads
the files it needs, on its own, before acting.

T3 Code never reads the contents of your memory files itself. Only file paths and
update times are shared with agents, so anything sensitive stays in the files and
under each agent's own permissions.

## Managing sources

In **Settings → Memory sources** you can add, edit, disable, or remove sources.
Entries are either **global** (an absolute path, available to every project on this
machine) or **project** (a path relative to the project's folder).
