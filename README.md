# ts-hardlink-deduplication

Finds identical regular files across a directory tree and replaces the duplicates with hardlinks to a single canonical copy.

```js
import { scan, deduplicate, formatReport } from 'ts-hardlink-deduplication';

const groups = await scan('/path/to/tree', { minSize: 1 });
console.log(formatReport(groups));

const result = await deduplicate(groups);
console.log(`Linked ${result.linked} files, saved ${result.savedBytes} bytes`);
```

## Why this exists

Backup trees, build caches, and photo libraries accumulate byte-identical copies of the same file. On a filesystem that supports hardlinks, those copies can share one inode, so the data is stored once and every path still opens the same content. This library performs that deduplication conservatively: it only considers regular files, groups them by exact SHA-256 content hash, and never touches files whose contents differ.

The trade-off is that deduplication is destructive to the path-to-inode mapping. After `deduplicate` runs, unlinking one path does not free space until every hardlink to that inode is removed, and tools that assume each path has its own inode (some backup or synchronization tools) may behave differently. The library keeps the first file in each group as the canonical copy and rewrites the rest, so the set of paths and their contents is unchanged; only the underlying inodes are shared.

## Edge cases

Symlinks and directories are skipped. Files smaller than `minSize` (default `1` byte) are ignored, which lets you skip empty files that are cheap to store and often not worth linking. If a file disappears between scanning and deduplication, `deduplicate` records an error for that path and continues with the rest of the group rather than aborting the whole run.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

