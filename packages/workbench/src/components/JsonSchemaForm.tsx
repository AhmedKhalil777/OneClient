import type { JsonSchemaObject } from "@oneclient/plugin-api";

/**
 * Tier 1's generic form renderer. Deliberately minimal — flat objects,
 * string/number/boolean/enum properties — enough to prove the pipeline.
 * A real form (nested objects, arrays, better widgets) is a Phase 3+
 * follow-up once a real plugin's configSchema needs it.
 */
export function JsonSchemaForm({
  schema,
  value,
  onChange,
  autoFocus,
}: {
  schema: JsonSchemaObject;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Focus (and select) the first field on mount. */
  autoFocus?: boolean;
}) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const focusFirst = (el: HTMLInputElement | null) => {
    if (autoFocus && el && !el.dataset.focused) {
      el.dataset.focused = "1";
      el.focus();
      el.select();
    }
  };

  return (
    <>
      {Object.entries(properties).map(([key, prop], index) => {
        const inputRef = index === 0 ? focusFirst : undefined;
        const isSecret = prop["x-secret"] === true;
        const inputType = isSecret ? "password" : prop.type === "number" || prop.type === "integer" ? "number" : "text";

        if (prop.type === "boolean") {
          return (
            <div className="form-field form-field-checkbox" key={key}>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(value[key] ?? prop.default)}
                  onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
                />
                {prop.title ?? key}
              </label>
              {prop.description && <div className="form-help">{prop.description}</div>}
            </div>
          );
        }

        return (
          <div className="form-field" key={key}>
            <label htmlFor={`field-${key}`}>
              {prop.title ?? key}
              {required.has(key) ? " *" : ""}
            </label>
            {prop.enum ? (
              <select
                id={`field-${key}`}
                value={(value[key] as string) ?? (prop.default as string) ?? ""}
                onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              >
                <option value="" disabled>
                  Select…
                </option>
                {prop.enum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            ) : prop.format === "file" ? (
              <div className="input-with-button">
                <input
                  ref={inputRef}
                  id={`field-${key}`}
                  value={(value[key] as string) ?? (prop.default as string) ?? ""}
                  onChange={(e) => onChange({ ...value, [key]: e.target.value })}
                  placeholder="Choose a file…"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const picked = await window.oneclient.pickFile({ ...(value[key] ? { defaultPath: String(value[key]) } : {}), ...(prop["x-file-extensions"] ? { extensions: prop["x-file-extensions"] } : {}) });
                    if (picked) onChange({ ...value, [key]: picked });
                  }}
                >
                  Browse…
                </button>
              </div>
            ) : prop.format === "directory" ? (
              <div className="input-with-button">
                <input
                  ref={inputRef}
                  id={`field-${key}`}
                  value={(value[key] as string) ?? (prop.default as string) ?? ""}
                  onChange={(e) => onChange({ ...value, [key]: e.target.value })}
                  placeholder="Choose a folder…"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const picked = await window.oneclient.pickDirectory((value[key] as string) || undefined);
                    if (picked) onChange({ ...value, [key]: picked });
                  }}
                >
                  Browse…
                </button>
              </div>
            ) : (
              <input
                ref={inputRef}
                id={`field-${key}`}
                type={inputType}
                value={(value[key] as string | number) ?? (prop.default as string | number) ?? ""}
                placeholder={prop.examples?.[0] !== undefined ? String(prop.examples[0]) : undefined}
                onChange={(e) =>
                  onChange({
                    ...value,
                    [key]:
                      inputType === "number"
                        ? e.target.value === ""
                          ? undefined
                          : Number(e.target.value)
                        : e.target.value,
                  })
                }
              />
            )}
            {prop.description && <div className="form-help">{prop.description}</div>}
          </div>
        );
      })}
    </>
  );
}
