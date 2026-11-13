// Records every call the module makes into its wasm, so a test can check their order.
// The module reaches the stack only through the exports of the instance WebAssembly.instantiate
// gives it, so wrapping that one function sees everything.

/**
 * Runs `create`, which makes factories, and answers what it returned beside the calls of every
 * instance made meanwhile: { instance, name, result, args }, in order, for as long as they live.
 * A call that hands the stack a description also has `sdp`, the text as the stack was given it.
 */
const decoder = new TextDecoder()

export async function traced(create) {
  const calls = []
  const instantiate = WebAssembly.instantiate
  let instances = 0
  WebAssembly.instantiate = async (...args) => {
    const made = await instantiate(...args)
    const instance = instances++
    const exports = {}
    for (const [name, value] of Object.entries(made.exports)) {
      exports[name] =
        typeof value !== 'function'
          ? value
          : (...params) => {
              const call = { instance, name, args: params }
              // read before the call: the stack may reuse the memory
              if (name.startsWith('rtc_accept_')) call.sdp = decoder.decode(new Uint8Array(made.exports.memory.buffer, params[1], params[2]))
              call.result = value(...params)
              calls.push(call)
              return call.result
            }
    }
    return { exports }
  }
  try {
    return { calls, result: await create() }
  } finally {
    WebAssembly.instantiate = instantiate
  }
}

// what asks nothing of a connection: memory, its making and unmaking, and the reads
const READERS = new Set(['_initialize', 'rtc_alloc', 'rtc_free', 'rtc_new', 'rtc_delete', 'rtc_accepts', 'rtc_buffered', 'rtc_out_ptr', 'rtc_out_len', 'rtc_arg', 'rtc_port'])

/** The calls that str0m counts as a change to a connection, each as { connection, name, result, drained }. */
export function operations(calls) {
  const list = []
  const last = new Map()
  for (const { instance, name, result, args } of calls) {
    if (READERS.has(name)) continue
    const connection = `${instance}:${args[0]}`
    if (name === 'rtc_poll') {
      const operation = last.get(connection)
      if (operation) operation.drained = result === 0
      continue
    }
    const operation = { connection, name, result, drained: false }
    list.push(operation)
    last.set(connection, operation)
  }
  return list
}
