/** The message under a field. The field points at `id` through aria-describedby, so a screen reader reads both together. */
export function FieldError({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p id={id} className="error" data-testid="field-error">
      {message}
    </p>
  );
}
