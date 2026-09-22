// Redact known environment credentials before data crosses persistence/network boundaries.
// No secret values or environment variable listings are emitted.
export function redact(text: string): string {
  let safe = text;

  for (const [name, value] of Object.entries(process.env)) {
    if (
      value &&
      value.length >= 8 &&
      /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)
    )
      safe = safe.split(value).join("[REDACTED]");
  }

  return safe
    .replace(/\bBearer\s+[\w.\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g,
      "[REDACTED]",
    );
}

export function sanitize<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}
