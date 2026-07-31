import { RULES_SUMMARY } from "../evochess/tutorial";

/** Shared by the desktop panel and the mobile widget bar, which mount the
    same content in two different containers. */
export function RulesSummary() {
  return (
    <>
      <ul>
        {RULES_SUMMARY.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
      {/* A sibling of the list, not a bullet: it is not a game rule. */}
      <p className="privacy-note">
        Games are logged anonymously to see how the game is played.
        No account, no name, no email.
      </p>
    </>
  );
}
