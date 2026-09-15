// @ts-check
// root.mjs — the one key under which the workspace root itself appears in the policy table.
//
// A workspace root is the directory holding `_handoffs/` and the repos. It is usually not a git
// repository, and lanes can still target it (a brief that edits the bridge's own furniture, say).
// Every module that needs to ask "is this card for the root?" asks with this constant, and
// POLICY.md's repos table keys its root row on the same word, so no path-like spelling of any
// particular machine's root is compiled into the code.
export const ROOT_KEY = 'root';

/** The human-facing label the brief parser emits for a root target. `alloc` maps it to ROOT_KEY. */
export const ROOT_LABEL = '(workspace root)';
