// Compiled by tests/torrent-details.test.mjs, never run: the details calls against the declarations as built.
import type { Session } from '../../build/index'

export const add = (session: Session, handle: number) => {
  session.addTrackers(handle, ['udp://tracker.example.invalid:1337/announce'])
  // @ts-expect-error a string is iterable, and would be taken a character at a time
  session.addTrackers(handle, 'udp://tracker.example.invalid:1337/announce')
}
