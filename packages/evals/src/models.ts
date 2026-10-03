// Model names on the command line and in responses.

/** `provider/id`, or a bare id for Anthropic. */
export function splitModel(model: string): { provider: string; id: string } {
  const slash = model.indexOf("/");
  return slash === -1
    ? { provider: "anthropic", id: model }
    : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** Served model must be the requested one, allowing a dated snapshot suffix
 *  (`-20251001` or `-2025-10-01`). */
export function servedModelOk(requested: string, served: string): boolean {
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(-\\d{8}|-\\d{4}-\\d{2}-\\d{2})?$`).test(served);
}
