// Username rules checklist: 3-32 characters of [a-z0-9.-], auto-lowercased
// while typing — faithful absorption of the register.html checklist and
// register.js paintusername().
/** the username charset contract: 3-32 of lowercase a-z, 0-9, dot, dash. */
export const usernamere = /^[a-z0-9.-]{3,32}$/;

type UsernameRulesProps = {
  value: string;
};

/**
 * the live username checklist: each row flips to ok as the typed value
 * satisfies the length and the charset rules.
 */
export default function UsernameRules({ value }: UsernameRulesProps) {
  const lengthok = value.length >= 3 && value.length <= 32;
  const charsetok = usernamere.test(value);
  return (
    <ul className="auth-rules" id="usernamerules">
      <li className={lengthok ? "ok" : undefined}>3 to 32 characters</li>
      <li className={charsetok ? "ok" : undefined}>only a-z, 0-9, dot and dash</li>
    </ul>
  );
}
