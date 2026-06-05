import process from 'node:process'

export function isDevLocalhostEnabled(): boolean {
  return process.env.NODE_ENV !== 'production'
}
