// Password confirmation field: live match feedback — faithful absorption of
// the register.html confirm field and register.js paintconfirm().
type PasswordConfirmProps = {
  password: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
};

/**
 * the confirmation field: blank stays neutral (the hint keeps its
 * reserved height with a non-breaking space), a typed value flips the
 * hint to match / no-match.
 */
export default function PasswordConfirm({ password, value, invalid, onChange }: PasswordConfirmProps) {
  const empty = value.length === 0;
  const match = password === value;
  const hintclass = empty ? "auth-hint" : match ? "auth-hint ok" : "auth-hint bad";
  const hinttext = empty ? "\u00a0" : match ? "passwords match." : "passwords do not match.";
  return (
    <div className="auth-field">
      <label htmlFor="password2">confirm password</label>
      <input
        className="auth-input"
        id="password2"
        name="password2"
        type="password"
        autoComplete="new-password"
        required
        aria-invalid={invalid ? "true" : undefined}
        aria-describedby="password2hint"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={hintclass} id="password2hint">
        {hinttext}
      </p>
    </div>
  );
}
