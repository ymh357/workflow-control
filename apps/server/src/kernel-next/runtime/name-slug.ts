// P6-5 / P6-6: pipeline name slugification.
//
// Pipelines carry a human-readable `name` (e.g. "Pipeline Generator",
// "PR Description Generator") inside their IR. HTTP callers want to
// invoke them by a URL-safe slug instead of the verbatim display name,
// and synthesized taskIds want the same slug form so they don't need
// URL-encoding on every /status / /migrate / /stream hop.
//
// Rules:
//   - Lowercase.
//   - Any run of non-alphanumeric characters collapses to a single '-'.
//   - Leading / trailing '-' trimmed.
//
// Idempotent: slugify(slug) === slug for any already-slug string.

export function slugifyPipelineName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
