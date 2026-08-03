import type { ForcedPromo, MinorPromo, ApplyMoveOptions } from "../evochess/game";
import { PIECE_GLYPH } from "../pieceGlyph";
import type { PromoModalState } from "../appTypes";

export function PromoModal({
  modal,
  finishModalMove,
}: {
  modal: PromoModalState;
  finishModalMove: (options: ApplyMoveOptions) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        {modal.kind === "downgrade" ? (
          <>
            <p>Rook charges exhausted — it must downgrade:</p>
            <button onClick={() => finishModalMove({ downgradeTo: "n" as MinorPromo })}>
              Downgrade to Knight
            </button>
            <button onClick={() => finishModalMove({ downgradeTo: "b" as MinorPromo })}>
              Downgrade to Bishop
            </button>
          </>
        ) : modal.kind === "forced" ? (
          <>
            <p>Pawn reaches the last rank — choose promotion:</p>
            <div className="promo-icons">
              {(["q", "r", "b", "n"] as ForcedPromo[]).map((p) => (
                <button
                  key={p}
                  className="promo-icon"
                  title={p.toUpperCase()}
                  onClick={() => finishModalMove({ forcedPromo: p })}
                >
                  {PIECE_GLYPH[modal.color][p]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="modal-header">
              <p>Promote (optional)</p>
              <button
                className="modal-close"
                aria-label="Close (no promotion)"
                onClick={() => finishModalMove({})}
              >
                ×
              </button>
            </div>
            <div className="promo-icons">
              {modal.canMinor && (
                <button
                  className="promo-icon"
                  title="Promote moved pawn → Knight"
                  onClick={() => finishModalMove({ minorPromo: "n" as MinorPromo })}
                >
                  {PIECE_GLYPH[modal.color].n}
                </button>
              )}
              {modal.canMinor && (
                <button
                  className="promo-icon"
                  title="Promote moved pawn → Bishop"
                  onClick={() => finishModalMove({ minorPromo: "b" as MinorPromo })}
                >
                  {PIECE_GLYPH[modal.color].b}
                </button>
              )}
              {modal.canRook && (
                <button
                  className="promo-icon"
                  title="Promote moved minor piece → Rook"
                  onClick={() => finishModalMove({ rookPromo: true })}
                >
                  {PIECE_GLYPH[modal.color].r}
                </button>
              )}
              <button className="promo-icon promo-none" title="No promotion" onClick={() => finishModalMove({})}>
                Skip
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
