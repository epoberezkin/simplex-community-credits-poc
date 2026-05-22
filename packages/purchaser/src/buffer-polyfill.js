// Must be imported FIRST in any entry that transitively pulls circomlibjs.
// circomlibjs → blake-hash references Node's `Buffer` global at module-init
// time, and circomlibjs → assert/util reference Node's `process` global.
import { Buffer } from 'buffer';
import process from 'process';
globalThis.Buffer ||= Buffer;
globalThis.process ||= process;
