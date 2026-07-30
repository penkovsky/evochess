import { RULES_SUMMARY } from "../evochess/tutorial";

/** Shared by the desktop panel and the mobile widget bar, which mount the
    same content in two different containers. */
export function RulesSummary() {
  return (
    <ul>
      {RULES_SUMMARY.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  );
}
