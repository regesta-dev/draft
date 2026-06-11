export function normalizeRegistryUrl(registry: string): string {
  return registry.replace(/\/+$/u, '')
}
