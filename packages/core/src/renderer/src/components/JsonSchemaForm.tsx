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
}: {
  schema: JsonSchemaObject;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  return (
    <>
      {Object.entries(properties).map(([key, prop]) => {
        const isSecret = prop["x-secret"] === true;
        const inputType = isSecret ? "password" : prop.type === "number" || prop.type === "integer" ? "number" : "text";

        return (
          <div className="form-field" key={key}>
            <label htmlFor={`field-${key}`}>
              {prop.title ?? key}
              {required.has(key) ? " *" : ""}
            </label>
            {prop.enum ? (
              <select
                id={`field-${key}`}
                value={(value[key] as string) ?? ""}
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
            ) : (
              <input
                id={`field-${key}`}
                type={inputType}
                value={(value[key] as string | number) ?? (prop.default as string | number) ?? ""}
                onChange={(e) =>
                  onChange({
                    ...value,
                    [key]: inputType === "number" ? Number(e.target.value) : e.target.value,
                  })
                }
              />
            )}
          </div>
        );
      })}
    </>
  );
}
