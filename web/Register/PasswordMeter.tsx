// Password strength meter: four segments, score 0-4 from length gates and
// character classes — faithful absorption of the register.html meter and
// register.js strength()/paintmeter().
/** human labels for the strength scores 0-4. */
export const strengthnames = ["-", "weak", "fair", "good", "strong"];

/**
 * strength score 0-4: length gates, character classes add.
 *
 * @param password the typed password.
 * @returns the score between 0 (empty) and 4 (strong).
 */
export function passwordstrength(password: string): number {
  if (password.length === 0) return 0;
  if (password.length < 8) return 1;
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
  if (password.length >= 12 && classes >= 3) return 4;
  if (classes >= 3 || (password.length >= 11 && classes >= 2)) return 3;
  if (classes === 2 || password.length >= 10) return 2;
  return 1;
}

/** number of distinct character classes present in the password. */
export function classcount(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
  return classes;
}

type PasswordMeterProps = {
  password: string;
};

/**
 * the live password surface: the four-segment meter (aria-hidden
 * decoration), the polite strength label, the minimum-length hint and
 * the two password rule rows.
 */
export default function PasswordMeter({ password }: PasswordMeterProps) {
  const score = passwordstrength(password);
  const lengthok = password.length >= 8;
  const classesok = classcount(password) >= 2;
  return (
    <>
      <div aria-hidden="true" className="auth-meter">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={index < score ? `on-${score}` : undefined} />
        ))}
      </div>
      <p className="auth-meterlabel" role="status" aria-live="polite">
        strength: {strengthnames[score]}
      </p>
      <p className="auth-hint" id="passwordhint">
        minimum 8 characters
      </p>
      <ul className="auth-rules" id="passwordrules">
        <li className={lengthok ? "ok" : undefined}>at least 8 characters</li>
        <li className={classesok ? "ok" : undefined}>
          mix character classes (lower, upper, digit, symbol)
        </li>
      </ul>
    </>
  );
}
