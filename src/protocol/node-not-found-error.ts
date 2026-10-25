// "This device does not know this node/register" - a configuration problem
// that retrying cannot fix, as opposed to a dropped connection. Its own
// module, free of any protocol library, so reading-loop.ts can tell it
// apart without loading node-opcua (see createDataSourceReader's lazy
// imports). OpcuaNodeNotFoundError extends it.
export class NodeNotFoundError extends Error {}
