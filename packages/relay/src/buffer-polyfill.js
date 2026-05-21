// Must be imported FIRST in any entry that transitively pulls circomlibjs
// (blake-hash references Node's Buffer global at module-init time).
import { Buffer } from 'buffer';
globalThis.Buffer ||= Buffer;
