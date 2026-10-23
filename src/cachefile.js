// A saved kernel cache (see exportBrepCache in backend-brep.js) as one gzip file: JSON, compressed in the browser's own stream (also in Node).
export async function packCache(data) {
  const stream = new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function unpackCache(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
