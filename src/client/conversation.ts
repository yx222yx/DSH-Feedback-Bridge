import type { ConversationSnapshot, ISessions } from '@deepseek-ai/dsh-client-runtime/client';

/** Session metadata folded into the diagnostics candidate. */
export interface ConversationMeta {
  title?: string;
  cwd?: string;
  agentPreset?: string;
}

/** One current-conversation read: the session id, its snapshot, and list metadata. */
export interface ConversationRead {
  sessionId: string;
  snapshot: ConversationSnapshot;
  meta: ConversationMeta;
}

/**
 * Observable current-conversation source built from the official
 * `ctx.sessions` face. The session list carries the current selection;
 * `binding(current).session` is the ObservableSnapshot<ConversationSnapshot>
 * the runtime exposes to feature packages. Subscribing to the list covers
 * selection changes and the transient window where a binding is not yet
 * resolved, so consumers simply re-read on every notification.
 */
export interface ConversationSource {
  subscribe(fn: () => void): () => void;
  getSnapshot(): ConversationRead | undefined;
  getServerSnapshot(): ConversationRead | undefined;
}

/**
 * Build the conversation source over `ctx.sessions`. Reads resolve to
 * undefined while no session is current or its binding is not yet scoped;
 * the UI renders the no-session state instead of guessing.
 *
 * @param sessions - the `ctx.sessions` service face.
 * @returns the observable source.
 */
export function createConversationSource(sessions: ISessions): ConversationSource {
  function read(): ConversationRead | undefined {
    const list = sessions.list.getSnapshot();
    const current = list.current;
    if (current === undefined) return undefined;
    const binding = sessions.binding(current);
    if (binding === undefined) return undefined;
    const summary = list.byId[current];
    return {
      sessionId: current,
      snapshot: binding.session.getSnapshot(),
      meta: {
        title: summary?.title,
        cwd: summary?.cwd,
        agentPreset: summary?.agentPreset,
      },
    };
  }
  return {
    subscribe(fn) {
      return sessions.list.subscribe(fn);
    },
    getSnapshot: read,
    getServerSnapshot: read,
  };
}
