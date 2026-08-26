/**
 * block streaming yields bounded chunks and lets the consumer control backpressure.
 */
export async function* blockstream(input, options = {}) {
  const blockbytes = options.blockbytes;
  if (!Number.isInteger(blockbytes) || blockbytes < 1) throw new TypeError("blockbytes must be a positive integer");
  let index = 0;
  let offset = 0;
  let pending = new Uint8Array(0);
  for await (const part of input instanceof Uint8Array ? [input] : input) {
    const data = part instanceof Uint8Array ? part : new TextEncoder().encode(String(part));
    pending = concat(pending, data);
    while (pending.byteLength > blockbytes) { const block = pending.slice(0, blockbytes); pending = pending.slice(blockbytes); yield { index, offset, data: block, final: false }; index += 1; offset += block.byteLength; }
  }
  if (pending.byteLength) yield { index, offset, data: pending, final: true };
}

function concat(left, right) { const output = new Uint8Array(left.byteLength + right.byteLength); output.set(left); output.set(right, left.byteLength); return output; }
