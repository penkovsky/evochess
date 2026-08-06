import { useState } from "react";

/**
 * The link that is the match. Shown the moment one is created, and reachable
 * again from the waiting status line, since closing it must not lose the only
 * copy of the URL.
 */
export function InviteModal({
  url,
  joined,
  close,
}: {
  url: string;
  /** Someone took the other seat, so the invite has done its job. */
  joined: boolean;
  close: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard: the field is selectable, and the note says so.
      setCopied(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Invite" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <p>{joined ? "Your opponent has joined" : "Share the link"}</p>
          <button className="modal-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <p className="share-note">
          {joined
            ? "The link still works for spectators."
            : "Whoever opens it first plays"}
        </p>
        <section className="share-section">
          <input
            type="text"
            className="share-url"
            readOnly
            value={url}
            onClick={(e) => {
              e.currentTarget.select();
              void copy();
            }}
          />
          <div className="share-status" aria-live="polite">
            {copied ? "Copied!" : ""}
          </div>
          <button onClick={() => void copy()}>Copy link</button>
          {typeof navigator !== "undefined" && !!navigator.share && (
            <button onClick={() => void navigator.share({ url }).catch(() => {})}>Share link…</button>
          )}
        </section>
        <button onClick={close}>Close</button>
      </div>
    </div>
  );
}
