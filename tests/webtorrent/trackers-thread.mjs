// trackersOf in a thread of its own: one answer per input, in the order they were given.

import { parentPort, workerData } from 'node:worker_threads'

import { trackersOf } from '../../build/webtorrent/index.js'

for (const bytes of workerData) parentPort.postMessage(trackersOf(bytes))
