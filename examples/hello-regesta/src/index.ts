import { createDebug } from 'obug'

const debug = createDebug('hello-regesta')

export function helloRegesta(): string {
  debug('helloRegesta called')
  return 'hello from regesta'
}
